import {
  categoryOf,
  extensionOf,
  type FileExtent,
  type RecoveredFile,
  type RecoveryQuality,
} from '@shared/types/scan'
import { AppError, ErrorCode } from '@shared/utils/errors'
import type { BlockReader } from '../../disk/block-device'
import type { ScanBatch, ScanOptions } from '../scan-types'
import {
  FIRST_USER_RECORD,
  ROOT_DIRECTORY_RECORD,
  parseFileRecord,
  parseNtfsBootSector,
  preferredFileName,
  type DataRun,
  type NtfsGeometry,
  type NtfsRecord,
} from './ntfs'

/**
 * NTFS metadata scan.
 *
 * The Master File Table holds one record per file, and a deleted file's record
 * survives until NTFS reuses that slot — complete with its name, timestamps and
 * the cluster runs pointing at its contents. Reading the MFT is therefore both
 * the fastest and the most accurate way to recover from an NTFS volume, and it
 * is what separates a "quick scan" from carving.
 *
 * Two passes are made over the table. The first collects directory records into
 * a map; the second emits files with resolved paths. A single pass cannot work,
 * because a file's parent directory routinely occupies a *later* record than
 * the file itself, and buffering every file until the end would mean holding
 * millions of records in memory.
 */

/** Records read per I/O operation. 64 KiB at the usual 1 KiB record size. */
const RECORDS_PER_READ = 64

/** Results emitted per batch. Bounded so the UI updates steadily. */
const FILES_PER_BATCH = 512

/**
 * Cap on the cluster-allocation bitmap held in memory.
 *
 * At one bit per cluster this covers a 500 TB volume with 4 KiB clusters. Past
 * it the overwrite check is skipped rather than exhausting memory — quality is
 * reported as `unknown` instead of guessed.
 */
const MAX_BITMAP_BYTES = 64 * 1024 * 1024

/**
 * Scan an NTFS volume.
 *
 * `reader` must be positioned at the start of the volume; `volumeOffsetBytes`
 * is where that volume begins on the device, so emitted extents are
 * device-absolute and the recovery pipeline never has to rebase them.
 */
export async function* scanNtfsVolume(
  reader: BlockReader,
  sessionId: string,
  volumeOffsetBytes: number,
  options: ScanOptions,
): AsyncGenerator<ScanBatch> {
  const bootSector = await reader.read(0, 512)
  const geometry = parseNtfsBootSector(bootSector)

  if (geometry === null) {
    throw new AppError(ErrorCode.Unsupported, 'This volume is not readable as NTFS', {
      retryable: false,
    })
  }

  const mft = await locateMft(reader, geometry)
  const totalRecords = Math.min(
    Math.floor(mft.sizeBytes / geometry.fileRecordSizeBytes),
    options.maxUnits ?? Number.MAX_SAFE_INTEGER,
  )

  if (totalRecords === 0) {
    throw new AppError(ErrorCode.Io, 'The Master File Table could not be located', {
      retryable: false,
    })
  }

  const directories = await collectDirectories(reader, geometry, mft, totalRecords)
  const bitmap = await loadAllocationBitmap(reader, geometry, mft)

  let emitted: RecoveredFile[] = []
  let processed = 0

  for await (const record of readRecords(reader, geometry, mft, totalRecords)) {
    processed += 1

    const file = toRecoveredFile({
      record,
      geometry,
      directories,
      bitmap,
      sessionId,
      volumeOffsetBytes,
    })

    if (file !== null && (options.includeExisting || file.isDeleted)) {
      emitted.push(file)
    }

    if (emitted.length >= FILES_PER_BATCH) {
      yield { files: emitted, processed, total: totalRecords }
      emitted = []
    }
  }

  // The final partial batch, plus a terminal progress report even when empty.
  yield { files: emitted, processed, total: totalRecords }
}

// --- MFT location ----------------------------------------------------------

interface MftLocation {
  /** Extents of $MFT itself, in volume-relative bytes. */
  readonly extents: readonly FileExtent[]
  readonly sizeBytes: number
}

/**
 * Find $MFT.
 *
 * The boot sector gives its first cluster, but $MFT is frequently fragmented on
 * a full volume — so its own record (number 0) is read first, and *its* runlist
 * is what actually describes the table. Assuming contiguity here would truncate
 * the scan at the first fragment boundary and silently lose every file beyond.
 */
async function locateMft(reader: BlockReader, geometry: NtfsGeometry): Promise<MftLocation> {
  const firstRecordOffset = geometry.mftClusterNumber * geometry.clusterSizeBytes

  const raw = await reader.read(firstRecordOffset, geometry.fileRecordSizeBytes)
  const record = parseFileRecord(raw, geometry.bytesPerSector, 0)

  if (record !== null && record.dataRuns.length > 0) {
    const extents = runsToExtents(record.dataRuns, geometry)
    const sizeBytes = extents.reduce((total, extent) => total + extent.lengthBytes, 0)

    if (sizeBytes >= geometry.fileRecordSizeBytes) return { extents, sizeBytes }
  }

  // $MFT's own record is unreadable. Fall back to treating the table as
  // contiguous from its stated start: an incomplete scan beats none at all,
  // and this is exactly the state a damaged volume is in.
  const remaining = Math.max(0, reader.sizeBytes - firstRecordOffset)

  return {
    extents: [{ offsetBytes: firstRecordOffset, lengthBytes: remaining }],
    sizeBytes: remaining,
  }
}

/** Convert cluster runs into byte extents, dropping sparse regions. */
function runsToExtents(runs: readonly DataRun[], geometry: NtfsGeometry): FileExtent[] {
  return runs
    .filter((run) => !run.isSparse && run.startLcn >= 0)
    .map((run) => ({
      offsetBytes: run.startLcn * geometry.clusterSizeBytes,
      lengthBytes: run.clusterCount * geometry.clusterSizeBytes,
    }))
}

/** Byte offset of an MFT record, walking the table's own extents. */
function recordOffset(
  mft: MftLocation,
  recordSizeBytes: number,
  recordNumber: number,
): number | null {
  let consumed = 0
  const target = recordNumber * recordSizeBytes

  for (const extent of mft.extents) {
    if (target < consumed + extent.lengthBytes) {
      return extent.offsetBytes + (target - consumed)
    }
    consumed += extent.lengthBytes
  }

  return null
}

// --- Record iteration ------------------------------------------------------

/**
 * Read MFT records in order.
 *
 * Reads are batched because a per-record read on a 200 MB table is millions of
 * round trips. Unparseable records are skipped silently: an MFT always contains
 * never-used slots, and reporting each as an error would bury the real ones.
 */
async function* readRecords(
  reader: BlockReader,
  geometry: NtfsGeometry,
  mft: MftLocation,
  totalRecords: number,
): AsyncGenerator<NtfsRecord> {
  const recordSize = geometry.fileRecordSizeBytes

  for (let start = 0; start < totalRecords; start += RECORDS_PER_READ) {
    const count = Math.min(RECORDS_PER_READ, totalRecords - start)
    const offset = recordOffset(mft, recordSize, start)
    if (offset === null) break

    let block: Buffer
    try {
      block = await reader.read(offset, count * recordSize)
    } catch {
      // A bad sector inside the MFT costs this batch, not the whole scan.
      continue
    }

    for (let index = 0; index < count; index += 1) {
      const from = index * recordSize
      if (from + recordSize > block.length) break

      // `parseFileRecord` rewrites its buffer during the fixup pass, so each
      // record gets its own copy rather than a view into the shared block.
      const record = parseFileRecord(
        Buffer.from(block.subarray(from, from + recordSize)),
        geometry.bytesPerSector,
        start + index,
      )

      if (record !== null) yield record
    }
  }
}

// --- Path reconstruction ---------------------------------------------------

interface DirectoryEntry {
  readonly name: string
  readonly parentRecordNumber: number
}

/**
 * First pass: map every directory record to its name and parent.
 *
 * Directories are a small fraction of an MFT, so this map stays modest even on
 * a volume with millions of files.
 */
async function collectDirectories(
  reader: BlockReader,
  geometry: NtfsGeometry,
  mft: MftLocation,
  totalRecords: number,
): Promise<Map<number, DirectoryEntry>> {
  const directories = new Map<number, DirectoryEntry>()

  for await (const record of readRecords(reader, geometry, mft, totalRecords)) {
    if (!record.isDirectory) continue

    const name = preferredFileName(record.names)
    if (name === null) continue

    directories.set(record.recordNumber, {
      name: name.name,
      parentRecordNumber: name.parentRecordNumber,
    })
  }

  return directories
}

/**
 * Walk the parent chain to build a path.
 *
 * Cycle-guarded and depth-limited: a damaged MFT can contain a directory that
 * is its own ancestor, and an unguarded walk would hang the scan.
 */
function resolvePath(
  directories: ReadonlyMap<number, DirectoryEntry>,
  parentRecordNumber: number,
): string {
  const segments: string[] = []
  const seen = new Set<number>()

  let current = parentRecordNumber

  for (let depth = 0; depth < 64; depth += 1) {
    if (current === ROOT_DIRECTORY_RECORD || seen.has(current)) break
    seen.add(current)

    const entry = directories.get(current)
    if (entry === undefined) {
      // The parent's record has been reused. The file is still recoverable;
      // its location simply cannot be reconstructed.
      segments.unshift('?')
      break
    }

    segments.unshift(entry.name)
    current = entry.parentRecordNumber
  }

  return segments.join('\\')
}

// --- Cluster allocation ----------------------------------------------------

/**
 * Load $Bitmap — one bit per cluster, set when the cluster is in use.
 *
 * This is what makes the recovery-quality column meaningful rather than
 * decorative. A deleted file whose clusters are still free is almost certainly
 * intact; one whose clusters have been reallocated has been partly or wholly
 * overwritten, and telling the user that *before* they spend an hour restoring
 * is the difference between a useful product and a frustrating one.
 */
async function loadAllocationBitmap(
  reader: BlockReader,
  geometry: NtfsGeometry,
  mft: MftLocation,
): Promise<Buffer | null> {
  const BITMAP_RECORD = 6

  const offset = recordOffset(mft, geometry.fileRecordSizeBytes, BITMAP_RECORD)
  if (offset === null) return null

  try {
    const raw = await reader.read(offset, geometry.fileRecordSizeBytes)
    const record = parseFileRecord(raw, geometry.bytesPerSector, BITMAP_RECORD)

    if (record === null || record.dataRuns.length === 0) return null
    if (record.dataSizeBytes > MAX_BITMAP_BYTES) return null

    const chunks: Buffer[] = []
    let remaining = record.dataSizeBytes

    for (const extent of runsToExtents(record.dataRuns, geometry)) {
      if (remaining <= 0) break
      const length = Math.min(extent.lengthBytes, remaining)
      chunks.push(await reader.read(extent.offsetBytes, length))
      remaining -= length
    }

    return chunks.length > 0 ? Buffer.concat(chunks) : null
  } catch {
    // The bitmap is an optimisation, not a requirement.
    return null
  }
}

/** `true` when every cluster of the runs is still marked free. */
function clustersStillFree(bitmap: Buffer, runs: readonly DataRun[]): boolean | null {
  if (runs.length === 0) return null

  for (const run of runs) {
    if (run.isSparse || run.startLcn < 0) continue

    for (let index = 0; index < run.clusterCount; index += 1) {
      const cluster = run.startLcn + index
      const byte = cluster >> 3

      // Past the end of the bitmap: the run points outside the volume, which
      // means the runlist is damaged.
      if (byte >= bitmap.length) return null

      if (((bitmap[byte] ?? 0) >> (cluster & 7)) & 1) return false
    }
  }

  return true
}

// --- Record to result ------------------------------------------------------

interface ConversionContext {
  readonly record: NtfsRecord
  readonly geometry: NtfsGeometry
  readonly directories: ReadonlyMap<number, DirectoryEntry>
  readonly bitmap: Buffer | null
  readonly sessionId: string
  readonly volumeOffsetBytes: number
}

function toRecoveredFile(context: ConversionContext): RecoveredFile | null {
  const { record, geometry, directories, bitmap, sessionId, volumeOffsetBytes } = context

  // Metadata files ($MFT, $LogFile, $Bitmap…) are not user data.
  if (record.recordNumber < FIRST_USER_RECORD) return null
  // Extension records carry no name of their own; their base record does.
  if (record.baseRecordNumber !== 0) return null

  const name = preferredFileName(record.names)
  if (name === null || name.name.length === 0) return null

  const extents = runsToExtents(record.dataRuns, geometry).map((extent) => ({
    offsetBytes: extent.offsetBytes + volumeOffsetBytes,
    lengthBytes: extent.lengthBytes,
  }))

  const isDeleted = !record.inUse
  const stillFree = bitmap !== null && isDeleted ? clustersStillFree(bitmap, record.dataRuns) : null

  // The $FILE_NAME copy of the size is stale on an actively written file, so
  // $DATA wins when present. Quality is judged against this same number: a
  // record claiming 50 KB with no runs has lost its contents, while one
  // claiming zero simply has none.
  const sizeBytes = record.dataSizeBytes > 0 ? record.dataSizeBytes : name.realSizeBytes

  return {
    id: `${sessionId}:ntfs:${record.recordNumber}`,
    sessionId,
    name: name.name,
    path: resolvePath(directories, name.parentRecordNumber),
    extension: extensionOf(name.name),
    category: categoryOf(name.name),
    sizeBytes,
    isDeleted,
    isDirectory: record.isDirectory,
    createdAt: record.timestamps.createdAt,
    modifiedAt: record.timestamps.modifiedAt,
    accessedAt: record.timestamps.accessedAt,
    quality: assessQuality(record, stillFree, sizeBytes),
    source: record.residentData !== null ? 'ntfs-resident' : 'ntfs-mft',
    extents,
    hasResidentData: record.residentData !== null,
    isFragmented: record.dataRuns.length > 1,
    isCompressed: record.isCompressed,
    isEncrypted: record.isEncrypted,
  }
}

/**
 * Score how likely this file is to come back intact.
 *
 * Every branch is grounded in evidence from the volume — never in a heuristic
 * about file type or age. Overstating quality is the worst failure mode a
 * recovery tool has: a user who restores a hundred "excellent" files and finds
 * them corrupt will not trust the tool again.
 */
export function assessQuality(
  record: NtfsRecord,
  clustersStillFree: boolean | null,
  effectiveSizeBytes: number,
): RecoveryQuality {
  // Encrypted content is unreadable without the user's key, whatever state the
  // clusters are in.
  if (record.isEncrypted) return 'poor'

  // A file living inside its own MFT record needs no clusters at all, so it is
  // recoverable byte-for-byte as long as the record parsed.
  if (record.residentData !== null) return record.isDamaged ? 'fair' : 'excellent'

  if (record.isDirectory) return record.isDamaged ? 'fair' : 'good'

  // No runs and no resident data: the metadata survived but the pointer to the
  // contents did not.
  if (record.dataRuns.length === 0) return effectiveSizeBytes === 0 ? 'good' : 'poor'

  if (!record.inUse) {
    // The decisive signal for a deleted file.
    if (clustersStillFree === false) return 'poor'
    if (clustersStillFree === null) return record.isDamaged ? 'poor' : 'fair'

    if (record.isDamaged) return 'fair'
    // Compression means the data must be reassembled through the compression
    // unit layout, which is more fragile than a straight copy.
    return record.isCompressed ? 'good' : 'excellent'
  }

  // An existing file, read directly from live metadata.
  return record.isDamaged ? 'fair' : 'excellent'
}

import {
  categoryOf,
  extensionOf,
  type RecoveredFile,
  type RecoveryQuality,
} from '@shared/types/scan'
import { AppError, ErrorCode } from '@shared/utils/errors'
import type { BlockReader } from '../../disk/block-device'
import { clustersToExtents, type ScanBatch, type ScanOptions } from '../scan-types'
import {
  EXFAT_ENTRY_SIZE,
  ExfatEntryType,
  exfatClusterToOffset,
  followExfatChain,
  parseExfatBootSector,
  parseExfatDirectory,
  type ExfatDirectoryEntry,
  type ExfatGeometry,
} from './exfat'

/**
 * exFAT metadata scan.
 *
 * exFAT is the format on virtually every SD card and large USB stick, so this is
 * the path a camera or phone recovery takes.
 *
 * It recovers better than FAT for one specific reason: the Stream Extension
 * entry records whether a file was allocated contiguously, and that flag
 * survives deletion. A deleted contiguous file therefore has *exactly known*
 * extents rather than assumed ones — the difference between recovering a 4 GB
 * video correctly and recovering four gigabytes of whatever now sits there.
 */

const FILES_PER_BATCH = 512
const MAX_DIRECTORY_DEPTH = 64
const MAX_FAT_BYTES = 64 * 1024 * 1024
const MAX_BITMAP_BYTES = 64 * 1024 * 1024

interface QueuedDirectory {
  readonly path: string
  readonly depth: number
  readonly firstCluster: number
}

export async function* scanExfatVolume(
  reader: BlockReader,
  sessionId: string,
  volumeOffsetBytes: number,
  options: ScanOptions,
): AsyncGenerator<ScanBatch> {
  const geometry = parseExfatBootSector(await reader.read(0, 512))

  if (geometry === null) {
    throw new AppError(ErrorCode.Unsupported, 'This volume is not readable as exFAT', {
      retryable: false,
    })
  }

  const fat = await loadFat(reader, geometry)
  const bitmap = await loadAllocationBitmap(reader, geometry, fat)

  const queue: QueuedDirectory[] = [
    { path: '', depth: 0, firstCluster: geometry.rootDirectoryCluster },
  ]
  const visited = new Set<number>()

  let emitted: RecoveredFile[] = []
  let processed = 0
  let entryIndex = 0

  while (queue.length > 0) {
    const directory = queue.shift()
    if (directory === undefined) break

    if (options.maxUnits !== undefined && processed >= options.maxUnits) break
    if (visited.has(directory.firstCluster)) continue
    visited.add(directory.firstCluster)

    const buffer = await readDirectory(reader, geometry, fat, directory.firstCluster)
    processed += 1

    if (buffer === null) continue

    for (const entry of parseExfatDirectory(buffer).entries) {
      if (
        entry.isDirectory &&
        directory.depth + 1 < MAX_DIRECTORY_DEPTH &&
        entry.firstCluster >= 2
      ) {
        queue.push({
          path: joinPath(directory.path, entry.name),
          depth: directory.depth + 1,
          firstCluster: entry.firstCluster,
        })
      }

      entryIndex += 1

      const file = toRecoveredFile({
        entry,
        geometry,
        fat,
        bitmap,
        sessionId,
        parentPath: directory.path,
        volumeOffsetBytes,
        entryIndex,
      })

      if (options.includeExisting || file.isDeleted) emitted.push(file)

      if (emitted.length >= FILES_PER_BATCH) {
        yield { files: emitted, processed, total: processed + queue.length }
        emitted = []
      }
    }
  }

  yield { files: emitted, processed, total: processed }
}

// --- Reading ---------------------------------------------------------------

async function loadFat(reader: BlockReader, geometry: ExfatGeometry): Promise<Buffer> {
  const lengthBytes = geometry.fatLengthSectors * geometry.bytesPerSector
  if (lengthBytes <= 0 || lengthBytes > MAX_FAT_BYTES) return Buffer.alloc(0)

  try {
    return await reader.read(geometry.fatOffsetSectors * geometry.bytesPerSector, lengthBytes)
  } catch {
    return Buffer.alloc(0)
  }
}

/**
 * Load the Allocation Bitmap.
 *
 * Unlike NTFS, exFAT stores it as an ordinary file described by a special
 * directory entry in the root. Finding it means reading the root directory
 * twice — cheap, and worth it: this bitmap is what turns the quality column
 * from a guess into evidence.
 */
async function loadAllocationBitmap(
  reader: BlockReader,
  geometry: ExfatGeometry,
  fat: Buffer,
): Promise<Buffer | null> {
  const root = await readDirectory(reader, geometry, fat, geometry.rootDirectoryCluster)
  if (root === null) return null

  for (let offset = 0; offset + EXFAT_ENTRY_SIZE <= root.length; offset += EXFAT_ENTRY_SIZE) {
    const typeByte = root.readUInt8(offset)
    if (typeByte === ExfatEntryType.EndOfDirectory) break
    if ((typeByte & 0x7f) !== ExfatEntryType.AllocationBitmap) continue

    const firstCluster = root.readUInt32LE(offset + 0x14)
    const lengthBytes = Number(root.readBigUInt64LE(offset + 0x18))

    if (firstCluster < 2 || lengthBytes <= 0 || lengthBytes > MAX_BITMAP_BYTES) return null

    try {
      const chain = followExfatChain(fat, geometry, firstCluster)
      const clusters =
        chain.length > 0
          ? chain
          : // The bitmap is contiguous on every volume in practice.
            Array.from(
              { length: Math.ceil(lengthBytes / geometry.clusterSizeBytes) },
              (_, index) => firstCluster + index,
            )

      const chunks: Buffer[] = []
      let remaining = lengthBytes

      for (const cluster of clusters) {
        if (remaining <= 0) break
        const take = Math.min(geometry.clusterSizeBytes, remaining)
        chunks.push(await reader.read(exfatClusterToOffset(geometry, cluster), take))
        remaining -= take
      }

      return chunks.length > 0 ? Buffer.concat(chunks) : null
    } catch {
      return null
    }
  }

  return null
}

async function readDirectory(
  reader: BlockReader,
  geometry: ExfatGeometry,
  fat: Buffer,
  firstCluster: number,
): Promise<Buffer | null> {
  if (firstCluster < 2) return null

  try {
    const chain = followExfatChain(fat, geometry, firstCluster)
    const clusters = chain.length > 0 ? chain : [firstCluster]

    const chunks: Buffer[] = []
    for (const cluster of clusters) {
      chunks.push(
        await reader.read(exfatClusterToOffset(geometry, cluster), geometry.clusterSizeBytes),
      )
    }

    return Buffer.concat(chunks)
  } catch {
    return null
  }
}

// --- Conversion ------------------------------------------------------------

interface ConversionContext {
  readonly entry: ExfatDirectoryEntry
  readonly geometry: ExfatGeometry
  readonly fat: Buffer
  readonly bitmap: Buffer | null
  readonly sessionId: string
  readonly parentPath: string
  readonly volumeOffsetBytes: number
  readonly entryIndex: number
}

function toRecoveredFile(context: ConversionContext): RecoveredFile {
  const { entry, geometry, fat, bitmap, sessionId, parentPath, volumeOffsetBytes, entryIndex } =
    context

  const clusters = resolveClusters(entry, geometry, fat)

  const extents = entry.isDirectory
    ? []
    : clustersToExtents(
        clusters,
        geometry.clusterSizeBytes,
        (cluster) => exfatClusterToOffset(geometry, cluster),
        entry.sizeBytes,
        volumeOffsetBytes,
      )

  return {
    id: `${sessionId}:exfat:${entryIndex}`,
    sessionId,
    name: entry.name,
    path: parentPath,
    extension: extensionOf(entry.name),
    category: categoryOf(entry.name),
    sizeBytes: entry.sizeBytes,
    isDeleted: entry.isDeleted,
    isDirectory: entry.isDirectory,
    createdAt: entry.createdAt,
    modifiedAt: entry.modifiedAt,
    accessedAt: entry.accessedAt,
    quality: assessExfatQuality(entry, bitmap, clusters),
    source: 'exfat-directory',
    extents,
    hasResidentData: false,
    isFragmented: !entry.isContiguous && clusters.length > 1,
    isCompressed: false,
    isEncrypted: false,
  }
}

/**
 * Work out which clusters a file occupies.
 *
 * A contiguous file has no FAT chain at all — the format says so explicitly —
 * so its clusters are computed from the first one. Only a fragmented file needs
 * the chain, and if that chain is gone the contiguous run is the fallback.
 */
function resolveClusters(
  entry: ExfatDirectoryEntry,
  geometry: ExfatGeometry,
  fat: Buffer,
): number[] {
  if (entry.firstCluster < 2 || entry.sizeBytes <= 0) return []

  const needed = Math.ceil(entry.sizeBytes / geometry.clusterSizeBytes)
  const contiguous = (): number[] =>
    Array.from({ length: needed }, (_, index) => entry.firstCluster + index).filter(
      (cluster) => cluster < geometry.clusterCount + 2,
    )

  if (entry.isContiguous) return contiguous()

  const chain = followExfatChain(fat, geometry, entry.firstCluster)
  return chain.length > 0 ? chain : contiguous()
}

/**
 * Score an exFAT entry's recoverability.
 *
 * The allocation bitmap answers the decisive question for a deleted file, and
 * the contiguity flag decides whether the extents are known or assumed.
 */
export function assessExfatQuality(
  entry: ExfatDirectoryEntry,
  bitmap: Buffer | null,
  clusters: readonly number[],
): RecoveryQuality {
  if (entry.isDirectory) return 'good'
  if (entry.sizeBytes === 0) return 'good'
  if (!entry.isDeleted) return 'excellent'

  if (entry.firstCluster < 2 || clusters.length === 0) return 'poor'
  if (bitmap === null) return 'fair'

  for (const cluster of clusters) {
    const state = clusterAllocated(bitmap, cluster)
    // Past the end of the bitmap means the entry points outside the volume.
    if (state === null) return 'poor'
    if (state) return 'poor'
  }

  // Every cluster is still free. Contiguity known from the format beats
  // contiguity assumed by the scanner.
  return entry.isContiguous ? 'excellent' : 'good'
}

/**
 * Read one bit of the allocation bitmap.
 *
 * Cluster 2 is the first data cluster and maps to bit 0 — the two-cluster
 * offset is the classic exFAT bitmap bug, and it shifts every answer by two.
 */
function clusterAllocated(bitmap: Buffer, cluster: number): boolean | null {
  const index = cluster - 2
  if (index < 0) return null

  const byte = index >> 3
  if (byte >= bitmap.length) return null

  return (((bitmap[byte] ?? 0) >> (index & 7)) & 1) === 1
}

function joinPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}\\${name}`
}

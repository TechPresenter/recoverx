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
  DIRECTORY_ENTRY_SIZE,
  assumeContiguousChain,
  clusterToOffset,
  followClusterChain,
  parseFatBootSector,
  parseFatDirectory,
  readFatEntry,
  type FatDirectoryEntry,
  type FatGeometry,
} from './fat'

/**
 * FAT12/16/32 metadata scan.
 *
 * The directory tree is walked breadth-first from the root. Deleted entries sit
 * in place alongside live ones — that is the whole reason a quick scan works on
 * FAT — so both are read from the same buffers.
 *
 * The FAT itself doubles as the allocation map: a zero entry means the cluster
 * is free. For a deleted file whose chain was destroyed, checking whether its
 * assumed clusters are still free is the closest FAT gets to NTFS's `$Bitmap`,
 * and it is what makes the quality score meaningful rather than decorative.
 */

/** Results emitted per batch, so the UI updates steadily on a large volume. */
const FILES_PER_BATCH = 512

/** Bound on directory recursion; a damaged FAT can contain a cyclic tree. */
const MAX_DIRECTORY_DEPTH = 64

/** Bound on the FAT held in memory. Covers a 2 TB FAT32 volume. */
const MAX_FAT_BYTES = 64 * 1024 * 1024

interface QueuedDirectory {
  readonly path: string
  readonly depth: number
  /** `0` means the fixed root directory of a FAT12/16 volume. */
  readonly firstCluster: number
}

export async function* scanFatVolume(
  reader: BlockReader,
  sessionId: string,
  volumeOffsetBytes: number,
  options: ScanOptions,
): AsyncGenerator<ScanBatch> {
  const geometry = parseFatBootSector(await reader.read(0, 512))

  if (geometry === null) {
    throw new AppError(ErrorCode.Unsupported, 'This volume is not readable as FAT', {
      retryable: false,
    })
  }

  const fat = await loadFat(reader, geometry)

  const queue: QueuedDirectory[] = [
    { path: '', depth: 0, firstCluster: geometry.variant === 'fat32' ? geometry.rootCluster : 0 },
  ]
  const visited = new Set<number>()

  let emitted: RecoveredFile[] = []
  let processed = 0
  let entryIndex = 0

  while (queue.length > 0) {
    const directory = queue.shift()
    if (directory === undefined) break

    if (options.maxUnits !== undefined && processed >= options.maxUnits) break

    // A directory that points at itself, or at an already-visited cluster,
    // would otherwise loop forever.
    if (directory.firstCluster !== 0) {
      if (visited.has(directory.firstCluster)) continue
      visited.add(directory.firstCluster)
    }

    const buffer = await readDirectory(reader, geometry, fat, directory.firstCluster)
    processed += 1

    if (buffer === null) continue

    for (const entry of parseFatDirectory(buffer).entries) {
      if (entry.isVolumeLabel) continue
      // "." and ".." are self and parent links, not files.
      if (entry.name === '.' || entry.name === '..' || entry.shortName.startsWith('.')) continue

      if (entry.isDirectory) {
        if (directory.depth + 1 < MAX_DIRECTORY_DEPTH && entry.firstCluster >= 2) {
          queue.push({
            path: joinPath(directory.path, entry.name),
            depth: directory.depth + 1,
            firstCluster: entry.firstCluster,
          })
        }
        // A deleted directory is still worth listing: it tells the user what
        // structure was lost even though it holds no data of its own.
        if (!entry.isDeleted && !options.includeExisting) continue
      }

      entryIndex += 1

      const file = toRecoveredFile({
        entry,
        geometry,
        fat,
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

/**
 * Load the first copy of the FAT.
 *
 * FAT volumes keep two identical copies; the first is authoritative. On a
 * damaged volume the second is a genuine recovery avenue, which the Partition
 * Recovery module will use — here the first is enough.
 */
async function loadFat(reader: BlockReader, geometry: FatGeometry): Promise<Buffer> {
  const lengthBytes = geometry.sectorsPerFat * geometry.bytesPerSector

  if (lengthBytes <= 0 || lengthBytes > MAX_FAT_BYTES) return Buffer.alloc(0)

  try {
    return await reader.read(geometry.firstFatSector * geometry.bytesPerSector, lengthBytes)
  } catch {
    // Without the FAT, live chains cannot be followed and every file falls back
    // to the contiguous assumption. Degraded, but far from useless.
    return Buffer.alloc(0)
  }
}

/**
 * Read a directory's contents.
 *
 * `firstCluster === 0` means the fixed root directory of a FAT12/16 volume,
 * which lives at a known sector rather than in the cluster area.
 */
async function readDirectory(
  reader: BlockReader,
  geometry: FatGeometry,
  fat: Buffer,
  firstCluster: number,
): Promise<Buffer | null> {
  try {
    if (firstCluster === 0) {
      if (geometry.rootDirectorySectors === 0) return null

      return await reader.read(
        geometry.firstRootDirectorySector * geometry.bytesPerSector,
        geometry.rootDirectorySectors * geometry.bytesPerSector,
      )
    }

    const chain = followClusterChain(fat, geometry, firstCluster)
    // A directory whose chain is gone is still readable for one cluster, which
    // is where most small directories live entirely.
    const clusters = chain.length > 0 ? chain : [firstCluster]

    const chunks: Buffer[] = []
    for (const cluster of clusters) {
      chunks.push(await reader.read(clusterToOffset(geometry, cluster), geometry.clusterSizeBytes))
    }

    return Buffer.concat(chunks)
  } catch {
    return null
  }
}

// --- Conversion ------------------------------------------------------------

interface ConversionContext {
  readonly entry: FatDirectoryEntry
  readonly geometry: FatGeometry
  readonly fat: Buffer
  readonly sessionId: string
  readonly parentPath: string
  readonly volumeOffsetBytes: number
  readonly entryIndex: number
}

function toRecoveredFile(context: ConversionContext): RecoveredFile {
  const { entry, geometry, fat, sessionId, parentPath, volumeOffsetBytes, entryIndex } = context

  const chainIsIntact = !entry.isDeleted && entry.firstCluster >= 2
  const clusters = chainIsIntact
    ? followClusterChain(fat, geometry, entry.firstCluster)
    : assumeContiguousChain(geometry, entry.firstCluster, entry.sizeBytes)

  const extents = entry.isDirectory
    ? []
    : clustersToExtents(
        clusters,
        geometry.clusterSizeBytes,
        (cluster) => clusterToOffset(geometry, cluster),
        entry.sizeBytes,
        volumeOffsetBytes,
      )

  return {
    id: `${sessionId}:fat:${entryIndex}`,
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
    quality: assessFatQuality(entry, geometry, fat, clusters),
    source: 'fat-directory',
    extents,
    hasResidentData: false,
    // Only a followed chain can reveal fragmentation; an assumed one is
    // contiguous by construction and must not claim otherwise.
    isFragmented: chainIsIntact && isFragmented(clusters),
    isCompressed: false,
    isEncrypted: false,
  }
}

/**
 * Score a FAT entry's recoverability.
 *
 * The pivotal case is a deleted file: FAT destroys the cluster chain on
 * deletion, so its extents are an *assumption* of contiguity. Whether the
 * assumed clusters are still free in the FAT is the best available evidence
 * that nothing has overwritten them.
 */
export function assessFatQuality(
  entry: FatDirectoryEntry,
  geometry: FatGeometry,
  fat: Buffer,
  clusters: readonly number[],
): RecoveryQuality {
  if (entry.isDirectory) return 'good'
  if (entry.sizeBytes === 0) return 'good'

  if (!entry.isDeleted) return 'excellent'

  if (entry.firstCluster < 2 || clusters.length === 0) return 'poor'
  if (fat.length === 0) return 'fair'

  for (const cluster of clusters) {
    // A non-zero FAT entry means the cluster has been handed to another file.
    if (readFatEntry(fat, geometry.variant, cluster) !== 0) return 'poor'
  }

  // Every assumed cluster is still free. The data is very likely intact — but
  // "good" rather than "excellent", because contiguity remains an assumption
  // that FAT gives no way to verify.
  return clusters.length === 1 ? 'excellent' : 'good'
}

function isFragmented(clusters: readonly number[]): boolean {
  for (let index = 1; index < clusters.length; index += 1) {
    if (clusters[index]! !== clusters[index - 1]! + 1) return true
  }
  return false
}

function joinPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}\\${name}`
}

/** Entries per directory cluster. Exported for the session's progress estimate. */
export function entriesPerCluster(geometry: FatGeometry): number {
  return Math.floor(geometry.clusterSizeBytes / DIRECTORY_ENTRY_SIZE)
}

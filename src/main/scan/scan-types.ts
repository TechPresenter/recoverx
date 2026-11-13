import type { FileExtent, RecoveredFile } from '@shared/types/scan'

/**
 * The contract every filesystem scanner implements.
 *
 * Scanners are async generators rather than callback-driven: the consumer
 * controls the pace, which is what makes pause and cancel trivial (stop pulling)
 * and keeps back-pressure honest when SQLite writes are slower than parsing.
 */

export interface ScanBatch {
  readonly files: readonly RecoveredFile[]
  /** Units of work completed. Meaning depends on the scanner. */
  readonly processed: number
  /** Total units, or `0` when it cannot be known before the scan finishes. */
  readonly total: number
}

export interface ScanOptions {
  /** Include files that still exist, not just deleted ones. */
  readonly includeExisting: boolean
  /** Stop after this many units of work. Used for previews and tests. */
  readonly maxUnits?: number
}

export type VolumeScanner = (
  sessionId: string,
  volumeOffsetBytes: number,
  options: ScanOptions,
) => AsyncGenerator<ScanBatch>

/**
 * Collapse a cluster list into contiguous byte extents, truncated to the file's
 * real size.
 *
 * Merging matters for more than tidiness: a 4 GB video occupying one million
 * consecutive clusters becomes a single extent rather than a million rows, which
 * is the difference between a recovery job that streams and one that thrashes.
 *
 * The final extent is trimmed to `sizeBytes` because the last cluster is almost
 * never full, and copying the slack would append garbage to every recovered file.
 */
export function clustersToExtents(
  clusters: readonly number[],
  clusterSizeBytes: number,
  offsetOfCluster: (cluster: number) => number,
  sizeBytes: number,
  volumeOffsetBytes: number,
): FileExtent[] {
  if (clusters.length === 0 || sizeBytes <= 0) return []

  const extents: FileExtent[] = []
  let runStart = clusters[0]!
  let runLength = 1

  const flush = (): void => {
    extents.push({
      offsetBytes: offsetOfCluster(runStart) + volumeOffsetBytes,
      lengthBytes: runLength * clusterSizeBytes,
    })
  }

  for (let index = 1; index < clusters.length; index += 1) {
    const cluster = clusters[index]!

    if (cluster === runStart + runLength) {
      runLength += 1
      continue
    }

    flush()
    runStart = cluster
    runLength = 1
  }

  flush()

  return truncateExtents(extents, sizeBytes)
}

/** Trim a list of extents so their total length is exactly `sizeBytes`. */
export function truncateExtents(extents: readonly FileExtent[], sizeBytes: number): FileExtent[] {
  const trimmed: FileExtent[] = []
  let remaining = sizeBytes

  for (const extent of extents) {
    if (remaining <= 0) break

    const lengthBytes = Math.min(extent.lengthBytes, remaining)
    trimmed.push({ offsetBytes: extent.offsetBytes, lengthBytes })
    remaining -= lengthBytes
  }

  return trimmed
}

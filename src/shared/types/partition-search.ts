import { z } from 'zod'
import { FileSystemSchema } from './disk'

/**
 * Lost-partition search.
 *
 * When a partition table is wiped, repartitioned or corrupted, the partitions
 * it described do not go anywhere — only the four-entry table at sector 0 (or
 * the GPT arrays) is lost. Every filesystem writes its own boot sector or
 * superblock at the start of its volume, and that structure records the
 * volume's geometry: sector size, cluster size and, crucially, its own total
 * length. A partition can therefore be reconstructed entirely from the data it
 * still contains, without any surviving table entry.
 *
 * Nothing here writes to the source device. A found partition is offered as a
 * *scan target*, so the user recovers their files to a different drive. That is
 * the outcome they actually want, and it does not stake their data on the
 * assumption that this search got the geometry exactly right.
 */

/**
 * How thoroughly the device is searched.
 *
 * `unallocated` covers the gaps between the partitions the table still lists —
 * where a deleted partition's data sits — and is the right default. It skips
 * regions that are already accounted for, so it is proportionally faster on a
 * disk that lost only one partition.
 *
 * `whole-device` ignores the table entirely. It is the correct choice when the
 * table itself is suspect: after a bad repartition, the surviving entries can
 * describe a layout that never existed, and the regions they claim are exactly
 * where the real partitions are hiding.
 */
export const PartitionSearchScopeSchema = z.enum(['unallocated', 'whole-device'])
export type PartitionSearchScope = z.infer<typeof PartitionSearchScopeSchema>

/**
 * What corroborates a candidate.
 *
 * Reported as codes rather than sentences so the UI can translate them, and so
 * the confidence rating can be recomputed without re-parsing prose.
 */
export const PartitionEvidenceSchema = z.enum([
  /** A filesystem header was found at the implied start of the volume. */
  'boot-sector',
  /** The filesystem's own backup header agrees with the primary. */
  'backup-boot-sector',
  /** The volume reports its own length, and that length fits on this device. */
  'self-reported-size',
  /** The length had to be inferred from the surrounding free space. */
  'estimated-size',
  /** The volume's declared length runs past the end of the device. */
  'size-clipped',
])
export type PartitionEvidence = z.infer<typeof PartitionEvidenceSchema>

/**
 * Confidence that a candidate is a real, recoverable partition.
 *
 * `confirmed` requires two independent on-disk copies of the header to agree,
 * which is as close to certainty as a disk can offer. `likely` is a single
 * valid header whose self-reported geometry is internally consistent and fits
 * the device. `possible` is a valid header for a filesystem that does not
 * record its own length, so the extent had to be guessed.
 */
export const PartitionConfidenceSchema = z.enum(['confirmed', 'likely', 'possible'])
export type PartitionConfidence = z.infer<typeof PartitionConfidenceSchema>

export const PartitionCandidateSchema = z.object({
  /** Stable within one search: `<deviceId>:found<n>`. */
  id: z.string(),
  deviceId: z.string(),
  offsetBytes: z.number(),
  sizeBytes: z.number(),
  fileSystem: FileSystemSchema,
  label: z.string().nullable(),
  clusterSizeBytes: z.number().nullable(),
  confidence: PartitionConfidenceSchema,
  evidence: z.array(PartitionEvidenceSchema),
  /** `true` when a metadata scan can read this filesystem's own records. */
  supportsQuickScan: z.boolean(),
})

export type PartitionCandidate = z.infer<typeof PartitionCandidateSchema>

export const PartitionSearchStatusSchema = z.enum(['running', 'completed', 'cancelled', 'failed'])
export type PartitionSearchStatus = z.infer<typeof PartitionSearchStatusSchema>

export const PartitionSearchProgressSchema = z.object({
  searchId: z.string(),
  deviceId: z.string(),
  status: PartitionSearchStatusSchema,
  bytesScanned: z.number(),
  bytesTotal: z.number(),
  /** Where the read head is, so the UI can show position on the device map. */
  currentOffsetBytes: z.number(),
  candidatesFound: z.number().int(),
  elapsedMs: z.number(),
  estimatedRemainingMs: z.number().nullable(),
  bytesPerSecond: z.number(),
})

export type PartitionSearchProgress = z.infer<typeof PartitionSearchProgressSchema>

export const PartitionSearchResultSchema = z.object({
  searchId: z.string(),
  deviceId: z.string(),
  scope: PartitionSearchScopeSchema,
  status: PartitionSearchStatusSchema,
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  bytesScanned: z.number(),
  bytesTotal: z.number(),
  candidates: z.array(PartitionCandidateSchema),
  warnings: z.array(z.string()),
})

export type PartitionSearchResult = z.infer<typeof PartitionSearchResultSchema>

/**
 * Smallest volume worth reporting.
 *
 * Below this, a "partition" is almost always a false positive: a header-shaped
 * run of bytes inside a disk image, a virtual machine file, or an installer
 * payload that happens to contain a filesystem. Real partitions that small hold
 * nothing a user would come here to recover.
 */
export const MIN_CANDIDATE_SIZE_BYTES = 8 * 1024 * 1024

/** Rank used to break ties when two candidates claim overlapping space. */
export function confidenceRank(confidence: PartitionConfidence): number {
  switch (confidence) {
    case 'confirmed':
      return 3
    case 'likely':
      return 2
    case 'possible':
      return 1
  }
}

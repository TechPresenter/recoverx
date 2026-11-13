import { z } from 'zod'
import { SelectionSchema } from './scan'

/**
 * Recovery jobs.
 *
 * A job is the unit a user starts, watches and later finds in their history.
 * Its per-file outcomes are persisted rather than kept in memory, because the
 * question "which of those four thousand files actually came back intact?" is
 * asked *after* the run, often days later.
 */

export const RecoveryStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
])
export type RecoveryStatus = z.infer<typeof RecoveryStatusSchema>

/** Outcome for one file. */
export const RecoveryItemStatusSchema = z.enum(['recovered', 'partial', 'skipped', 'failed'])
export type RecoveryItemStatus = z.infer<typeof RecoveryItemStatusSchema>

export const RecoveryOptionsSchema = z.object({
  /** Absolute path of the destination folder. */
  destination: z.string().min(1),
  /** Recreate the folder hierarchy each file came from. */
  restoreFolderStructure: z.boolean(),
  /** Place files in per-category folders (Images/, Documents/…). */
  groupByCategory: z.boolean(),
  /**
   * Skip files whose recovered bytes do not match their extension.
   *
   * Off by default: a mismatch is worth knowing about, but the user may still
   * want the data, and silently discarding it would be the tool making a
   * decision that is not its to make.
   */
  skipMismatched: z.boolean(),
})

export type RecoveryOptions = z.infer<typeof RecoveryOptionsSchema>

export const StartRecoveryRequestSchema = z.object({
  selection: SelectionSchema,
  options: RecoveryOptionsSchema,
})

export type StartRecoveryRequest = z.infer<typeof StartRecoveryRequestSchema>

export const RecoveryJobSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  destination: z.string(),
  status: RecoveryStatusSchema,
  restoreFolderStructure: z.boolean(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  totalFiles: z.number(),
  totalBytes: z.number(),
  recoveredFiles: z.number(),
  recoveredBytes: z.number(),
  partialFiles: z.number(),
  skippedFiles: z.number(),
  failedFiles: z.number(),
  /** Files written whose contents did not match their name. */
  mismatchedFiles: z.number(),
  errorMessage: z.string().nullable(),
})

export type RecoveryJob = z.infer<typeof RecoveryJobSchema>

export const RecoveryProgressSchema = z.object({
  jobId: z.string(),
  status: RecoveryStatusSchema,
  processedFiles: z.number(),
  totalFiles: z.number(),
  recoveredBytes: z.number(),
  totalBytes: z.number(),
  /** Name of the file currently being written, for the status line. */
  currentFile: z.string().nullable(),
  elapsedMs: z.number(),
  estimatedRemainingMs: z.number().nullable(),
  bytesPerSecond: z.number(),
})

export type RecoveryProgress = z.infer<typeof RecoveryProgressSchema>

export const RecoveryItemSchema = z.object({
  jobId: z.string(),
  fileId: z.string(),
  name: z.string(),
  targetPath: z.string(),
  status: RecoveryItemStatusSchema,
  /** Signature check on the bytes actually written. */
  verification: z.enum(['match', 'mismatch', 'unknown', 'empty']),
  bytesWritten: z.number(),
  expectedBytes: z.number(),
  error: z.string().nullable(),
})

export type RecoveryItem = z.infer<typeof RecoveryItemSchema>

export const RecoveryItemFilterSchema = z.object({
  jobId: z.string(),
  /** Limit to specific outcomes, e.g. only the failures. */
  statuses: z.array(RecoveryItemStatusSchema).optional(),
  limit: z.number().int().min(1).max(2000),
  offset: z.number().int().min(0),
})

export type RecoveryItemFilter = z.infer<typeof RecoveryItemFilterSchema>

/** Default options for a fresh recovery. */
export function defaultRecoveryOptions(destination: string): RecoveryOptions {
  return {
    destination,
    // On by default: a flat dump of ten thousand files is far harder to use
    // than the structure the user already knows.
    restoreFolderStructure: true,
    groupByCategory: false,
    skipMismatched: false,
  }
}

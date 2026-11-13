import { z } from 'zod'

/**
 * Crash reports and updates.
 *
 * Both are about what happens when the application is not working, and both
 * touch the user's privacy, so both default to doing nothing without being
 * asked.
 *
 * A crash report is written locally, always. Sending one anywhere is opt-in and
 * off by default: a report contains stack traces and file paths from a machine
 * whose owner came here because their data is in trouble, and quietly
 * transmitting that would be a poor way to repay the trust.
 */

export const CrashKindSchema = z.enum([
  /** An exception nothing else caught, in the main process. */
  'main-exception',
  /** A rejected promise nobody handled. */
  'main-rejection',
  /** The window's renderer process died. */
  'renderer-gone',
  /** A Chromium helper process died. */
  'child-process-gone',
])
export type CrashKind = z.infer<typeof CrashKindSchema>

export const CrashReportSchema = z.object({
  id: z.string(),
  occurredAt: z.number(),
  kind: CrashKindSchema,
  message: z.string(),
  /** Redacted: absolute paths are rewritten before this is ever stored. */
  stack: z.string().nullable(),
  appVersion: z.string(),
  electronVersion: z.string(),
  osVersion: z.string(),
  arch: z.string(),
  /** Seconds the application had been running. */
  uptimeSeconds: z.number(),
  /** `true` once the user has explicitly sent this report. */
  sent: z.boolean(),
})

export type CrashReport = z.infer<typeof CrashReportSchema>

/** Where an update check has got to. */
export const UpdateStatusSchema = z.enum([
  'idle',
  'checking',
  'available',
  'not-available',
  'downloading',
  'downloaded',
  'error',
  /** The build was not packaged, so it has nothing to update. */
  'unsupported',
  /**
   * Installed from the Microsoft Store, which delivers updates itself. A
   * status rather than a separate flag because it is terminal in the same way
   * `unsupported` is: no check, download or install is ever offered.
   */
  'store-managed',
])
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>

export const UpdateStateSchema = z.object({
  status: UpdateStatusSchema,
  currentVersion: z.string(),
  /** The version on the server, once a check has found one. */
  availableVersion: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  releaseDate: z.string().nullable(),
  /** 0–100 while downloading. */
  percent: z.number(),
  bytesPerSecond: z.number(),
  transferredBytes: z.number(),
  totalBytes: z.number(),
  /** Present when the last check or download failed. */
  errorMessage: z.string().nullable(),
  checkedAt: z.number().nullable(),
})

export type UpdateState = z.infer<typeof UpdateStateSchema>

/** How many crash reports to keep before the oldest are discarded. */
export const MAX_CRASH_REPORTS = 25

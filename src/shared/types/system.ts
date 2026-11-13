import { z } from 'zod'

/**
 * Application identity and host-machine telemetry surfaced on the Dashboard and
 * in support bundles.
 */

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  /** `true` when running from an installed build rather than `electron-vite dev`. */
  isPackaged: z.boolean(),
  /** Update channel this build subscribes to. */
  channel: z.enum(['latest', 'beta', 'alpha']),
  platform: z.string(),
  arch: z.string(),
  locale: z.string(),
  runtime: z.object({
    electron: z.string(),
    chrome: z.string(),
    node: z.string(),
    v8: z.string(),
  }),
})

export type AppInfo = z.infer<typeof AppInfoSchema>

export const MemoryUsageSchema = z.object({
  totalBytes: z.number(),
  freeBytes: z.number(),
  usedBytes: z.number(),
  usagePercent: z.number(),
})

export type MemoryUsage = z.infer<typeof MemoryUsageSchema>

export const ProcessUsageSchema = z.object({
  uptimeMs: z.number(),
  rssBytes: z.number(),
  heapUsedBytes: z.number(),
  heapTotalBytes: z.number(),
  externalBytes: z.number(),
})

export type ProcessUsage = z.infer<typeof ProcessUsageSchema>

export const SystemSnapshotSchema = z.object({
  capturedAt: z.number(),
  os: z.object({
    platform: z.string(),
    /** Marketing name where resolvable, e.g. "Windows 11 Pro". */
    distro: z.string(),
    release: z.string(),
    arch: z.string(),
    hostname: z.string(),
    uptimeMs: z.number(),
  }),
  cpu: z.object({
    model: z.string(),
    /** Logical cores, i.e. what the scan scheduler may use as a thread budget. */
    logicalCores: z.number(),
    speedMhz: z.number(),
    /**
     * Sampled utilisation across all cores, 0–100. Computed from the delta
     * between two `os.cpus()` readings; `null` on the very first sample.
     */
    utilizationPercent: z.number().nullable(),
  }),
  memory: MemoryUsageSchema,
  process: ProcessUsageSchema,
  /** `true` when the process holds an elevated (Administrator) token. */
  isElevated: z.boolean(),
})

export type SystemSnapshot = z.infer<typeof SystemSnapshotSchema>

/**
 * Runtime health of the application's own infrastructure. Distinct from
 * `SystemSnapshot`, which describes the host.
 */
export const DiagnosticsSchema = z.object({
  /** Milliseconds from process start to the first paint of the main window. */
  startupMs: z.number(),
  userDataDir: z.string(),
  databasePath: z.string(),
  databaseSizeBytes: z.number(),
  /** Highest migration version applied to the open database. */
  schemaVersion: z.number(),
  appliedMigrations: z.number(),
  logDirectory: z.string(),
  logSizeBytes: z.number(),
  logFileCount: z.number(),
})

export type Diagnostics = z.infer<typeof DiagnosticsSchema>

export const WindowStateSchema = z.object({
  isMaximized: z.boolean(),
  isMinimized: z.boolean(),
  isFullScreen: z.boolean(),
  isFocused: z.boolean(),
})

export type WindowState = z.infer<typeof WindowStateSchema>

export const DirectoryPickResultSchema = z.object({
  /** `null` when the user dismissed the dialog. */
  path: z.string().nullable(),
})

export type DirectoryPickResult = z.infer<typeof DirectoryPickResultSchema>

export const PathValidationSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  isDirectory: z.boolean(),
  isWritable: z.boolean(),
  freeBytes: z.number(),
  totalBytes: z.number(),
})

export type PathValidation = z.infer<typeof PathValidationSchema>

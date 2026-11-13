import { z } from 'zod'
import { LogLevelSchema } from './settings'

/**
 * Log transport types shared by the Winston sink in the main process and the
 * Logs screen in the renderer.
 */

export const LogEntrySchema = z.object({
  /** Stable identity for list virtualisation: `<file>:<lineOffset>`. */
  id: z.string(),
  timestamp: z.number(),
  level: LogLevelSchema,
  /** Subsystem that emitted the record, e.g. `database`, `ipc`, `renderer`. */
  scope: z.string(),
  message: z.string(),
  /**
   * Structured metadata, pre-serialised to a JSON string.
   *
   * Winston metadata can contain values that structured cloning rejects
   * (functions, class instances, circular references). Serialising at the sink
   * guarantees every record survives the IPC boundary, and the Logs screen
   * renders it verbatim anyway.
   */
  meta: z.string().nullable(),
})

export type LogEntry = z.infer<typeof LogEntrySchema>

export const LogQuerySchema = z.object({
  /** Log file name. Omit to read the current day's file. */
  file: z.string().optional(),
  /** Levels to include. Omit or leave empty for all levels. */
  levels: z.array(LogLevelSchema).optional(),
  /** Case-insensitive substring match against message and scope. */
  search: z.string().optional(),
  sinceEpochMs: z.number().optional(),
  untilEpochMs: z.number().optional(),
  limit: z.number().int().min(1).max(2000),
  offset: z.number().int().min(0),
})

export type LogQuery = z.infer<typeof LogQuerySchema>

export const LogQueryResultSchema = z.object({
  file: z.string(),
  entries: z.array(LogEntrySchema),
  /** Records matching the filter across the scanned region, before pagination. */
  total: z.number(),
  scannedBytes: z.number(),
  /**
   * `true` when the file was larger than the scan budget and only its tail was
   * read. The UI surfaces this so a user never mistakes a truncated view for a
   * complete history.
   */
  truncated: z.boolean(),
  /** Lines that could not be parsed as JSON records, e.g. a partial final write. */
  malformedLines: z.number(),
})

export type LogQueryResult = z.infer<typeof LogQueryResultSchema>

export const LogFileInfoSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.number(),
  /** `true` for the file the logger is currently appending to. */
  isActive: z.boolean(),
})

export type LogFileInfo = z.infer<typeof LogFileInfoSchema>

/** Payload for forwarding a renderer-side event into the main process logger. */
export const RendererLogRecordSchema = z.object({
  level: LogLevelSchema,
  scope: z.string().min(1).max(64),
  message: z.string().min(1).max(4096),
  meta: z.string().max(16_384).nullable(),
})

export type RendererLogRecord = z.infer<typeof RendererLogRecordSchema>

export const LogCleanupResultSchema = z.object({
  removedFiles: z.number(),
  freedBytes: z.number(),
})

export type LogCleanupResult = z.infer<typeof LogCleanupResultSchema>

/** Numeric severity ordering, used for filtering and for the level chips. */
export const LOG_LEVEL_SEVERITY: Readonly<Record<z.infer<typeof LogLevelSchema>, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

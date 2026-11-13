import { LOG_LEVEL_SEVERITY, type LogEntry, type LogQuery } from '@shared/types/logging'
import type { LogLevel } from '@shared/types/settings'

/**
 * Pure parsing and filtering for the JSON-lines log format.
 *
 * The on-disk record written by the Winston sink is:
 *   {"ts":1753800000000,"level":"info","scope":"database","message":"…","meta":"…"|null}
 *
 * Parsing lives here, apart from any filesystem access, so the awkward cases —
 * a half-written final line during rotation, a record from an older schema, a
 * level the current build does not know — are all directly testable.
 */

const VALID_LEVELS = new Set<string>(Object.keys(LOG_LEVEL_SEVERITY))

export interface ParsedLines {
  readonly entries: LogEntry[]
  /** Lines that were not valid records. Surfaced in the UI, never thrown. */
  readonly malformed: number
}

/**
 * Parse a raw block of log text into entries.
 *
 * @param text        Raw file content (or the tail of it).
 * @param fileName    Used to build stable entry ids for list virtualisation.
 * @param lineOffset  Index of the first line within the whole file, so ids stay
 *                    stable when only a tail slice was read.
 */
export function parseLogLines(text: string, fileName: string, lineOffset = 0): ParsedLines {
  const entries: LogEntry[] = []
  let malformed = 0

  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue

    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    const entry = parseLogLine(trimmed, `${fileName}:${lineOffset + index}`)
    if (entry === null) {
      malformed += 1
    } else {
      entries.push(entry)
    }
  }

  return { entries, malformed }
}

/** Parse a single JSON line. Returns `null` for anything that is not a record. */
export function parseLogLine(line: string, id: string): LogEntry | null {
  let decoded: unknown
  try {
    // eslint-disable-next-line no-restricted-syntax -- shape is validated field by field immediately below
    decoded = JSON.parse(line)
  } catch {
    return null
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null

  const record = decoded as Record<string, unknown>

  const timestamp = record.ts
  const level = record.level
  const message = record.message

  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null
  if (typeof level !== 'string' || !VALID_LEVELS.has(level)) return null
  if (typeof message !== 'string') return null

  const scope = record.scope
  const meta = record.meta

  return {
    id,
    timestamp,
    level: level as LogLevel,
    scope: typeof scope === 'string' && scope.length > 0 ? scope : 'app',
    message,
    meta: typeof meta === 'string' && meta.length > 0 ? meta : null,
  }
}

/**
 * Apply a query's filters to already-parsed entries.
 * Pagination is applied by `paginate`, separately, so `total` can report the
 * full match count.
 */
export function filterEntries(entries: readonly LogEntry[], query: LogQuery): LogEntry[] {
  const levels = query.levels && query.levels.length > 0 ? new Set(query.levels) : null
  const needle = query.search?.trim().toLowerCase()
  const since = query.sinceEpochMs
  const until = query.untilEpochMs

  return entries.filter((entry) => {
    if (levels !== null && !levels.has(entry.level)) return false
    if (since !== undefined && entry.timestamp < since) return false
    if (until !== undefined && entry.timestamp > until) return false

    if (needle !== undefined && needle.length > 0) {
      const haystack = `${entry.message}\n${entry.scope}\n${entry.meta ?? ''}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }

    return true
  })
}

/**
 * Slice a page out of the matched set.
 *
 * Entries are returned newest-first because that is the order an operator reads
 * a log in; the underlying file is append-ordered, so the reversal happens once,
 * here, rather than in the render path on every keystroke.
 */
export function paginate(entries: readonly LogEntry[], limit: number, offset: number): LogEntry[] {
  const newestFirst = entries.slice().reverse()
  return newestFirst.slice(offset, offset + limit)
}

/**
 * Find the byte offset at which to begin reading so that only whole lines are
 * parsed.
 *
 * When a large file is tail-read, the first line in the buffer is almost always
 * a fragment. Returning the position just after the first newline discards it.
 */
export function alignToLineStart(buffer: string): { text: string; skippedBytes: number } {
  const newlineIndex = buffer.indexOf('\n')
  if (newlineIndex === -1) return { text: buffer, skippedBytes: 0 }
  return { text: buffer.slice(newlineIndex + 1), skippedBytes: newlineIndex + 1 }
}

/**
 * Serialise arbitrary log metadata to a bounded, clone-safe JSON string.
 *
 * Circular references and oversized payloads are both real hazards here: the
 * scanner logs device descriptors that reference their parent, and a verbose
 * error object can carry a multi-megabyte buffer. Either would otherwise take
 * down the logging path.
 */
export function serializeMeta(meta: unknown, maxLength = 16_384): string | null {
  if (meta === undefined || meta === null) return null

  const seen = new WeakSet<object>()

  let serialized: string
  try {
    serialized = JSON.stringify(meta, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString()
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack }
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      if (typeof value === 'function') return '[Function]'
      return value
    })
  } catch {
    return null
  }

  if (serialized === undefined) return null
  if (serialized.length <= maxLength) return serialized

  return `${serialized.slice(0, maxLength)}…[truncated ${serialized.length - maxLength} chars]`
}

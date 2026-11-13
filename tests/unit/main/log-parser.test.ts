import { describe, expect, it } from 'vitest'
import type { LogQuery } from '@shared/types/logging'
import {
  alignToLineStart,
  filterEntries,
  paginate,
  parseLogLine,
  parseLogLines,
  serializeMeta,
} from '@main/logging/log-parser'

const line = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: 1_753_800_000_000,
    level: 'info',
    scope: 'database',
    message: 'Connection established',
    meta: null,
    ...overrides,
  })

const baseQuery: LogQuery = { limit: 100, offset: 0 }

describe('parseLogLine', () => {
  it('parses a well-formed record', () => {
    const entry = parseLogLine(line(), 'file:0')

    expect(entry).not.toBeNull()
    expect(entry?.level).toBe('info')
    expect(entry?.scope).toBe('database')
    expect(entry?.message).toBe('Connection established')
    expect(entry?.id).toBe('file:0')
  })

  it('rejects malformed JSON, as produced by a torn write during rotation', () => {
    expect(parseLogLine('{"ts":175380000', 'x')).toBeNull()
    expect(parseLogLine('not json at all', 'x')).toBeNull()
  })

  it('rejects JSON that is not a record object', () => {
    expect(parseLogLine('[]', 'x')).toBeNull()
    expect(parseLogLine('null', 'x')).toBeNull()
    expect(parseLogLine('"a string"', 'x')).toBeNull()
  })

  it('rejects records missing or mistyping a required field', () => {
    expect(parseLogLine(line({ ts: 'yesterday' }), 'x')).toBeNull()
    expect(parseLogLine(line({ level: 'verbose' }), 'x')).toBeNull()
    expect(parseLogLine(line({ message: 42 }), 'x')).toBeNull()
  })

  it('defaults a missing scope rather than discarding the record', () => {
    const entry = parseLogLine(JSON.stringify({ ts: 1, level: 'warn', message: 'x' }), 'x')

    expect(entry?.scope).toBe('app')
    expect(entry?.meta).toBeNull()
  })
})

describe('parseLogLines', () => {
  it('parses every record and counts the unreadable ones', () => {
    const text = [line(), 'corrupt', line({ level: 'error' }), ''].join('\n')
    const result = parseLogLines(text, 'recoverx-2026-07-29.log')

    expect(result.entries).toHaveLength(2)
    expect(result.malformed).toBe(1)
  })

  it('builds ids that are unique within the result, for list virtualisation', () => {
    const text = [line(), line(), line()].join('\n')
    const result = parseLogLines(text, 'f.log')

    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(3)
  })

  it('offsets ids when only a tail slice of the file was read', () => {
    const result = parseLogLines(line(), 'f.log', 500)

    expect(result.entries[0]?.id).toBe('f.log:500')
  })

  it('ignores blank lines without counting them as malformed', () => {
    const result = parseLogLines(`\n\n${line()}\n\n`, 'f.log')

    expect(result.entries).toHaveLength(1)
    expect(result.malformed).toBe(0)
  })
})

describe('filterEntries', () => {
  const { entries } = parseLogLines(
    [
      line({ level: 'error', message: 'Disk read failure', scope: 'scanner' }),
      line({ level: 'info', message: 'Scan started', scope: 'scanner' }),
      line({ level: 'debug', message: 'Cache warm', scope: 'database', ts: 1_753_900_000_000 }),
    ].join('\n'),
    'f.log',
  )

  it('returns everything when no filter is set', () => {
    expect(filterEntries(entries, baseQuery)).toHaveLength(3)
  })

  it('filters by level', () => {
    expect(filterEntries(entries, { ...baseQuery, levels: ['error'] })).toHaveLength(1)
    expect(filterEntries(entries, { ...baseQuery, levels: ['error', 'info'] })).toHaveLength(2)
  })

  it('treats an empty level list as no filter', () => {
    expect(filterEntries(entries, { ...baseQuery, levels: [] })).toHaveLength(3)
  })

  it('searches message, scope and metadata case-insensitively', () => {
    expect(filterEntries(entries, { ...baseQuery, search: 'DISK' })).toHaveLength(1)
    expect(filterEntries(entries, { ...baseQuery, search: 'scanner' })).toHaveLength(2)
    expect(filterEntries(entries, { ...baseQuery, search: 'nothing here' })).toHaveLength(0)
  })

  it('filters by time range', () => {
    expect(filterEntries(entries, { ...baseQuery, sinceEpochMs: 1_753_850_000_000 })).toHaveLength(
      1,
    )
    expect(filterEntries(entries, { ...baseQuery, untilEpochMs: 1_753_850_000_000 })).toHaveLength(
      2,
    )
  })

  it('combines filters conjunctively', () => {
    expect(
      filterEntries(entries, { ...baseQuery, levels: ['error'], search: 'scan started' }),
    ).toHaveLength(0)
  })
})

describe('paginate', () => {
  const { entries } = parseLogLines(
    Array.from({ length: 10 }, (_, index) => line({ message: `m${index}` })).join('\n'),
    'f.log',
  )

  it('returns newest records first, the order an operator reads in', () => {
    const page = paginate(entries, 3, 0)

    expect(page.map((entry) => entry.message)).toEqual(['m9', 'm8', 'm7'])
  })

  it('honours the offset', () => {
    expect(paginate(entries, 2, 2).map((entry) => entry.message)).toEqual(['m7', 'm6'])
  })

  it('returns an empty page past the end rather than throwing', () => {
    expect(paginate(entries, 5, 100)).toEqual([])
  })

  it('does not mutate the input', () => {
    const before = entries.map((entry) => entry.message)
    paginate(entries, 5, 0)

    expect(entries.map((entry) => entry.message)).toEqual(before)
  })
})

describe('alignToLineStart', () => {
  it('discards a leading partial line', () => {
    const result = alignToLineStart('ial line\ncomplete line\n')

    expect(result.text).toBe('complete line\n')
    expect(result.skippedBytes).toBe(9)
  })

  it('returns the input unchanged when it contains no newline', () => {
    const result = alignToLineStart('single fragment')

    expect(result.text).toBe('single fragment')
    expect(result.skippedBytes).toBe(0)
  })
})

describe('serializeMeta', () => {
  it('serialises a plain object', () => {
    expect(serializeMeta({ path: 'C:\\data', size: 42 })).toBe('{"path":"C:\\\\data","size":42}')
  })

  it('returns null for absent metadata', () => {
    expect(serializeMeta(undefined)).toBeNull()
    expect(serializeMeta(null)).toBeNull()
  })

  it('survives circular references, which device descriptors contain', () => {
    const parent: Record<string, unknown> = { name: 'disk0' }
    parent.self = parent

    const serialized = serializeMeta(parent)

    expect(serialized).toContain('[Circular]')
    expect(serialized).toContain('disk0')
  })

  it('expands Error objects instead of emitting an empty object', () => {
    const serialized = serializeMeta({ error: new Error('read failed') })

    expect(serialized).toContain('read failed')
    expect(serialized).toContain('Error')
  })

  it('truncates oversized payloads so a buffer cannot bloat the log', () => {
    const serialized = serializeMeta({ blob: 'x'.repeat(50_000) }, 1000)

    expect(serialized).not.toBeNull()
    expect(serialized?.length).toBeLessThan(1100)
    expect(serialized).toContain('truncated')
  })

  it('replaces bigint and function values that JSON cannot represent', () => {
    const serialized = serializeMeta({ size: 10n, callback: () => undefined })

    expect(serialized).toContain('"10"')
    expect(serialized).toContain('[Function]')
  })
})

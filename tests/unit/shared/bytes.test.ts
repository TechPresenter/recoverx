import { describe, expect, it } from 'vitest'
import { formatBytes, formatBytesPerSecond, parseBytes, percentOf } from '@shared/utils/bytes'

describe('formatBytes', () => {
  it('formats using binary units by default, matching Windows Explorer', () => {
    expect(formatBytes(1024, { locale: 'en-GB' })).toBe('1.00 KiB')
    expect(formatBytes(1024 * 1024, { locale: 'en-GB' })).toBe('1.00 MiB')
    expect(formatBytes(1024 ** 3, { locale: 'en-GB' })).toBe('1.00 GiB')
  })

  it('formats using decimal units when asked, matching drive manufacturers', () => {
    expect(formatBytes(1000, { system: 'decimal', locale: 'en-GB' })).toBe('1.00 KB')
    expect(formatBytes(1_000_000_000, { system: 'decimal', locale: 'en-GB' })).toBe('1.00 GB')
  })

  it('reports the same physical drive differently under each unit system', () => {
    // A "1 TB" drive as labelled by the vendor, shown the way Windows would.
    const oneTerabyteDecimal = 1_000_000_000_000

    expect(formatBytes(oneTerabyteDecimal, { system: 'decimal', locale: 'en-GB' })).toBe('1.00 TB')
    expect(formatBytes(oneTerabyteDecimal, { system: 'binary', locale: 'en-GB' })).toBe('931 GiB')
  })

  it('adapts precision to magnitude so columns stay narrow', () => {
    expect(formatBytes(512, { locale: 'en-GB' })).toBe('512 B')
    expect(formatBytes(1024 * 1.5, { locale: 'en-GB' })).toBe('1.50 KiB')
    expect(formatBytes(1024 * 15, { locale: 'en-GB' })).toBe('15.0 KiB')
    expect(formatBytes(1024 * 150, { locale: 'en-GB' })).toBe('150 KiB')
  })

  it('degrades rather than throwing on values a render path might supply', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })

  it('caps at the largest known unit instead of producing an undefined suffix', () => {
    expect(formatBytes(1024 ** 7, { locale: 'en-GB' })).toContain('PiB')
  })

  it('omits the unit when asked', () => {
    expect(formatBytes(2048, { withUnit: false, locale: 'en-GB' })).toBe('2.00')
  })
})

describe('formatBytesPerSecond', () => {
  it('appends a rate suffix', () => {
    expect(formatBytesPerSecond(1024 * 1024 * 128, { locale: 'en-GB' })).toBe('128 MiB/s')
  })

  it('returns a zero rate for non-positive input', () => {
    expect(formatBytesPerSecond(0)).toBe('0 B/s')
    expect(formatBytesPerSecond(Number.NaN)).toBe('0 B/s')
  })
})

describe('parseBytes', () => {
  it('parses decimal and binary suffixes', () => {
    expect(parseBytes('500 MB')).toBe(500 * 1000 ** 2)
    expect(parseBytes('1.5GiB')).toBe(Math.round(1.5 * 1024 ** 3))
    expect(parseBytes('2 tb')).toBe(2 * 1000 ** 4)
  })

  it('treats a bare number as bytes', () => {
    expect(parseBytes('2048')).toBe(2048)
    expect(parseBytes('  4096  ')).toBe(4096)
  })

  it('returns null for input a user could plausibly mistype', () => {
    expect(parseBytes('')).toBeNull()
    expect(parseBytes('abc')).toBeNull()
    expect(parseBytes('-5 MB')).toBeNull()
    expect(parseBytes('5 XB')).toBeNull()
    expect(parseBytes('5 MB extra')).toBeNull()
  })
})

describe('percentOf', () => {
  it('computes a percentage', () => {
    expect(percentOf(25, 100)).toBe(25)
    expect(percentOf(1, 3)).toBeCloseTo(33.333, 3)
  })

  it('clamps into 0-100 and survives a zero total', () => {
    expect(percentOf(150, 100)).toBe(100)
    expect(percentOf(-1, 100)).toBe(0)
    expect(percentOf(1, 0)).toBe(0)
    expect(percentOf(Number.NaN, 100)).toBe(0)
  })
})

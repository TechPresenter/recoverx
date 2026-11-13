import { describe, expect, it } from 'vitest'
import {
  TIME_CONSTANTS,
  estimateRemainingMs,
  formatDuration,
  formatDurationLong,
  formatRelativeTime,
  formatTimestamp,
  startOfLocalDay,
} from '@shared/utils/time'

const { MS_PER_SECOND, MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } = TIME_CONSTANTS

describe('formatDuration', () => {
  it('renders a compact clock string at each magnitude', () => {
    expect(formatDuration(45 * MS_PER_SECOND)).toBe('45s')
    expect(formatDuration(2 * MS_PER_MINUTE + 5 * MS_PER_SECOND)).toBe('2m 05s')
    expect(formatDuration(2 * MS_PER_HOUR + 30 * MS_PER_MINUTE)).toBe('2h 30m')
    expect(formatDuration(2 * MS_PER_DAY + 7 * MS_PER_HOUR)).toBe('2d 7h')
  })

  it('pads seconds and minutes so a live counter does not jitter in width', () => {
    expect(formatDuration(MS_PER_MINUTE + MS_PER_SECOND)).toBe('1m 01s')
    expect(formatDuration(MS_PER_HOUR + 5 * MS_PER_MINUTE)).toBe('1h 05m')
  })

  it('collapses sub-second values rather than showing 0s', () => {
    expect(formatDuration(0)).toBe('<1s')
    expect(formatDuration(999)).toBe('<1s')
  })

  it('returns a placeholder for values that cannot be a duration', () => {
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('formatDurationLong', () => {
  it('spells out units for screen readers', () => {
    expect(formatDurationLong(MS_PER_MINUTE + 5 * MS_PER_SECOND)).toBe('1 minute 5 seconds')
    expect(formatDurationLong(2 * MS_PER_HOUR)).toBe('2 hours')
  })

  it('always names at least one unit', () => {
    expect(formatDurationLong(0)).toBe('0 seconds')
  })

  it('handles invalid input', () => {
    expect(formatDurationLong(-5)).toBe('unknown')
  })
})

describe('estimateRemainingMs', () => {
  it('extrapolates from the observed rate', () => {
    // 250 of 1000 units done in 10s => 30s remaining.
    expect(estimateRemainingMs(250, 1000, 10 * MS_PER_SECOND)).toBe(30 * MS_PER_SECOND)
  })

  it('withholds an estimate until the sample is meaningful', () => {
    // A wildly wrong ETA in the first second destroys trust more than none.
    expect(estimateRemainingMs(10, 1000, 500)).toBeNull()
    expect(estimateRemainingMs(0, 1000, 10_000)).toBeNull()
    expect(estimateRemainingMs(10, 0, 10_000)).toBeNull()
  })

  it('reports zero once the work is complete', () => {
    expect(estimateRemainingMs(1000, 1000, 10_000)).toBe(0)
    expect(estimateRemainingMs(1200, 1000, 10_000)).toBe(0)
  })

  it('rejects non-finite input', () => {
    expect(estimateRemainingMs(Number.NaN, 1000, 10_000)).toBeNull()
  })
})

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0)

  it('describes recent moments as "just now"', () => {
    expect(formatRelativeTime(now - 1000, now, 'en-GB')).toBe('just now')
    expect(formatRelativeTime(now, now, 'en-GB')).toBe('just now')
  })

  it('scales the unit to the distance', () => {
    expect(formatRelativeTime(now - 3 * MS_PER_MINUTE, now, 'en-GB')).toContain('3 minutes ago')
    expect(formatRelativeTime(now - 5 * MS_PER_HOUR, now, 'en-GB')).toContain('5 hours ago')
    expect(formatRelativeTime(now + 2 * MS_PER_DAY, now, 'en-GB')).toContain('2 days')
  })

  it('returns a placeholder for a non-finite timestamp', () => {
    expect(formatRelativeTime(Number.NaN, now)).toBe('—')
  })
})

describe('formatTimestamp', () => {
  it('returns a placeholder rather than "Invalid Date"', () => {
    expect(formatTimestamp(Number.NaN)).toBe('—')
  })

  it('formats a real timestamp', () => {
    expect(formatTimestamp(Date.UTC(2026, 6, 29, 12, 0, 0), 'en-GB')).toContain('2026')
  })
})

describe('startOfLocalDay', () => {
  it('zeroes the time component in local time', () => {
    const midnight = startOfLocalDay(Date.now())
    const asDate = new Date(midnight)

    expect(asDate.getHours()).toBe(0)
    expect(asDate.getMinutes()).toBe(0)
    expect(asDate.getSeconds()).toBe(0)
    expect(asDate.getMilliseconds()).toBe(0)
  })
})

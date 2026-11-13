/**
 * Duration and timestamp formatting.
 *
 * All timestamps in RecoverX are stored and transported as epoch
 * milliseconds (a plain `number`). That survives structured cloning without the
 * `Date` reconstruction cost, sorts numerically in SQLite, and removes an entire
 * class of timezone bugs from the persistence layer — formatting happens once,
 * at the edge, in the user's locale.
 */

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60 * MS_PER_SECOND
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

/**
 * Format a duration as a compact clock string.
 *
 *   45_000     -> "45s"
 *   125_000    -> "2m 05s"
 *   9_000_000  -> "2h 30m"
 *   200_000_000 -> "2d 7h"
 *
 * Used for scan ETA and elapsed time, where the value updates several times a
 * second — hence the manual assembly rather than `Intl.RelativeTimeFormat`.
 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  if (milliseconds < MS_PER_SECOND) return '<1s'

  const days = Math.floor(milliseconds / MS_PER_DAY)
  const hours = Math.floor((milliseconds % MS_PER_DAY) / MS_PER_HOUR)
  const minutes = Math.floor((milliseconds % MS_PER_HOUR) / MS_PER_MINUTE)
  const seconds = Math.floor((milliseconds % MS_PER_MINUTE) / MS_PER_SECOND)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/**
 * Format a duration in long form for screen readers and tooltips.
 * `125_000` -> "2 minutes 5 seconds"
 */
export function formatDurationLong(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown'

  const parts: string[] = []
  const days = Math.floor(milliseconds / MS_PER_DAY)
  const hours = Math.floor((milliseconds % MS_PER_DAY) / MS_PER_HOUR)
  const minutes = Math.floor((milliseconds % MS_PER_HOUR) / MS_PER_MINUTE)
  const seconds = Math.floor((milliseconds % MS_PER_MINUTE) / MS_PER_SECOND)

  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`)
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`)
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`)
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`)
  }

  return parts.join(' ')
}

/** Absolute timestamp in the user's locale, e.g. `29 Jul 2026, 14:03`. */
export function formatTimestamp(epochMs: number, locale?: string): string {
  if (!Number.isFinite(epochMs)) return '—'
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(epochMs))
}

/** Millisecond-precision timestamp, used in the Logs screen. */
export function formatLogTimestamp(epochMs: number, locale?: string): string {
  if (!Number.isFinite(epochMs)) return '—'
  const date = new Date(epochMs)
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

const RELATIVE_THRESHOLDS: ReadonlyArray<
  [limit: number, divisor: number, unit: Intl.RelativeTimeFormatUnit]
> = [
  [MS_PER_MINUTE, MS_PER_SECOND, 'second'],
  [MS_PER_HOUR, MS_PER_MINUTE, 'minute'],
  [MS_PER_DAY, MS_PER_HOUR, 'hour'],
  [30 * MS_PER_DAY, MS_PER_DAY, 'day'],
  [365 * MS_PER_DAY, 30 * MS_PER_DAY, 'month'],
  [Number.POSITIVE_INFINITY, 365 * MS_PER_DAY, 'year'],
]

/**
 * Relative time such as "3 minutes ago" or "in 2 days".
 *
 * `now` is injectable so tests are deterministic without faking timers.
 */
export function formatRelativeTime(
  epochMs: number,
  now: number = Date.now(),
  locale?: string,
): string {
  if (!Number.isFinite(epochMs)) return '—'

  const delta = epochMs - now
  const magnitude = Math.abs(delta)
  if (magnitude < 5 * MS_PER_SECOND) return 'just now'

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  for (const [limit, divisor, unit] of RELATIVE_THRESHOLDS) {
    if (magnitude < limit) {
      return formatter.format(Math.round(delta / divisor), unit)
    }
  }

  return formatter.format(Math.round(delta / (365 * MS_PER_DAY)), 'year')
}

/**
 * Estimate remaining time from observed progress.
 *
 * Returns `null` while the sample is too small to be meaningful — showing a wildly
 * wrong ETA in the first second of a scan destroys user trust more than showing
 * none at all.
 */
export function estimateRemainingMs(
  processed: number,
  total: number,
  elapsedMs: number,
): number | null {
  if (!Number.isFinite(processed) || !Number.isFinite(total) || !Number.isFinite(elapsedMs))
    return null
  if (processed <= 0 || total <= 0 || elapsedMs < 2 * MS_PER_SECOND) return null
  if (processed >= total) return 0

  const rate = processed / elapsedMs
  if (rate <= 0) return null

  return Math.round((total - processed) / rate)
}

/** Start-of-day epoch for a given timestamp, in local time. Used by date filters. */
export function startOfLocalDay(epochMs: number): number {
  const date = new Date(epochMs)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export const TIME_CONSTANTS = {
  MS_PER_SECOND,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
} as const

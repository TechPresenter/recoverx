import { LicenseError } from './errors'

/**
 * Turning an operator's idea of "when this licence ends" into an instant.
 *
 * Shared by the admin CLI and the admin HTTP API, so `--expires 2027-03-31` on
 * the command line and `"expires": "2027-03-31"` from a payment webhook can
 * never mean two different moments.
 */

/** A day as the server counts it: 24 hours of UTC, with no calendar in between. */
export const DAY_MS = 86_400_000

/** Upper bound on a term, mostly to catch a misplaced digit. */
export const MAX_TERM_DAYS = 36_500

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u

/** An ISO 8601 instant with an explicit zone; a zone-less time is ambiguous. */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u

/**
 * Parse an expiry date.
 *
 * A bare date means the licence works *through* that day, everywhere in the
 * world it is still that day in UTC: it ends at 23:59:59.999 UTC. That is what
 * a customer who reads "valid until 31 March" on an invoice expects, and it is
 * the reading that never ends a term early.
 */
export function parseExpiryDate(text: string): number {
  const trimmed = text.trim()
  const dateOnly = DATE_ONLY.exec(trimmed)

  if (dateOnly !== null) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (!isCalendarDate(year, month, day)) throw invalid(`${trimmed} is not a real date.`)

    return Date.UTC(year, month - 1, day, 23, 59, 59, 999)
  }

  const dateTime = DATE_TIME.exec(trimmed)

  if (dateTime !== null) {
    // V8's `Date.parse` refuses an impossible hour or offset but rolls an
    // impossible day forward: 2027-02-30T12:00Z parses as 2 March. The date
    // part is therefore checked on its own digits first, which also keeps
    // ISO 8601's `T24:00` (the end of that day) valid.
    if (!isCalendarDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) {
      throw invalid(`${trimmed} is not a real date.`)
    }

    const instant = Date.parse(trimmed)
    if (Number.isFinite(instant)) return instant
  }

  throw invalid(
    `"${trimmed}" is not a date. Use YYYY-MM-DD, or a full ISO 8601 time with a zone such as 2027-03-31T12:00:00Z.`,
  )
}

/**
 * Whether year-month-day names a day that exists.
 *
 * `Date.UTC` silently rolls 2027-02-30 over into March, so round-tripping the
 * fields is what catches a date that does not exist.
 */
function isCalendarDate(year: number, month: number, day: number): boolean {
  const check = new Date(Date.UTC(year, month - 1, day))
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  )
}

/** `days` from `from`. */
export function addDays(from: number, days: number): number {
  return from + days * DAY_MS
}

export interface TermInput {
  readonly expires?: string | undefined
  readonly days?: number | undefined
}

/**
 * Resolve the expiry of a new licence: an absolute date, a term, or neither.
 *
 * Returns `null` for perpetual. A date already in the past is refused, because
 * minting a licence that is expired on arrival is always a typo.
 */
export function resolveNewExpiry(input: TermInput, now: number): number | null {
  if (input.expires !== undefined && input.days !== undefined) {
    throw invalid('Give an expiry date or a number of days, not both.')
  }

  if (input.days !== undefined) return addDays(now, checkedDays(input.days))

  if (input.expires !== undefined) {
    const instant = parseExpiryDate(input.expires)
    if (instant <= now) throw invalid('The expiry date is already in the past.')
    return instant
  }

  return null
}

export interface ExtensionInput extends TermInput {
  readonly perpetual?: boolean | undefined
}

/**
 * Resolve a renewal.
 *
 * `days` extends from whichever is later, now or the current expiry. A customer
 * who renews a month early keeps the month they already paid for; one who
 * renews a month late does not get a month they did not pay for back-dated.
 */
export function resolveExtension(
  input: ExtensionInput,
  current: number | null,
  now: number,
): number | null {
  const chosen = [input.expires !== undefined, input.days !== undefined, input.perpetual === true]
  const count = chosen.filter(Boolean).length

  if (count !== 1) {
    throw invalid('Give exactly one of: an expiry date, a number of days, or perpetual.')
  }

  if (input.perpetual === true) return null

  if (input.days !== undefined) {
    if (current === null) {
      throw invalid(
        'This licence is perpetual, so there is no term to extend. Set an expiry date instead if you mean to limit it.',
      )
    }
    return addDays(Math.max(now, current), checkedDays(input.days))
  }

  const instant = parseExpiryDate(input.expires ?? '')
  if (instant <= now) throw invalid('The expiry date is already in the past.')
  return instant
}

function checkedDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > MAX_TERM_DAYS) {
    throw invalid(`The number of days must be a whole number from 1 to ${MAX_TERM_DAYS}.`)
  }
  return days
}

function invalid(message: string): LicenseError {
  return new LicenseError('invalid-argument', message)
}

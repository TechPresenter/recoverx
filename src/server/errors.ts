import { AppError, ErrorCode } from '@shared/utils/errors'

/**
 * Refusals the licensing rules can produce.
 *
 * Each one maps to exactly one HTTP status, and the mapping lives here rather
 * than in the HTTP layer so the admin CLI, the HTTP API and the tests all agree
 * on what kind of failure a refusal is. The reason string is what goes to the
 * audit log and the structured request log; the message is what the customer
 * (or, for admin refusals, the operator) reads.
 */
export type Refusal =
  /** The body was missing a field or had one of the wrong type. */
  | 'bad-request'
  /** The client asked to activate some other product. */
  | 'wrong-product'
  /** The key failed its local shape or checksum test. */
  | 'invalid-key'
  /** The machine identifier is not one the desktop client could have produced. */
  | 'invalid-machine'
  /** A well-formed key that was never issued. */
  | 'unknown-key'
  | 'revoked'
  | 'expired'
  /** Every seat is held by another machine. */
  | 'seats-exhausted'
  /**
   * The customer has moved this licence between computers as often as the
   * self-service allowance permits. The seat was NOT released; the desktop
   * client keeps its licence and shows the sentence instead.
   */
  | 'self-release-limit'
  /** A deactivation token that could not be parsed. */
  | 'invalid-token'
  /** A deactivation token whose signature is not ours. */
  | 'forged-token'
  /** An admin operation named something that does not exist. */
  | 'not-found'
  /** An admin operation was given an argument the rules do not allow. */
  | 'invalid-argument'

const STATUS: Readonly<Record<Refusal, number>> = {
  'bad-request': 400,
  'wrong-product': 400,
  'invalid-key': 400,
  'invalid-machine': 400,
  'invalid-token': 400,
  'invalid-argument': 400,
  revoked: 403,
  expired: 403,
  'forged-token': 403,
  'unknown-key': 404,
  'not-found': 404,
  'seats-exhausted': 409,
  // 409 rather than 403 or 429: nothing is wrong with the licence and waiting
  // a minute will not help. The request conflicts with the licence's history,
  // and the desktop client reads exactly this status as "refused — keep the
  // licence", so it must never be reused for a refusal that should let the
  // client forget its activation. A build that releases seats but predates
  // that reading takes any 409 as final and deletes its licence while the
  // seat stays held here — which is why the allowance is only switched on
  // once the application that reads it is out (docs/LICENSE-SERVER.md,
  // "Turning it on: the application first").
  'self-release-limit': 409,
}

function errorCodeFor(status: number): ErrorCode {
  switch (status) {
    case 403:
      return ErrorCode.PermissionDenied
    case 404:
      return ErrorCode.NotFound
    case 409:
      return ErrorCode.Conflict
    default:
      return ErrorCode.Validation
  }
}

/**
 * The licence and machine a refusal concerns, when the rules learned them from
 * a signed token rather than from the request body — so the request log can
 * name them (masked) even though the handler never saw them.
 */
export interface RefusalSubject {
  readonly key: string
  readonly machineId: string
}

/**
 * A request the licensing rules refused.
 *
 * Extends `AppError` so it carries the same `code` and `retryable` contract as
 * every other failure in the codebase; adds the refusal reason and the HTTP
 * status, which only the licence server needs.
 */
export class LicenseError extends AppError {
  readonly refusal: Refusal
  readonly status: number
  readonly subject: RefusalSubject | undefined

  constructor(refusal: Refusal, message: string, details?: string, subject?: RefusalSubject) {
    const status = STATUS[refusal]
    super(errorCodeFor(status), message, { details, retryable: false })
    this.name = 'LicenseError'
    this.refusal = refusal
    this.status = status
    this.subject = subject
  }
}

export function isLicenseError(value: unknown): value is LicenseError {
  return value instanceof LicenseError
}

/**
 * Whether a thrown value is SQLite reporting a lock it could not acquire.
 *
 * `node:sqlite` exposes the extended result code as `errcode`; its low byte is
 * the primary code, and both `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6) mean
 * "another connection holds the write lock — try again", which the HTTP layer
 * turns into a 503 with `Retry-After` rather than a 500.
 */
export function isDatabaseBusy(value: unknown): boolean {
  let current: unknown = value

  // `withTransaction` and `databaseError` may wrap the driver error.
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object' && 'errcode' in current) {
      const code = current.errcode
      if (typeof code === 'number') {
        // SQLite packs the primary result code into the low byte.
        const primary = code & 0xff
        if (primary === 5 || primary === 6) return true
      }
    }

    current = current instanceof Error ? current.cause : undefined
  }

  return false
}

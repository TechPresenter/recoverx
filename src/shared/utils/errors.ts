/**
 * Cross-process error model.
 *
 * An `Error` instance cannot survive Electron's structured-clone IPC boundary
 * with its prototype, stack policy or custom fields intact. Every failure that
 * crosses a process boundary is therefore normalised into `SerializedError`,
 * which is plain data, and re-hydrated on the renderer side purely for display.
 */

export const ErrorCode = {
  /** Fallback for anything that was not classified. */
  Unknown: 'UNKNOWN',
  /** Payload failed schema validation at an IPC boundary. */
  Validation: 'VALIDATION',
  /** A requested entity (setting key, log file, device) does not exist. */
  NotFound: 'NOT_FOUND',
  /** The OS refused the operation — typically a missing elevation token. */
  PermissionDenied: 'PERMISSION_DENIED',
  /** SQLite reported a failure (constraint, corruption, locked file). */
  Database: 'DATABASE',
  /** Filesystem or block-device I/O failure. */
  Io: 'IO',
  /** The operation is not supported on this platform or filesystem. */
  Unsupported: 'UNSUPPORTED',
  /** The operation conflicts with current state (e.g. scan already running). */
  Conflict: 'CONFLICT',
  /** The operation exceeded its deadline. */
  Timeout: 'TIMEOUT',
  /** The operation was cancelled by the user. */
  Cancelled: 'CANCELLED',
  /** A guard rejected the request for safety reasons (see SecurityViolation). */
  SecurityViolation: 'SECURITY_VIOLATION',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** Plain-data error shape. Safe to send over IPC and to persist. */
export interface SerializedError {
  readonly code: ErrorCode
  readonly message: string
  /** Operator-facing detail. Never contains file contents or user data. */
  readonly details?: string | undefined
  /** `true` when retrying the identical request could plausibly succeed. */
  readonly retryable: boolean
}

/**
 * Application error carrying a machine-readable code.
 *
 * Throw this from services; the IPC registry converts it into a
 * `SerializedError` automatically.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details: string | undefined
  readonly retryable: boolean

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: string | undefined; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.details = options.details
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code)
  }

  toSerialized(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    }
  }
}

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.Io,
  ErrorCode.Timeout,
  ErrorCode.Database,
])

/** Narrow an unknown catch binding to `AppError`. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/** Narrow an unknown value to the plain `SerializedError` shape. */
export function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}

/**
 * Convert any thrown value into a `SerializedError`.
 *
 * The `stack` is deliberately dropped: it is written to the log file by the
 * caller, but shipping it to the renderer would leak absolute filesystem paths
 * into the UI and into user-submitted screenshots.
 */
export function toSerializedError(
  value: unknown,
  fallbackMessage = 'Unexpected error',
): SerializedError {
  if (isAppError(value)) return value.toSerialized()
  if (isSerializedError(value)) return value

  if (value instanceof Error) {
    return {
      code: ErrorCode.Unknown,
      message: value.message || fallbackMessage,
      details: value.name,
      retryable: false,
    }
  }

  if (typeof value === 'string' && value.length > 0) {
    return { code: ErrorCode.Unknown, message: value, details: undefined, retryable: false }
  }

  return { code: ErrorCode.Unknown, message: fallbackMessage, details: undefined, retryable: false }
}

/** Extract a printable message from any thrown value, without allocating an Error. */
export function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return 'unknown error'
}

import type { ZodType } from 'zod'
import { AppError, ErrorCode } from './errors'
import { type Result, err, ok } from './result'

/**
 * Schema-checked JSON decoding.
 *
 * Every string that reaches the application from outside its own memory — a
 * SQLite settings row, a log line, an update manifest — is decoded here. The
 * `no-restricted-syntax` ESLint rule forbids bare `JSON.parse` everywhere else,
 * so a corrupted persisted value can never produce an object of an unexpected
 * shape that then propagates silently through the app.
 */
export function parseJson<T>(raw: string, schema: ZodType<T>): Result<T> {
  let decoded: unknown
  try {
    // eslint-disable-next-line no-restricted-syntax -- the single sanctioned JSON.parse call site
    decoded = JSON.parse(raw)
  } catch {
    return err(
      new AppError(ErrorCode.Validation, 'Value is not valid JSON', {
        details: raw.length > 120 ? `${raw.slice(0, 120)}…` : raw,
      }).toSerialized(),
    )
  }

  const parsed = schema.safeParse(decoded)
  if (!parsed.success) {
    return err(
      new AppError(ErrorCode.Validation, 'Value did not match the expected schema', {
        details: formatZodIssues(parsed.error.issues),
      }).toSerialized(),
    )
  }

  return ok(parsed.data)
}

/**
 * Validate an already-decoded value against a schema.
 * Used by the IPC registry, where the payload arrives structured-cloned.
 */
export function parseValue<T>(value: unknown, schema: ZodType<T>): Result<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    return err(
      new AppError(ErrorCode.Validation, 'Payload failed validation', {
        details: formatZodIssues(parsed.error.issues),
      }).toSerialized(),
    )
  }
  return ok(parsed.data)
}

/** Collapse Zod issues into a single compact, log-safe line. */
export function formatZodIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * Serialise a value for storage. Kept alongside `parseJson` so both halves of
 * the codec stay in one place.
 */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value)
}

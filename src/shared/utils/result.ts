import { type SerializedError, toSerializedError } from './errors'

/**
 * Explicit success/failure envelope used for every value that crosses the IPC
 * boundary.
 *
 * Rejected promises lose their type information across Electron's bridge and
 * force `try/catch` on every call site in the renderer. Returning a discriminated
 * union instead makes failure handling a compile-time obligation: the renderer
 * cannot read `.data` without first narrowing on `.ok`.
 */
export type Result<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SerializedError }

/** Build a successful result. */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

/** Build a failed result from an already-serialised error. */
export function err<T = never>(error: SerializedError): Result<T> {
  return { ok: false, error }
}

/** Build a failed result from an arbitrary thrown value. */
export function errFrom<T = never>(value: unknown, fallbackMessage?: string): Result<T> {
  return { ok: false, error: toSerializedError(value, fallbackMessage) }
}

/** Type guard narrowing a result to its success branch. */
export function isOk<T>(result: Result<T>): result is { ok: true; data: T } {
  return result.ok
}

/** Type guard narrowing a result to its failure branch. */
export function isErr<T>(result: Result<T>): result is { ok: false; error: SerializedError } {
  return !result.ok
}

/** Return the contained value, or `fallback` when the result is a failure. */
export function unwrapOr<T>(result: Result<T>, fallback: T): T {
  return result.ok ? result.data : fallback
}

/** Apply `fn` to a successful value, propagating failures untouched. */
export function mapResult<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
  return result.ok ? ok(fn(result.data)) : result
}

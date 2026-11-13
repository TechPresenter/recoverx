/**
 * Small, dependency-free type guards used across both processes.
 */

/** Narrows out `null` and `undefined`. Useful as an `Array.prototype.filter` predicate. */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

/** `true` for a string containing at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** `true` for a finite, non-NaN number. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** `true` for a plain object (excludes null, arrays and class instances). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Compile-time exhaustiveness check.
 *
 * Place in the `default` branch of a switch over a union: adding a new member
 * without handling it then becomes a type error rather than a silent fallthrough.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`)
}

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

/** Typed `Object.keys` for objects with a known, closed key set. */
export function typedKeys<T extends object>(value: T): Array<keyof T> {
  return Object.keys(value) as Array<keyof T>
}

/** Typed `Object.entries` for objects with a known, closed key set. */
export function typedEntries<T extends object>(value: T): Array<[keyof T, T[keyof T]]> {
  return Object.entries(value) as Array<[keyof T, T[keyof T]]>
}

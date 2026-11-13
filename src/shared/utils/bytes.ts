/**
 * Byte-size formatting and parsing.
 *
 * Storage vendors label capacity in decimal units (1 TB = 10^12 bytes) while
 * Windows reports the same device in binary units (1 TiB = 2^40 bytes). A
 * recovery tool has to show both without ambiguity, so the unit system is an
 * explicit argument rather than a hidden assumption.
 */

export type ByteUnitSystem = 'binary' | 'decimal'

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const
const DECIMAL_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export interface FormatBytesOptions {
  /** Unit system to render in. Defaults to `binary`, matching Windows Explorer. */
  system?: ByteUnitSystem
  /** Fractional digits. Defaults to an adaptive 0–2 based on magnitude. */
  precision?: number
  /** When `false`, the unit suffix is omitted. Defaults to `true`. */
  withUnit?: boolean
  /** BCP-47 locale used for digit grouping. Defaults to the runtime locale. */
  locale?: string
}

/**
 * Format a byte count for display.
 *
 * Negative and non-finite inputs collapse to `0 B` rather than throwing: this
 * function is called from render paths where a bad value must degrade visually,
 * not tear down a React subtree.
 */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  const { system = 'binary', precision, withUnit = true, locale } = options

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return withUnit ? '0 B' : '0'
  }

  const base = system === 'binary' ? 1024 : 1000
  const units = system === 'binary' ? BINARY_UNITS : DECIMAL_UNITS

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1)
  const value = bytes / Math.pow(base, exponent)

  // Adaptive precision keeps columns narrow: `931 GiB` reads better than
  // `931.00 GiB`, but `1.5 GiB` must not round to `2 GiB`.
  const digits = precision ?? (exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2)

  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)

  return withUnit ? `${formatted} ${units[exponent] ?? 'B'}` : formatted
}

/**
 * Format a transfer rate, e.g. `128 MiB/s`.
 */
export function formatBytesPerSecond(
  bytesPerSecond: number,
  options: FormatBytesOptions = {},
): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSecond, options)}/s`
}

const SIZE_PATTERN = /^\s*([0-9]*\.?[0-9]+)\s*(b|kb|mb|gb|tb|pb|kib|mib|gib|tib|pib)?\s*$/i

const UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  pb: 1000 ** 5,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
}

/**
 * Parse a human-written size such as `500 MB`, `1.5GiB` or `2048`.
 *
 * Returns `null` for anything unparseable so callers can surface a field-level
 * validation message. A bare number is interpreted as bytes.
 */
export function parseBytes(input: string): number | null {
  const match = SIZE_PATTERN.exec(input)
  if (!match) return null

  const [, rawValue, rawUnit] = match
  if (rawValue === undefined) return null

  const value = Number.parseFloat(rawValue)
  if (!Number.isFinite(value) || value < 0) return null

  const multiplier = UNIT_MULTIPLIERS[(rawUnit ?? 'b').toLowerCase()]
  if (multiplier === undefined) return null

  return Math.round(value * multiplier)
}

/** Percentage of `total` represented by `part`, clamped to 0–100. */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, (part / total) * 100))
}

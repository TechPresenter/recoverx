import type { ByteUnitSystem } from '@shared/utils/bytes'
import { formatBytes, formatBytesPerSecond } from '@shared/utils/bytes'
import { formatDuration, formatRelativeTime, formatTimestamp } from '@shared/utils/time'

/**
 * Presentation helpers bound to the user's current locale and unit preference.
 *
 * The pure formatters live in the shared kernel so the main process can use them
 * in logs; these wrappers apply the settings the renderer knows about, keeping
 * every call site free of the same two arguments.
 */

export interface FormatContext {
  readonly locale: string
  readonly byteUnitSystem: ByteUnitSystem
}

export function createFormatters(context: FormatContext) {
  const { locale, byteUnitSystem: system } = context

  return {
    bytes: (value: number): string => formatBytes(value, { system, locale }),
    bytesPerSecond: (value: number): string => formatBytesPerSecond(value, { system, locale }),
    duration: (milliseconds: number): string => formatDuration(milliseconds),
    timestamp: (epochMs: number): string => formatTimestamp(epochMs, locale),
    relative: (epochMs: number, now?: number): string => formatRelativeTime(epochMs, now, locale),
    percent: (value: number, fractionDigits = 0): string =>
      new Intl.NumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(value / 100),
    number: (value: number): string => new Intl.NumberFormat(locale).format(value),
  }
}

export type Formatters = ReturnType<typeof createFormatters>

/** Map an application language to a BCP-47 locale for `Intl`. */
export function toLocale(language: string): string {
  switch (language) {
    case 'es':
      return 'es-ES'
    default:
      return 'en-GB'
  }
}

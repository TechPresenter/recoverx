import { useMemo } from 'react'
import { createFormatters, toLocale, type Formatters } from '@/lib/format'
import { useSettingsStore } from '@/stores/settings.store'

/**
 * Locale- and unit-aware formatters.
 *
 * Memoised on the two settings that affect output, so the `Intl` objects inside
 * — which are comparatively expensive to construct — are built once per
 * preference change rather than on every render of every row.
 */
export function useFormatters(): Formatters {
  const language = useSettingsStore((state) => state.settings?.language ?? 'en')
  const byteUnitSystem = useSettingsStore((state) => state.settings?.byteUnitSystem ?? 'binary')

  return useMemo(
    () => createFormatters({ locale: toLocale(language), byteUnitSystem }),
    [language, byteUnitSystem],
  )
}

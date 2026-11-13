import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Language } from '@shared/types/settings'
import { en } from './locales/en'
import { es } from './locales/es'
import type { Translation } from './types'

/**
 * Internationalisation.
 *
 * Locales are bundled rather than fetched: the renderer runs from a custom
 * scheme with no network access, and a language switch must be instantaneous —
 * an HTTP backend would add a loading state to something that should be free.
 *
 * The bundle cost is small (a few kilobytes per language) and the entire set is
 * tree-shaken into the vendor-i18n chunk, away from the first-paint path.
 */

const resources: Record<Language, { translation: Translation }> = {
  en: { translation: en },
  es: { translation: es },
}

/** Languages offered in Settings, with their names written in themselves. */
export const AVAILABLE_LANGUAGES: ReadonlyArray<{ code: Language; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
]

let initialized = false

/**
 * Initialise i18next. Safe to call more than once.
 *
 * Called before the first render so no component ever sees a raw key.
 */
export function initializeI18n(language: Language): typeof i18next {
  if (initialized) {
    void i18next.changeLanguage(language)
    return i18next
  }

  void i18next.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'en',
    defaultNS: 'translation',
    interpolation: {
      // React escapes interpolated values already; doing it twice turns an
      // apostrophe in a file path into `&#39;`.
      escapeValue: false,
    },
    returnNull: false,
    // Locales are compiled in, so a missing key is a build-time error, not a
    // runtime one worth logging on every render.
    saveMissing: false,
  })

  initialized = true
  return i18next
}

/** Switch the active language. */
export async function setLanguage(language: Language): Promise<void> {
  await i18next.changeLanguage(language)
}

export { default as i18n } from 'i18next'

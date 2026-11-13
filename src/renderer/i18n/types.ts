import type { en } from './locales/en'

/**
 * Structural contract every locale must satisfy.
 *
 * `en` is declared `as const`, so its property types are string *literals*.
 * Widening them here is what lets another locale supply different text while
 * still being checked for a missing or misspelled key — assigning `Translation`
 * to a locale object turns an incomplete translation into a compile error.
 */
export type Translation = Widen<typeof en>

type Widen<T> = {
  [K in keyof T]: T[K] extends string ? string : Widen<T[K]>
}

/**
 * Teach i18next the key space.
 *
 * With this augmentation, `t('settings.theme')` is autocompleted and
 * `t('settings.thmee')` fails to compile.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: {
      translation: Translation
    }
    returnNull: false
  }
}

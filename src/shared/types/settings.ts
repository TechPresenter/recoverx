import { z } from 'zod'

/**
 * User settings — the single source of truth for shape, validation and defaults.
 *
 * The Zod schema is authoritative in both directions: the renderer validates
 * before sending a patch, and the main process re-validates before persisting.
 * The TypeScript types are inferred from the schema, so a field can never drift
 * between validation and compilation.
 */

export const ThemeModeSchema = z.enum(['system', 'light', 'dark'])
export type ThemeMode = z.infer<typeof ThemeModeSchema>

export const AccentColorSchema = z.enum(['blue', 'violet', 'emerald', 'amber', 'rose'])
export type AccentColor = z.infer<typeof AccentColorSchema>

/**
 * Shipping languages.
 *
 * Adding one is a locale file plus an entry here — the UI enumerates this list
 * rather than hard-coding options, so nothing else has to change. Only languages
 * with a complete, reviewed translation are listed: a partially translated UI
 * that falls back to English mid-sentence reads worse than English throughout.
 */
export const LanguageSchema = z.enum(['en', 'es'])
export type Language = z.infer<typeof LanguageSchema>

export const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug'])
export type LogLevel = z.infer<typeof LogLevelSchema>

export const ByteUnitSystemSchema = z.enum(['binary', 'decimal'])

export const AppSettingsSchema = z.object({
  // --- Appearance ---------------------------------------------------------
  theme: ThemeModeSchema,
  accent: AccentColorSchema,
  language: LanguageSchema,
  /** Collapses vertical rhythm for dense result grids on small displays. */
  compactDensity: z.boolean(),
  /** Honoured in addition to the OS `prefers-reduced-motion` signal. */
  reduceMotion: z.boolean(),
  /** Whether sizes render as GiB (binary) or GB (decimal). */
  byteUnitSystem: ByteUnitSystemSchema,

  // --- Safety -------------------------------------------------------------
  /**
   * Destination folder for recovered files. Writing recovered data back onto the
   * source device would overwrite the very sectors still holding unrecovered
   * files, so this path is validated to live on a different volume before any
   * recovery job starts.
   */
  defaultRecoveryPath: z.string(),
  /** Require an explicit confirmation step for irreversible operations. */
  confirmDestructiveActions: z.boolean(),

  // --- Diagnostics --------------------------------------------------------
  logLevel: LogLevelSchema,
  logRetentionDays: z.number().int().min(1).max(90),
  /**
   * Reserved; nothing reads it. It was the switch for anonymous crash and
   * usage reporting, which was never built: crash reports and logs stay on the
   * computer unless the user sends them to support. The switch is no longer
   * shown, because it claimed to send data that nothing sends.
   *
   * Kept in the schema rather than removed, so the settings contract stays
   * exactly what earlier versions wrote and read. If a sender is ever added, it
   * must be off by default, read this setting, and be described in the privacy
   * policy before it ships.
   */
  telemetryEnabled: z.boolean(),

  // --- Application --------------------------------------------------------
  autoCheckUpdates: z.boolean(),
  /**
   * GPU compositing. Some virtualised and remote-desktop environments render
   * incorrectly with it enabled, so it is user-controllable. Requires a restart
   * because Chromium reads the switch before the first window is created.
   */
  hardwareAcceleration: z.boolean(),
  launchMinimized: z.boolean(),
})

export type AppSettings = z.infer<typeof AppSettingsSchema>

/** Partial update payload. Unspecified keys keep their persisted value. */
export const AppSettingsPatchSchema = AppSettingsSchema.partial()
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>

/** Every settings key, for iteration and for per-key persistence. */
export const SETTINGS_KEYS = Object.keys(AppSettingsSchema.shape) as Array<keyof AppSettings>

/**
 * Build the factory-default settings.
 *
 * `defaultRecoveryPath` is injected because resolving the user's Documents
 * folder requires Electron's `app.getPath`, which is not available in the shared
 * kernel by design.
 */
export function createDefaultSettings(defaultRecoveryPath: string): AppSettings {
  return {
    theme: 'system',
    accent: 'blue',
    language: 'en',
    compactDensity: false,
    reduceMotion: false,
    byteUnitSystem: 'binary',

    defaultRecoveryPath,
    confirmDestructiveActions: true,

    logLevel: 'info',
    logRetentionDays: 14,
    telemetryEnabled: false,

    autoCheckUpdates: true,
    hardwareAcceleration: true,
    launchMinimized: false,
  }
}

// `RESTART_REQUIRED_SETTINGS` deliberately lives in
// `@shared/constants/settings-meta` instead of here: importing a runtime value
// from this module pulls Zod into the importing bundle, and the renderer has no
// use for it.

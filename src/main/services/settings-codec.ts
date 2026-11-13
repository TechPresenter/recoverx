import { AppSettingsSchema, type AppSettings, type AppSettingsPatch } from '@shared/types/settings'
import { typedEntries, typedKeys } from '@shared/utils/guards'

/**
 * Pure codec between the typed settings object and the flat `key -> JSON string`
 * rows stored in SQLite.
 *
 * Kept free of any Electron, filesystem or SQLite import so it can be exercised
 * directly by the unit suite: this is where a corrupted or downgraded settings
 * row turns into either a safe default or a silent misconfiguration, and that
 * behaviour needs test coverage far more than the SQL around it does.
 *
 * One row per key (rather than one blob) is deliberate:
 *   - a single unparseable value degrades one setting, not all of them;
 *   - concurrent writers touching different keys never clobber each other;
 *   - adding a key in a later version needs no data migration.
 */

export interface DecodedSettings {
  readonly settings: AppSettings
  /** Keys whose stored value was missing, unparseable or schema-invalid. */
  readonly invalidKeys: readonly string[]
  /** Stored keys that no longer exist in the schema — candidates for cleanup. */
  readonly orphanedKeys: readonly string[]
}

/**
 * Rebuild a validated settings object from raw storage rows.
 *
 * Never throws. Any value that fails its own field schema is replaced by the
 * corresponding default and reported through `invalidKeys`, because refusing to
 * start over one bad row would be a far worse outcome for a user whose only
 * copy of their data is waiting to be recovered.
 */
export function decodeSettings(
  rows: Readonly<Record<string, string>>,
  defaults: AppSettings,
): DecodedSettings {
  const settings = { ...defaults }
  const invalidKeys: string[] = []

  for (const key of typedKeys(defaults)) {
    const raw = rows[key]

    if (raw === undefined) {
      // Not an error: a freshly installed app, or a key introduced by an update.
      continue
    }

    const decoded = decodeField(key, raw)
    if (decoded.ok) {
      // Index assignment through a mapped write keeps the union of value types
      // aligned with its key, which a plain `settings[key] = value` cannot.
      assignSetting(settings, key, decoded.value)
    } else {
      invalidKeys.push(key)
    }
  }

  const known = new Set<string>(typedKeys(defaults).map(String))
  const orphanedKeys = Object.keys(rows).filter((key) => !known.has(key))

  return { settings, invalidKeys, orphanedKeys }
}

/**
 * Convert a patch into the rows to persist.
 * Only keys present in the patch are emitted, so an update never rewrites
 * untouched settings.
 */
export function encodeSettingsPatch(patch: AppSettingsPatch): Record<string, string> {
  const rows: Record<string, string> = {}

  for (const [key, value] of typedEntries(patch)) {
    if (value === undefined) continue
    rows[String(key)] = JSON.stringify(value)
  }

  return rows
}

/** Serialise a complete settings object into storage rows. */
export function encodeSettings(settings: AppSettings): Record<string, string> {
  const rows: Record<string, string> = {}
  for (const [key, value] of typedEntries(settings)) {
    rows[String(key)] = JSON.stringify(value)
  }
  return rows
}

/**
 * Merge a patch onto the current settings, validating the result as a whole.
 *
 * Returns `null` when the merged object violates the schema, which lets the
 * caller reject the write and keep the previous state rather than persisting
 * something the app cannot load next time.
 */
export function mergeSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings | null {
  const candidate: Record<string, unknown> = { ...current }

  for (const [key, value] of typedEntries(patch)) {
    if (value === undefined) continue
    candidate[String(key)] = value
  }

  const parsed = AppSettingsSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/** Keys whose value actually differs between two settings objects. */
export function changedKeys(previous: AppSettings, next: AppSettings): Array<keyof AppSettings> {
  return typedKeys(next).filter((key) => previous[key] !== next[key])
}

// --- internals -------------------------------------------------------------

type FieldResult = { ok: true; value: unknown } | { ok: false }

/**
 * Decode and validate one stored field against its own schema slice.
 * `JSON.parse` is confined to this function so the failure mode is contained.
 */
function decodeField(key: keyof AppSettings, raw: string): FieldResult {
  let decoded: unknown
  try {
    // eslint-disable-next-line no-restricted-syntax -- validated immediately below against the field schema
    decoded = JSON.parse(raw)
  } catch {
    return { ok: false }
  }

  const fieldSchema = AppSettingsSchema.shape[key]
  const parsed = fieldSchema.safeParse(decoded)

  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

/**
 * Write a validated value into the settings object.
 *
 * The cast is contained here rather than spread across `decodeSettings`: the
 * value has already passed `AppSettingsSchema.shape[key]`, so it is correct for
 * this key by construction, but TypeScript cannot correlate the two through a
 * loop variable.
 */
function assignSetting(target: AppSettings, key: keyof AppSettings, value: unknown): void {
  ;(target as Record<string, unknown>)[key] = value
}

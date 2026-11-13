import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/types/settings'
import {
  changedKeys,
  decodeSettings,
  encodeSettings,
  encodeSettingsPatch,
  mergeSettings,
} from '@main/services/settings-codec'

const DEFAULTS = createDefaultSettings('D:\\Recovered')

describe('decodeSettings', () => {
  it('returns defaults for an empty store, as on a fresh install', () => {
    const result = decodeSettings({}, DEFAULTS)

    expect(result.settings).toEqual(DEFAULTS)
    expect(result.invalidKeys).toEqual([])
    expect(result.orphanedKeys).toEqual([])
  })

  it('applies stored values over the defaults', () => {
    const result = decodeSettings(
      { theme: '"dark"', logRetentionDays: '30', telemetryEnabled: 'true' },
      DEFAULTS,
    )

    expect(result.settings.theme).toBe('dark')
    expect(result.settings.logRetentionDays).toBe(30)
    expect(result.settings.telemetryEnabled).toBe(true)
    expect(result.invalidKeys).toEqual([])
  })

  it('falls back to the default for a value that is not valid JSON', () => {
    // A power loss mid-write can leave a truncated row.
    const result = decodeSettings({ theme: '"da' }, DEFAULTS)

    expect(result.settings.theme).toBe(DEFAULTS.theme)
    expect(result.invalidKeys).toEqual(['theme'])
  })

  it('falls back to the default for a value the schema rejects', () => {
    const result = decodeSettings({ theme: '"neon"', logRetentionDays: '9999' }, DEFAULTS)

    expect(result.settings.theme).toBe(DEFAULTS.theme)
    expect(result.settings.logRetentionDays).toBe(DEFAULTS.logRetentionDays)
    expect(result.invalidKeys).toEqual(['theme', 'logRetentionDays'])
  })

  it('degrades only the affected key, never the whole object', () => {
    // The critical property: one bad row must not reset every preference, and
    // must never prevent the application from starting.
    const result = decodeSettings({ theme: 'garbage', accent: '"violet"' }, DEFAULTS)

    expect(result.settings.accent).toBe('violet')
    expect(result.settings.theme).toBe(DEFAULTS.theme)
  })

  it('reports keys that are no longer part of the schema', () => {
    const result = decodeSettings({ theme: '"dark"', legacyOption: '"x"' }, DEFAULTS)

    expect(result.orphanedKeys).toEqual(['legacyOption'])
    expect(result.settings.theme).toBe('dark')
  })

  it('never throws, whatever the store contains', () => {
    expect(() =>
      decodeSettings({ theme: '', accent: 'null', language: '[]', reduceMotion: '{}' }, DEFAULTS),
    ).not.toThrow()
  })
})

describe('encodeSettingsPatch', () => {
  it('emits only the keys the patch sets', () => {
    expect(encodeSettingsPatch({ theme: 'dark' })).toEqual({ theme: '"dark"' })
  })

  it('skips keys explicitly set to undefined', () => {
    // `{ theme: undefined }` means "leave unchanged", not "write undefined".
    expect(encodeSettingsPatch({ theme: undefined, accent: 'rose' })).toEqual({
      accent: '"rose"',
    })
  })

  it('round-trips through decodeSettings', () => {
    const rows = encodeSettings({ ...DEFAULTS, theme: 'light', compactDensity: true })
    const decoded = decodeSettings(rows, DEFAULTS)

    expect(decoded.settings.theme).toBe('light')
    expect(decoded.settings.compactDensity).toBe(true)
    expect(decoded.invalidKeys).toEqual([])
  })
})

describe('mergeSettings', () => {
  it('applies a valid patch', () => {
    const merged = mergeSettings(DEFAULTS, { theme: 'dark', accent: 'emerald' })

    expect(merged).not.toBeNull()
    expect(merged?.theme).toBe('dark')
    expect(merged?.accent).toBe('emerald')
  })

  it('leaves unspecified keys untouched', () => {
    const merged = mergeSettings(DEFAULTS, { theme: 'dark' })

    expect(merged?.defaultRecoveryPath).toBe(DEFAULTS.defaultRecoveryPath)
    expect(merged?.logLevel).toBe(DEFAULTS.logLevel)
  })

  it('rejects a merge that would produce an invalid object', () => {
    const merged = mergeSettings(DEFAULTS, {
      logRetentionDays: 500,
    })

    expect(merged).toBeNull()
  })

  it('ignores keys set to undefined rather than writing undefined through', () => {
    const merged = mergeSettings(DEFAULTS, { theme: undefined })

    expect(merged?.theme).toBe(DEFAULTS.theme)
  })
})

describe('changedKeys', () => {
  it('lists only keys whose value actually differs', () => {
    const next = { ...DEFAULTS, theme: 'dark' as const, accent: 'rose' as const }

    expect(changedKeys(DEFAULTS, next).sort()).toEqual(['accent', 'theme'])
  })

  it('returns nothing for an identical object', () => {
    expect(changedKeys(DEFAULTS, { ...DEFAULTS })).toEqual([])
  })
})

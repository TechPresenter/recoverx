import { create } from 'zustand'
import { RESTART_REQUIRED_SETTINGS } from '@shared/constants/settings-meta'
import { IpcChannel } from '@shared/ipc/channels'
import type { AppSettings, AppSettingsPatch } from '@shared/types/settings'
import type { SerializedError } from '@shared/utils/errors'
import { invoke } from '@/lib/ipc-client'
import { createLogger } from '@/lib/logger'

/**
 * User settings, mirrored from the main process.
 *
 * The main process owns the authoritative copy; this store is a cache that is
 * refreshed by the `evt:settings-changed` broadcast. That direction matters:
 * every write goes through IPC and only lands here once persistence has
 * succeeded, so the UI can never show a preference that was not saved.
 */

const log = createLogger('settings-store')

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'error'

interface SettingsState {
  settings: AppSettings | null
  status: SettingsStatus
  error: SerializedError | null
  /** Keys changed this session that only take effect after a restart. */
  pendingRestartKeys: ReadonlyArray<keyof AppSettings>
  /** Keys currently being written, for per-control busy states. */
  savingKeys: ReadonlyArray<keyof AppSettings>

  load: () => Promise<void>
  update: (patch: AppSettingsPatch) => Promise<boolean>
  reset: () => Promise<boolean>
  /** Apply a value pushed from the main process. */
  applyExternal: (settings: AppSettings) => void
  dismissRestartNotice: () => void
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  status: 'idle',
  error: null,
  pendingRestartKeys: [],
  savingKeys: [],

  load: async () => {
    set({ status: 'loading', error: null })

    const result = await invoke(IpcChannel.SettingsGetAll, undefined)

    if (!result.ok) {
      log.error('Failed to load settings', result.error)
      set({ status: 'error', error: result.error })
      return
    }

    set({ settings: result.data, status: 'ready', error: null })
  },

  update: async (patch) => {
    const keys = definedKeys(patch)
    if (keys.length === 0) return true

    const previous = get().settings

    // Optimistic application keeps toggles and selects feeling instantaneous.
    // The write is authoritative: if it fails, the previous value is restored
    // below, so a control never lies about what is persisted.
    if (previous !== null) {
      set({ settings: applyPatch(previous, patch), savingKeys: keys })
    }

    const result = await invoke(IpcChannel.SettingsUpdate, { patch })

    if (!result.ok) {
      log.error('Failed to update settings', { keys, error: result.error })
      set({
        settings: previous,
        error: result.error,
        savingKeys: [],
      })
      return false
    }

    const restartKeys = keys.filter((key) => RESTART_REQUIRED_SETTINGS.has(key))

    set((state) => ({
      settings: result.data,
      error: null,
      savingKeys: [],
      pendingRestartKeys: mergeUnique(state.pendingRestartKeys, restartKeys),
    }))

    return true
  },

  reset: async () => {
    const result = await invoke(IpcChannel.SettingsReset, undefined)

    if (!result.ok) {
      log.error('Failed to reset settings', result.error)
      set({ error: result.error })
      return false
    }

    set({ settings: result.data, error: null, pendingRestartKeys: [] })
    return true
  },

  applyExternal: (settings) => {
    set({ settings, status: 'ready', error: null })
  },

  dismissRestartNotice: () => {
    set({ pendingRestartKeys: [] })
  },
}))

function mergeUnique<T>(current: readonly T[], additions: readonly T[]): T[] {
  const merged = new Set(current)
  for (const item of additions) merged.add(item)
  return [...merged]
}

/**
 * Keys a patch actually sets.
 *
 * `Object.keys` alone would include a key written as `{ theme: undefined }`,
 * which means "leave unchanged" rather than "set to undefined".
 */
function definedKeys(patch: AppSettingsPatch): Array<keyof AppSettings> {
  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key as keyof AppSettings)
}

/**
 * Merge a patch onto settings, skipping unset keys.
 *
 * A plain spread cannot be used: under `exactOptionalPropertyTypes`, spreading
 * an optional property whose value is `undefined` widens the result's type and
 * would let an unset key overwrite a real value with `undefined`.
 */
function applyPatch(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  const next: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value
  }

  return next as AppSettings
}

/**
 * Read settings with a guaranteed value.
 *
 * The application shell does not render its routes until settings have loaded,
 * so components below it can rely on this rather than null-checking everywhere.
 */
export function useSettings(): AppSettings {
  const settings = useSettingsStore((state) => state.settings)

  if (settings === null) {
    throw new Error('useSettings was called before settings finished loading')
  }

  return settings
}

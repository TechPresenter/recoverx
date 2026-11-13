import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings, type AppSettings } from '@shared/types/settings'
import type { Result } from '@shared/utils/result'

const invoke = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  invoke,
  subscribe: vi.fn(() => () => undefined),
  isBridgeAvailable: () => true,
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { useSettingsStore } = await import('@/stores/settings.store')
const { useUiStore } = await import('@/stores/ui.store')

const DEFAULTS = createDefaultSettings('D:\\Recovered')

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const fail = <T>(message: string): Result<T> => ({
  ok: false,
  error: { code: 'VALIDATION', message, details: undefined, retryable: false },
})

describe('settings store', () => {
  beforeEach(() => {
    invoke.mockReset()
    useSettingsStore.setState({
      settings: null,
      status: 'idle',
      error: null,
      pendingRestartKeys: [],
      savingKeys: [],
    })
  })

  it('loads settings from the main process', async () => {
    invoke.mockResolvedValueOnce(ok(DEFAULTS))

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().status).toBe('ready')
    expect(useSettingsStore.getState().settings).toEqual(DEFAULTS)
  })

  it('records an error state when loading fails', async () => {
    invoke.mockResolvedValueOnce(fail('database unavailable'))

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().status).toBe('error')
    expect(useSettingsStore.getState().error?.message).toBe('database unavailable')
  })

  it('applies an update returned by the main process', async () => {
    invoke.mockResolvedValueOnce(ok(DEFAULTS))
    await useSettingsStore.getState().load()

    const updated: AppSettings = { ...DEFAULTS, theme: 'dark' }
    invoke.mockResolvedValueOnce(ok(updated))

    const succeeded = await useSettingsStore.getState().update({ theme: 'dark' })

    expect(succeeded).toBe(true)
    expect(useSettingsStore.getState().settings?.theme).toBe('dark')
  })

  it('reverts the optimistic value when the write fails', async () => {
    invoke.mockResolvedValueOnce(ok(DEFAULTS))
    await useSettingsStore.getState().load()

    invoke.mockResolvedValueOnce(fail('folder is read-only'))

    const succeeded = await useSettingsStore.getState().update({ defaultRecoveryPath: 'X:\\ro' })

    // The control must never show a value that was not persisted.
    expect(succeeded).toBe(false)
    expect(useSettingsStore.getState().settings).toEqual(DEFAULTS)
    expect(useSettingsStore.getState().savingKeys).toEqual([])
  })

  it('skips the round trip for an empty patch', async () => {
    invoke.mockResolvedValueOnce(ok(DEFAULTS))
    await useSettingsStore.getState().load()
    invoke.mockClear()

    expect(await useSettingsStore.getState().update({})).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('treats a key set to undefined as "leave unchanged"', async () => {
    invoke.mockResolvedValueOnce(ok(DEFAULTS))
    await useSettingsStore.getState().load()
    invoke.mockClear()

    expect(await useSettingsStore.getState().update({ theme: undefined })).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('flags settings that need a restart to take effect', async () => {
    invoke.mockResolvedValueOnce(ok(DEFAULTS))
    await useSettingsStore.getState().load()

    invoke.mockResolvedValueOnce(ok({ ...DEFAULTS, hardwareAcceleration: false }))
    await useSettingsStore.getState().update({ hardwareAcceleration: false })

    expect(useSettingsStore.getState().pendingRestartKeys).toEqual(['hardwareAcceleration'])

    useSettingsStore.getState().dismissRestartNotice()
    expect(useSettingsStore.getState().pendingRestartKeys).toEqual([])
  })

  it('does not flag ordinary settings as needing a restart', async () => {
    invoke.mockResolvedValueOnce(ok(DEFAULTS))
    await useSettingsStore.getState().load()

    invoke.mockResolvedValueOnce(ok({ ...DEFAULTS, theme: 'dark' }))
    await useSettingsStore.getState().update({ theme: 'dark' })

    expect(useSettingsStore.getState().pendingRestartKeys).toEqual([])
  })

  it('accepts a value pushed from the main process', () => {
    useSettingsStore.getState().applyExternal({ ...DEFAULTS, accent: 'rose' })

    expect(useSettingsStore.getState().settings?.accent).toBe('rose')
    expect(useSettingsStore.getState().status).toBe('ready')
  })
})

describe('UI store toasts', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [], confirmRequest: null })
  })

  it('adds a toast with a tone-appropriate default duration', () => {
    useUiStore.getState().pushToast({ tone: 'success', title: 'Saved' })
    useUiStore.getState().pushToast({ tone: 'error', title: 'Failed' })

    const [success, error] = useUiStore.getState().toasts

    expect(success?.durationMs).toBeGreaterThan(0)
    // Errors are sticky: the user must be able to read and act on them.
    expect(error?.durationMs).toBe(0)
  })

  it('bounds the stack so a failure loop cannot fill the screen', () => {
    for (let index = 0; index < 12; index += 1) {
      useUiStore.getState().pushToast({ title: `toast ${index}` })
    }

    expect(useUiStore.getState().toasts.length).toBeLessThanOrEqual(4)
    // The most recent survive.
    expect(useUiStore.getState().toasts.at(-1)?.title).toBe('toast 11')
  })

  it('dismisses by id', () => {
    const id = useUiStore.getState().pushToast({ title: 'Saved' })
    useUiStore.getState().dismissToast(id)

    expect(useUiStore.getState().toasts).toEqual([])
  })
})

describe('UI store confirmation', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [], confirmRequest: null })
  })

  const options = { title: 'Delete?', confirmLabel: 'Delete', cancelLabel: 'Cancel' }

  it('resolves true when confirmed', async () => {
    const pending = useUiStore.getState().requestConfirm(options)

    expect(useUiStore.getState().confirmRequest).not.toBeNull()
    useUiStore.getState().resolveConfirm(true)

    await expect(pending).resolves.toBe(true)
    expect(useUiStore.getState().confirmRequest).toBeNull()
  })

  it('resolves false when cancelled', async () => {
    const pending = useUiStore.getState().requestConfirm(options)
    useUiStore.getState().resolveConfirm(false)

    await expect(pending).resolves.toBe(false)
  })

  it('settles a superseded request instead of leaving it hanging', async () => {
    const first = useUiStore.getState().requestConfirm(options)
    const second = useUiStore.getState().requestConfirm({ ...options, title: 'Other?' })

    // The first caller is awaiting a dialog that no longer exists; it must be
    // told "no" rather than deadlocking.
    await expect(first).resolves.toBe(false)

    useUiStore.getState().resolveConfirm(true)
    await expect(second).resolves.toBe(true)
  })

  it('ignores a resolution when nothing is pending', () => {
    expect(() => {
      useUiStore.getState().resolveConfirm(true)
    }).not.toThrow()
  })
})

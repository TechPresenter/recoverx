import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '@main/logging/logger'
import {
  BUSY_RECHECK_MS,
  SETTING_CHECK_DELAY_MS,
  STARTUP_CHECK_DELAY_MS,
  UpdateService,
  type AutomaticCheckPolicy,
} from '@main/updates/update.service'
import { UpdateStateSchema } from '@shared/types/diagnostics'

/**
 * Who updates the application.
 *
 * Neither Electron nor `electron-updater` can load in a plain Node process, so
 * both are replaced. The updater stand-in counts how often it is reached for:
 * reading `autoUpdater` is what constructs the real platform updater, and a
 * Microsoft Store copy must never construct one.
 */

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '1.4.0' },
}))

const updater = vi.hoisted(() => ({
  reads: 0,
  instance: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: undefined,
    on: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    quitAndInstall: vi.fn(),
  },
}))

vi.mock('electron', () => electron)

vi.mock('electron-updater', () => ({
  default: {
    get autoUpdater() {
      updater.reads += 1
      return updater.instance
    },
  },
}))

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
}

/**
 * Electron defines `process.windowsStore` only inside an MSIX/AppX package.
 * Plain Node never has it, so the descriptor is restored rather than assumed.
 */
const originalWindowsStore = Object.getOwnPropertyDescriptor(process, 'windowsStore')

function runFromStorePackage(value: boolean): void {
  Object.defineProperty(process, 'windowsStore', { value, configurable: true, writable: true })
}

beforeEach(() => {
  updater.reads = 0
  updater.instance.autoDownload = true
  electron.app.isPackaged = true
})

afterEach(() => {
  if (originalWindowsStore === undefined) {
    Reflect.deleteProperty(process, 'windowsStore')
  } else {
    Object.defineProperty(process, 'windowsStore', originalWindowsStore)
  }
})

describe('a Microsoft Store copy', () => {
  it('reports that the Store delivers its updates', () => {
    runFromStorePackage(true)

    const state = new UpdateService(silentLogger).getState()

    expect(state.status).toBe('store-managed')
    expect(state.currentVersion).toBe('1.4.0')
  })

  it('never constructs or configures the updater', () => {
    runFromStorePackage(true)

    const updates = new UpdateService(silentLogger)

    expect(updates.getState().status).toBe('store-managed')
    expect(updater.reads).toBe(0)
    expect(updater.instance.on).not.toHaveBeenCalled()
    expect(updater.instance.autoDownload).toBe(true)
  })

  it('never checks for an update, even when asked', async () => {
    runFromStorePackage(true)
    const updates = new UpdateService(silentLogger)

    const state = await updates.check()

    expect(state.status).toBe('store-managed')
    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.reads).toBe(0)
  })

  it('refuses to download or install anything', async () => {
    runFromStorePackage(true)
    const updates = new UpdateService(silentLogger)

    await expect(updates.download()).rejects.toThrow()
    expect(() => {
      updates.install()
    }).toThrow()
    expect(updater.instance.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.instance.quitAndInstall).not.toHaveBeenCalled()
  })

  it('crosses the IPC boundary as a valid update state', () => {
    // The renderer receives this through `UpdateStateSchema`; a status the
    // schema did not know would be rejected on the way out of the main process.
    runFromStorePackage(true)

    const parsed = UpdateStateSchema.safeParse(new UpdateService(silentLogger).getState())

    expect(parsed.success).toBe(true)
  })
})

describe('a directly installed copy', () => {
  it('updates itself, with downloading left to the user', async () => {
    const updates = new UpdateService(silentLogger)

    expect(updates.getState().status).toBe('idle')
    expect(updater.reads).toBeGreaterThan(0)
    expect(updater.instance.autoDownload).toBe(false)
    expect(updater.instance.on).toHaveBeenCalledWith('update-available', expect.any(Function))

    await updates.check()

    expect(updater.instance.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('is not mistaken for a Store copy when the flag is present but false', () => {
    runFromStorePackage(false)

    expect(new UpdateService(silentLogger).getState().status).toBe('idle')
  })
})

describe('a development build', () => {
  it('has nothing to update and never reaches for the updater', async () => {
    electron.app.isPackaged = false
    const updates = new UpdateService(silentLogger)

    expect(updates.getState().status).toBe('unsupported')
    await updates.check()

    expect(updater.reads).toBe(0)
    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('automatic checks', () => {
  /**
   * The setting and the work in progress, as the bootstrap supplies them:
   * read when the check falls due, so a test changes them mid-wait exactly as
   * a user would.
   */
  function circumstances(initial: { enabled?: boolean; busy?: boolean } = {}): {
    current: { enabled: boolean; busy: boolean }
    policy: AutomaticCheckPolicy
  } {
    const current = { enabled: true, busy: false, ...initial }
    return { current, policy: { enabled: () => current.enabled, busy: () => current.busy } }
  }

  /** The handler the service registered for one updater event. */
  function handlerFor(event: string): (info: unknown) => void {
    const call = updater.instance.on.mock.calls.find((args: unknown[]) => args[0] === event)
    return call?.[1] as (info: unknown) => void
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks once, shortly after start-up, and downloads nothing', async () => {
    const updates = new UpdateService(silentLogger)
    updates.startAutomaticChecks(circumstances().policy)

    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS - 1)
    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(updater.instance.checkForUpdates).toHaveBeenCalledOnce()

    // Once per start, not a poll for as long as the window stays open.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(updater.instance.checkForUpdates).toHaveBeenCalledOnce()
    expect(updater.instance.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.instance.autoDownload).toBe(false)
  })

  it('never checks while the setting is off', async () => {
    const updates = new UpdateService(silentLogger)
    updates.startAutomaticChecks(circumstances({ enabled: false }).policy)

    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS * 10)

    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()
  })

  it('obeys the setting as it stands when the check falls due', async () => {
    const { current, policy } = circumstances()
    const updates = new UpdateService(silentLogger)
    updates.startAutomaticChecks(policy)

    current.enabled = false
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS)

    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks soon after the setting is turned on', async () => {
    const { current, policy } = circumstances({ enabled: false })
    const updates = new UpdateService(silentLogger)
    updates.startAutomaticChecks(policy)
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS)

    current.enabled = true
    updates.automaticChecksEnabled()
    await vi.advanceTimersByTimeAsync(SETTING_CHECK_DELAY_MS)

    expect(updater.instance.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('asks once for a switch flicked on, off and on again', async () => {
    const { current, policy } = circumstances({ enabled: false })
    const updates = new UpdateService(silentLogger)
    updates.startAutomaticChecks(policy)
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS)

    current.enabled = true
    updates.automaticChecksEnabled()
    await vi.advanceTimersByTimeAsync(SETTING_CHECK_DELAY_MS / 2)
    updates.automaticChecksEnabled()
    await vi.advanceTimersByTimeAsync(SETTING_CHECK_DELAY_MS * 10)

    expect(updater.instance.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('waits for a scan or a recovery to finish', async () => {
    const { current, policy } = circumstances({ busy: true })
    const updates = new UpdateService(silentLogger)
    updates.startAutomaticChecks(policy)

    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS + BUSY_RECHECK_MS * 3)
    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()

    current.busy = false
    await vi.advanceTimersByTimeAsync(BUSY_RECHECK_MS)

    expect(updater.instance.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('does not ask again while an update is already on offer', async () => {
    const updates = new UpdateService(silentLogger)
    updates.startAutomaticChecks(circumstances().policy)
    handlerFor('update-available')({ version: '1.5.0', releaseNotes: null, releaseDate: '' })

    updates.automaticChecksEnabled()
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS)

    expect(updates.getState().status).toBe('available')
    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()
  })

  it('is cancelled when the application shuts down', async () => {
    const updates = new UpdateService(silentLogger)
    updates.startAutomaticChecks(circumstances().policy)

    updates.stopAutomaticChecks()
    updates.automaticChecksEnabled()
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS * 10)

    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()
  })

  it('arranges nothing for a Store copy or a development build', async () => {
    runFromStorePackage(true)
    const store = new UpdateService(silentLogger)
    store.startAutomaticChecks(circumstances().policy)
    store.automaticChecksEnabled()

    runFromStorePackage(false)
    electron.app.isPackaged = false
    const development = new UpdateService(silentLogger)
    development.startAutomaticChecks(circumstances().policy)
    development.automaticChecksEnabled()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS * 10)
    expect(updater.reads).toBe(0)
    expect(updater.instance.checkForUpdates).not.toHaveBeenCalled()
  })
})

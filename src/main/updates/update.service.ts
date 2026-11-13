import { app } from 'electron'
import electronUpdater, { type AppUpdater, type UpdateInfo } from 'electron-updater'
import type { UpdateState, UpdateStatus } from '@shared/types/diagnostics'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import type { Logger } from '../logging/logger'
import { normaliseNotes } from './release-notes'

/**
 * Application updates.
 *
 * Downloading is never automatic. This application is frequently the only thing
 * standing between a user and lost data, and a recovery that has been running
 * for four hours must not compete for the disk — or restart — because a new
 * version appeared. Checking is cheap and can be automatic; everything after
 * that is the user's decision, taken when they are not in the middle of a job.
 *
 * A copy installed from the Microsoft Store is updated by the Store, and this
 * service then stands aside entirely. The Store replaces the whole package
 * itself; an NSIS installer fetched by `electron-updater` would at best fail to
 * write into the package's read-only folder and at worst install a second,
 * unmanaged copy beside it.
 */

export type UpdateListener = (state: UpdateState) => void

/**
 * How long after start-up the automatic check waits.
 *
 * Long enough that it never competes with the first paint, device enumeration
 * or the licence's own start-up requests, and short enough that a user who
 * opens About straight away is likely to find the answer already there.
 */
export const STARTUP_CHECK_DELAY_MS = 15_000

/**
 * How long a check waits after the setting is switched on.
 *
 * Not zero, so a switch flicked on, off and on again costs one request; the
 * setting is read again when the check falls due.
 */
export const SETTING_CHECK_DELAY_MS = 2_000

/** How often a check that found work in progress looks again. */
export const BUSY_RECHECK_MS = 60_000

/**
 * Statuses from which an automatic check may ask the server.
 *
 * Anything else already has an answer, or a decision, in hand: a check under
 * way, an update offered, downloading or downloaded. Asking again would at
 * best repeat what the user is already looking at and at worst disturb a
 * download they started.
 */
const AUTOMATIC_CHECK_FROM: ReadonlySet<UpdateStatus> = new Set(['idle', 'not-available', 'error'])

/**
 * What an automatic check asks before it goes ahead.
 *
 * Functions rather than values, because both are read when the check falls
 * due, not when it is arranged: a user who turns the setting off in the first
 * seconds is obeyed, and a scan started in that time defers the check.
 */
export interface AutomaticCheckPolicy {
  /** The user's "Check for updates automatically" setting. */
  readonly enabled: () => boolean
  /** `true` while a scan or a recovery is running. */
  readonly busy: () => boolean
}

/**
 * Who is responsible for updating this copy.
 *
 *  - `direct`: installed from our own installer, so updated by this service.
 *  - `store`: installed from an MSIX package, so updated by the Store.
 *  - `development`: run from source, so updated by rebuilding it.
 */
type Installation = 'direct' | 'store' | 'development'

/**
 * The updater, read on demand.
 *
 * `electron-updater` ships as CommonJS with no named exports under ESM, so the
 * default import is used rather than a named one. Importing `autoUpdater` by
 * name compiles and then fails at runtime, which is a particularly unpleasant
 * way to find out.
 *
 * Not destructured at load, either: reading `autoUpdater` constructs the
 * platform updater, and a Store build must never construct one.
 */
function updater(): AppUpdater {
  return electronUpdater.autoUpdater
}

function detectInstallation(): Installation {
  // Electron sets this when running from an MSIX/AppX package. It is checked
  // before `isPackaged`, which is true there as well.
  if (process.windowsStore === true) return 'store'

  return app.isPackaged ? 'direct' : 'development'
}

function initialStatus(installation: Installation): UpdateStatus {
  switch (installation) {
    case 'direct':
      return 'idle'
    case 'store':
      return 'store-managed'
    case 'development':
      // A development build has no installer to replace, and telling the user
      // "no updates available" would be a lie rather than an answer.
      return 'unsupported'
  }
}

export class UpdateService {
  private readonly logger: Logger
  private readonly listeners = new Set<UpdateListener>()
  private readonly installation: Installation
  private state: UpdateState
  private automatic: AutomaticCheckPolicy | null = null
  private automaticTimer: ReturnType<typeof setTimeout> | null = null

  constructor(logger: Logger) {
    this.logger = logger.child('update')
    this.installation = detectInstallation()

    this.state = {
      status: initialStatus(this.installation),
      currentVersion: app.getVersion(),
      availableVersion: null,
      releaseNotes: null,
      releaseDate: null,
      percent: 0,
      bytesPerSecond: 0,
      transferredBytes: 0,
      totalBytes: 0,
      errorMessage: null,
      checkedAt: null,
    }

    if (this.installation === 'direct') this.attach()
    if (this.installation === 'store') this.logger.info('Installed from the Microsoft Store')
  }

  onChange(listener: UpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): UpdateState {
    return this.state
  }

  /** Ask the server whether a newer version exists. Downloads nothing. */
  async check(): Promise<UpdateState> {
    // Keyed on the installation, not the status: the status moves, and the
    // decision about who owns updates must not move with it.
    if (this.installation !== 'direct') return this.state

    this.update({ status: 'checking', errorMessage: null })

    try {
      await updater().checkForUpdates()
    } catch (error) {
      this.update({ status: 'error', errorMessage: describeUnknown(error) })
      this.logger.warn('Update check failed', { error: describeUnknown(error) })
    }

    return this.state
  }

  /**
   * Fetch the update the last check found.
   *
   * Separate from `check` on purpose: the user is told what is available and
   * how large it is, and then decides.
   */
  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available') {
      throw new AppError(ErrorCode.Validation, 'There is no update ready to download', {
        retryable: false,
      })
    }

    this.update({ status: 'downloading', percent: 0, errorMessage: null })

    try {
      await updater().downloadUpdate()
    } catch (error) {
      this.update({ status: 'error', errorMessage: describeUnknown(error) })
      this.logger.warn('Update download failed', { error: describeUnknown(error) })
    }

    return this.state
  }

  /**
   * Install and restart.
   *
   * The caller is responsible for making sure nothing is running first. Quitting
   * mid-recovery would leave a half-written file the user believes is intact,
   * which is worse than not updating at all.
   */
  install(): void {
    if (this.state.status !== 'downloaded') {
      throw new AppError(ErrorCode.Validation, 'No update has been downloaded yet', {
        retryable: false,
      })
    }

    this.logger.info('Installing update', { version: this.state.availableVersion })
    // `isSilent` false shows the installer; `isForceRunAfter` reopens the app.
    updater().quitAndInstall(false, true)
  }

  /**
   * Check once, shortly after start-up, while the user allows it.
   *
   * Only ever a check — what it finds is offered on the About screen, and
   * downloading stays the user's decision. Once per start, not periodically:
   * this is a desktop tool that is opened for a job and closed again, and a
   * timer polling a server for as long as it stays open would be traffic
   * nobody asked for.
   *
   * Never while a scan or a recovery runs; the check waits for it to end.
   * Nothing is arranged at all for a Store copy or a development build, which
   * have no feed to ask.
   */
  startAutomaticChecks(policy: AutomaticCheckPolicy): void {
    if (this.installation !== 'direct') return

    this.automatic = policy
    this.armAutomaticCheck(STARTUP_CHECK_DELAY_MS)
  }

  /**
   * The user has just turned automatic checks on.
   *
   * Answered now rather than at the next start: someone who flips that switch
   * expects it to do something they can see.
   */
  automaticChecksEnabled(): void {
    if (this.automatic === null) return
    this.armAutomaticCheck(SETTING_CHECK_DELAY_MS)
  }

  /** Cancel any pending automatic check. Called during shutdown. */
  stopAutomaticChecks(): void {
    this.automatic = null
    if (this.automaticTimer !== null) clearTimeout(this.automaticTimer)
    this.automaticTimer = null
  }

  // --- internals -----------------------------------------------------------

  /** Replace any pending automatic check with one `delayMs` from now. */
  private armAutomaticCheck(delayMs: number): void {
    if (this.automaticTimer !== null) clearTimeout(this.automaticTimer)

    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = null
      void this.runAutomaticCheck().catch((error: unknown) => {
        this.logger.warn('Automatic update check failed', { error: describeUnknown(error) })
      })
    }, delayMs)

    // A pending check is never the reason the process stays alive.
    this.automaticTimer.unref()
  }

  private async runAutomaticCheck(): Promise<void> {
    const policy = this.automatic
    if (!policy?.enabled()) return

    if (policy.busy()) {
      this.logger.debug('Automatic update check postponed until the work in progress ends')
      this.armAutomaticCheck(BUSY_RECHECK_MS)
      return
    }

    if (!AUTOMATIC_CHECK_FROM.has(this.state.status)) return

    this.logger.info('Checking for updates automatically')
    await this.check()
  }

  private attach(): void {
    const autoUpdater = updater()

    // Downloading is a decision, so the library must not take it.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.update({
        status: 'available',
        availableVersion: info.version,
        releaseNotes: normaliseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
        checkedAt: Date.now(),
      })
      this.logger.info('Update available', { version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
      this.update({ status: 'not-available', availableVersion: null, checkedAt: Date.now() })
    })

    autoUpdater.on('download-progress', (progress) => {
      this.update({
        status: 'downloading',
        percent: Math.min(100, Math.max(0, progress.percent)),
        bytesPerSecond: progress.bytesPerSecond,
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
      })
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.update({ status: 'downloaded', percent: 100, availableVersion: info.version })
      this.logger.info('Update downloaded', { version: info.version })
    })

    autoUpdater.on('error', (error: Error) => {
      this.update({ status: 'error', errorMessage: describeUnknown(error) })
      this.logger.warn('Updater reported an error', { error: describeUnknown(error) })
    })
  }

  private update(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }
}

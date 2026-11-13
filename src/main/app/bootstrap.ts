import { app, nativeTheme, session } from 'electron'
import { APP_ID } from '@shared/constants/app'
import { openDatabase } from '../database/connection'
import { runMigrations } from '../database/migrator'
import { SettingsRepository } from '../database/repositories/settings.repository'
import { WindowStateRepository } from '../database/repositories/window-state.repository'
import { applyUserDataOverride, resolveAppPaths } from '../config/paths'
import { resolveRuntimeConfig } from '../config/runtime'
import { DiskService } from '../disk/disk.service'
import { PartitionSearchManager } from '../disk/partition-search.service'
import { HealthService } from '../health/health.service'
import { CrashReporter } from '../diagnostics/crash-reporter'
import { LicenseService } from '../licensing/license.service'
import { UpdateService } from '../updates/update.service'
import { HealthRepository } from '../database/repositories/health.repository'
import { ScanRepository } from '../database/repositories/scan.repository'
import { RecoveryRepository } from '../database/repositories/recovery.repository'
import { PreviewService } from '../preview/preview.service'
import { RecoveryManager } from '../recovery/recovery.service'
import { ScanManager } from '../scan/scan-session'
import {
  type Logger,
  applyLogSettings,
  initializeLogging,
  setLogBroadcastSink,
} from '../logging/logger'
import { createIpcSurface, type IpcRegistry } from '../ipc'
import { registerAppProtocolHandler } from '../security/app-protocol'
import { hardenSession } from '../security/session-hardening'
import { SettingsService } from '../services/settings.service'
import type { AppContext } from './context'
import { installApplicationMenu } from './menu'
import { createStartupMetrics, type StartupMetrics } from './startup-metrics'
import { WindowManager, resolvePreloadPath } from './window-manager'

/**
 * Two-phase boot.
 *
 * `prepareApplication` runs *before* `app.whenReady()`. It has to: the hardware
 * acceleration switch is read by Chromium while the GPU process is created, and
 * the `app://` scheme must be registered before the network service starts.
 * Both are therefore blocked on having user settings in hand, which is why the
 * database is opened synchronously in this phase rather than after ready.
 *
 * `startApplication` runs after ready and builds everything that needs a live
 * Chromium: the session policy, the protocol handler, the window and the IPC
 * surface.
 */

export interface PreparedApplication {
  readonly context: Omit<AppContext, 'windows'>
  readonly startup: StartupMetrics
  /** Release the resources acquired during preparation. */
  dispose(): void
}

export function prepareApplication(): PreparedApplication {
  const startup = createStartupMetrics()

  const config = resolveRuntimeConfig()

  // Must precede every other path lookup so a development session cannot
  // migrate an installed copy's database to an unreleased schema.
  applyUserDataOverride(config.userDataOverride)

  const paths = resolveAppPaths()

  const logger = initializeLogging({
    logDirectory: paths.logs,
    level: config.bootLogLevel,
    // Nothing is deleted until the user's "Keep logs for" has been read a few
    // lines below. A default here would be applied as soon as the boot opened
    // a new day's file, deleting logs the user chose to keep for longer.
    retentionDays: null,
    enableConsole: config.isDevelopment,
  })

  logger.info('RecoverX starting', {
    version: app.getVersion(),
    packaged: config.isPackaged,
    channel: config.channel,
    userData: paths.userData,
  })

  const database = openDatabase({ filePath: paths.database, logger: logger.child('database') })
  runMigrations(database.db, logger.child('database'))

  const settings = new SettingsService(
    new SettingsRepository(database.db),
    paths.defaultRecovery,
    logger.child('settings'),
  )
  const loaded = settings.load()

  // User preferences win over the environment default once they are known:
  // the level, and how many days of log files to keep.
  applyLogSettings(loaded)

  applyChromiumSwitches(loaded.hardwareAcceleration, logger)

  app.setAppUserModelId(APP_ID)

  // Device enumeration is lazy: the constructor is free, and the first query
  // happens when the user opens the device list, keeping it off the boot path.
  const disks = new DiskService(logger)
  const partitionSearches = new PartitionSearchManager(disks, logger)
  const health = new HealthService(disks, logger)
  const crashes = new CrashReporter(paths.userData, logger)
  const updates = new UpdateService(logger)
  const licensing = new LicenseService(paths, logger)
  licensing.warmUp()
  const healthHistory = new HealthRepository(database.db)
  const scanRepository = new ScanRepository(database.db)
  const scans = new ScanManager(disks, scanRepository, logger)
  const previews = new PreviewService(disks, scanRepository, logger)
  const recoveries = new RecoveryManager(
    disks,
    scanRepository,
    new RecoveryRepository(database.db),
    licensing,
    logger,
  )

  return {
    context: {
      config,
      paths,
      logger,
      database,
      settings,
      disks,
      licensing,
      updates,
      crashes,
      health,
      healthHistory,
      partitionSearches,
      scans,
      previews,
      recoveries,
      startup,
    },
    startup,
    dispose: () => {
      database.close()
    },
  }
}

export interface RunningApplication {
  readonly context: AppContext
  readonly ipc: IpcRegistry
}

/** Build the runtime that requires a ready Chromium. */
export function startApplication(prepared: PreparedApplication): RunningApplication {
  const { context: base } = prepared
  const { config, logger, settings, paths } = base

  hardenSession({ session: session.defaultSession, config, logger: logger.child('security') })

  if (config.rendererDevServerUrl === null) {
    // In development the renderer is served by Vite over HTTP; the custom
    // scheme is only needed for the built bundle.
    registerAppProtocolHandler(resolveRendererRoot(), config, logger.child('security'))
  }

  installApplicationMenu(config, logger.child('menu'))

  const windows = new WindowManager({
    config,
    logger,
    windowState: new WindowStateRepository(base.database.db, logger.child('database')),
    startup: base.startup,
    preloadPath: resolvePreloadPath(),
    launchMinimized: settings.getAll().launchMinimized,
    onRendererGone: (reason, exitCode) => {
      base.crashes.record('renderer-gone', new Error(reason), { exitCode })
    },
  })

  const context: AppContext = { ...base, windows }

  const ipc = createIpcSurface(context)

  wireLiveNotifications(context)

  windows.createMainWindow()

  // Armed after the window exists, so the check is never part of start-up's
  // own critical path. Both answers are read when it falls due.
  context.updates.startAutomaticChecks({
    enabled: () => settings.getAll().autoCheckUpdates,
    busy: () => context.scans.hasActiveWork() || context.recoveries.hasActiveWork(),
  })

  logger.debug('Application started', { logDirectory: paths.logs })

  return { context, ipc }
}

/**
 * Connect the main process's push notifications to the renderer.
 */
function wireLiveNotifications(context: AppContext): void {
  const { settings, windows } = context

  settings.onChange((next, changed) => {
    applyLogSettings(next, changed)
    if (changed.includes('autoCheckUpdates') && next.autoCheckUpdates) {
      context.updates.automaticChecksEnabled()
    }
    windows.broadcast('evt:settings-changed', next)
  })

  nativeTheme.on('updated', () => {
    windows.broadcast('evt:system-theme-changed', {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    })
  })

  // The Logs screen tails the live stream instead of polling the file.
  setLogBroadcastSink((entries) => {
    windows.broadcast('evt:log-appended', entries)
  })

  context.scans.onProgress((progress) => {
    windows.broadcast('evt:scan-progress', progress)
  })

  context.recoveries.onProgress((progress) => {
    windows.broadcast('evt:recovery-progress', progress)
  })

  context.partitionSearches.onProgress((progress) => {
    windows.broadcast('evt:partition-progress', progress)
  })

  context.updates.onChange((state) => {
    windows.broadcast('evt:update-changed', state)
  })
}

/**
 * Apply Chromium command-line switches derived from user settings.
 *
 * These only take effect before the GPU process is created, which is why
 * changing `hardwareAcceleration` is marked as requiring a restart in the UI.
 */
function applyChromiumSwitches(hardwareAcceleration: boolean, logger: Logger): void {
  if (hardwareAcceleration) return

  app.disableHardwareAcceleration()
  logger.info('Hardware acceleration disabled by user setting')
}

/**
 * Directory holding the built renderer.
 *
 * electron-vite emits `out/main`, `out/preload` and `out/renderer` as siblings,
 * and the packaged app preserves that layout inside the asar archive.
 */
function resolveRendererRoot(): string {
  return `${__dirname}/../renderer`
}

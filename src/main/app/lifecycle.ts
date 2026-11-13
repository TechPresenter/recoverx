import { app } from 'electron'
import { describeUnknown } from '@shared/utils/errors'
import {
  type Logger,
  flushLogBroadcast,
  setLogBroadcastSink,
  shutdownLogging,
} from '../logging/logger'
import type { CrashReporter } from '../diagnostics/crash-reporter'
import type { PreparedApplication, RunningApplication } from './bootstrap'

/**
 * Process lifecycle: shutdown ordering, second-instance handling and last-resort
 * error capture.
 *
 * Shutdown order matters. Log delivery is detached first (the windows it targets
 * are about to be destroyed), then IPC handlers, then the window manager — which
 * persists geometry — and only then the database, so that persistence write has
 * somewhere to go.
 */

export interface LifecycleOptions {
  readonly prepared: PreparedApplication
  /** `null` until the ready phase completes. */
  getRunning: () => RunningApplication | null
}

export function installLifecycleHandlers({ prepared, getRunning }: LifecycleOptions): void {
  const logger = prepared.context.logger.child('lifecycle')
  let shuttingDown = false

  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true

    logger.info('Shutting down', { reason })

    // Stop pushing log batches at windows that are being torn down.
    setLogBroadcastSink(null)
    flushLogBroadcast()

    const running = getRunning()
    running?.context.updates.stopAutomaticChecks()
    // Stop scans before tearing down IPC: a scan still writing results would
    // otherwise hit a closed database on its next batch.
    running?.context.scans.cancelAll()
    running?.context.partitionSearches.cancelAll()
    running?.ipc.dispose()
    running?.context.windows.dispose()

    prepared.dispose()
    shutdownLogging()
  }

  app.on('window-all-closed', () => {
    // Windows and Linux: closing the last window ends the session. There is no
    // macOS branch here because RecoverX targets Windows 10 and 11 only.
    app.quit()
  })

  app.on('before-quit', () => {
    shutdown('before-quit')
  })

  app.on('second-instance', () => {
    // The single-instance lock is held by this process; the newly launched copy
    // exits immediately, and the right response is to surface the window the
    // user was actually looking for.
    logger.debug('Second instance blocked; focusing the existing window')
    getRunning()?.context.windows.focus()
  })

  /*
   * Resolved through `getRunning` rather than captured: these handlers are
   * installed before the application context exists, and a crash during boot —
   * the one most worth recording — would otherwise find nothing to record to.
   */
  installCrashHandlers(logger, () => getRunning()?.context.crashes ?? null)
}

/**
 * Capture failures that escaped every other handler.
 *
 * Without this the process dies silently and the user sees the window vanish
 * mid-scan with nothing written down. Logging first means the incident is still
 * reconstructable from the diagnostics file.
 */
function installCrashHandlers(logger: Logger, reporter: () => CrashReporter | null): void {
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception in the main process', {
      message: describeUnknown(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    reporter()?.record('main-exception', error)
    flushLogBroadcast()
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection in the main process', {
      reason: describeUnknown(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
    reporter()?.record('main-rejection', reason)
    flushLogBroadcast()
  })

  app.on('child-process-gone', (_event, details) => {
    logger.error('A Chromium child process terminated', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    })
    reporter()?.record('child-process-gone', new Error(`${details.type}: ${details.reason}`), {
      exitCode: details.exitCode,
    })
  })
}

import { app, dialog } from 'electron'
import { APP_NAME, SUPPORT_EMAIL } from '@shared/constants/app'
import { describeUnknown } from '@shared/utils/errors'
import { prepareApplication, startApplication, type RunningApplication } from './app/bootstrap'
import { installLifecycleHandlers } from './app/lifecycle'
import { registerAppProtocolScheme } from './security/app-protocol'

/**
 * Main process entry point.
 *
 * The ordering in this file is load-bearing:
 *
 *   1. Suppress the SQLite experimental notice before any module can trigger it.
 *   2. Take the single-instance lock, and exit immediately if another copy holds
 *      it — two processes sharing one SQLite file and one log directory is a
 *      corruption hazard, not just a UX annoyance.
 *   3. Register the `app://` scheme. Chromium reads the scheme registry once,
 *      while the network service starts, so a later call is silently ignored.
 *   4. Run the synchronous preparation phase (paths, logging, database,
 *      settings), because the hardware-acceleration switch it produces has to be
 *      applied before the GPU process exists.
 *   5. Everything requiring a live Chromium happens after `whenReady`.
 */

suppressSqliteExperimentalWarning()

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  registerAppProtocolScheme()
  void boot()
}

async function boot(): Promise<void> {
  let prepared: ReturnType<typeof prepareApplication>

  try {
    prepared = prepareApplication()
  } catch (error) {
    await reportFatalError(error)
    return
  }

  let running: RunningApplication | null = null

  installLifecycleHandlers({
    prepared,
    getRunning: () => running,
  })

  try {
    await app.whenReady()
    running = startApplication(prepared)
  } catch (error) {
    prepared.context.logger.error('Startup failed', { reason: describeUnknown(error) })
    prepared.dispose()
    await reportFatalError(error)
  }
}

/**
 * Surface an unrecoverable startup failure to the user.
 *
 * A silent exit is the worst outcome here: the user double-clicks the icon,
 * nothing happens, and there is no message to search for or send to support.
 */
async function reportFatalError(error: unknown): Promise<void> {
  const message = describeUnknown(error)

  try {
    await app.whenReady()
    dialog.showErrorBox(
      `${APP_NAME} could not start`,
      `${message}\n\nIf this persists, please contact ${SUPPORT_EMAIL}.`,
    )
  } catch {
    // Chromium never became ready; there is no UI available to report through.
    console.error(`${APP_NAME} failed to start: ${message}`)
  }

  app.exit(1)
}

/**
 * Silence Node's `ExperimentalWarning` for `node:sqlite`.
 *
 * The module is compiled into the Node runtime Electron embeds and is verified
 * against the exact Electron version this app pins, so the notice carries no
 * actionable information — but it is printed on every launch and would bury real
 * warnings in development output. Only this one message is filtered; every other
 * warning still reaches stderr.
 */
function suppressSqliteExperimentalWarning(): void {
  const original = process.emitWarning.bind(process)
  const passthrough = original as unknown as (...args: unknown[]) => void

  process.emitWarning = function patched(warning: string | Error, ...rest: unknown[]): void {
    const message = typeof warning === 'string' ? warning : warning.message
    if (message.includes('SQLite is an experimental feature')) return
    passthrough(warning, ...rest)
  }
}

import { shell } from 'electron'
import { IpcChannel } from '@shared/ipc/channels'
import { AppError, ErrorCode } from '@shared/utils/errors'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Update and crash-report channels.
 *
 * `update:install` quits the application, so it is the one channel here that
 * must not be reachable while work is in flight. The renderer disables it
 * during a scan or a recovery; the check below is the one that actually stops
 * it, because a renderer that has been compromised or simply raced will not.
 */
export function registerDiagnosticsHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.UpdateGetState, async (_payload, { app: context }) =>
    Promise.resolve(context.updates.getState()),
  )

  registry.register(IpcChannel.UpdateCheck, async (_payload, { app: context }) =>
    context.updates.check(),
  )

  registry.register(IpcChannel.UpdateDownload, async (_payload, { app: context }) =>
    context.updates.download(),
  )

  registry.register(IpcChannel.UpdateInstall, async (_payload, { app: context }) => {
    if (context.scans.hasActiveWork() || context.recoveries.hasActiveWork()) {
      throw new AppError(
        ErrorCode.Validation,
        'Finish or stop the work in progress before installing an update',
        {
          details:
            'Installing restarts the application. A scan would be lost, and a recovery would leave a partly written file behind.',
          retryable: false,
        },
      )
    }

    context.updates.install()
    return Promise.resolve(undefined)
  })

  registry.register(IpcChannel.CrashList, async (_payload, { app: context }) =>
    Promise.resolve(context.crashes.list()),
  )

  registry.register(IpcChannel.CrashClear, async (_payload, { app: context }) =>
    Promise.resolve({ removed: context.crashes.clear() }),
  )

  registry.register(IpcChannel.CrashOpenFolder, async (_payload, { app: context }) => {
    await shell.openPath(context.crashes.directoryPath())
    return undefined
  })
}

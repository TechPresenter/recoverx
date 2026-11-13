import { app, dialog, shell } from 'electron'
import { IpcChannel } from '@shared/ipc/channels'
import { AppError, ErrorCode } from '@shared/utils/errors'
import { collectAppInfo, collectDiagnostics } from '../../services/diagnostics.service'
import { openExternalUrl } from '../../security/navigation-guard'
import { inspectPath, isReadable } from '../../security/path-safety'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Application-level channels: identity, diagnostics, path selection and the
 * small set of OS integrations the renderer is permitted to trigger.
 */
export function registerAppHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.AppGetInfo, (_payload, { app: context }) => collectAppInfo(context))

  registry.register(IpcChannel.AppGetDiagnostics, async (_payload, { app: context }) =>
    collectDiagnostics(context),
  )

  registry.register(IpcChannel.AppOpenExternal, async ({ url }, { app: context }) => {
    // The host allowlist is enforced inside `openExternalUrl`, not here, so the
    // same policy applies to links opened through the window-open handler.
    await openExternalUrl(url, context.logger)
  })

  registry.register(IpcChannel.AppRevealPath, async ({ path }) => {
    if (!(await isReadable(path))) {
      throw new AppError(ErrorCode.NotFound, 'That location no longer exists', {
        details: path,
        retryable: false,
      })
    }

    shell.showItemInFolder(path)
  })

  registry.register(IpcChannel.AppPickDirectory, async (payload, { app: context }) => {
    const window = context.windows.getMainWindow()

    const options = {
      title: payload.title ?? 'Select a folder',
      // `createDirectory` lets the user make a destination folder inline, which
      // matters because the safest destination is usually one that does not
      // exist yet on another drive.
      properties: ['openDirectory', 'createDirectory'] as const,
      ...(payload.defaultPath === undefined ? {} : { defaultPath: payload.defaultPath }),
    }

    const result =
      window === null
        ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
        : await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })

    if (result.canceled || result.filePaths.length === 0) {
      return { path: null }
    }

    return { path: result.filePaths[0] ?? null }
  })

  registry.register(IpcChannel.AppValidatePath, async ({ path }) => inspectPath(path))

  registry.register(IpcChannel.AppRelaunch, (_payload, { app: context }) => {
    context.logger.info('Relaunch requested')

    // The IPC reply has to be delivered before the process tears itself down,
    // otherwise the renderer sees a dropped call and reports a failure to the
    // user for an operation that actually succeeded.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 150).unref()
  })
}

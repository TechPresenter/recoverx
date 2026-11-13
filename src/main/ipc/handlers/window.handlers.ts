import { IpcChannel } from '@shared/ipc/channels'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Window control channels.
 *
 * The main window is frameless so the title bar can host the global search and
 * scan status the way commercial recovery suites do. That moves minimise,
 * maximise and close from the OS into the application, which is what these
 * channels provide.
 */
export function registerWindowHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.WindowMinimize, (_payload, { app: context }) => {
    context.windows.minimize()
  })

  registry.register(IpcChannel.WindowToggleMaximize, (_payload, { app: context }) =>
    context.windows.toggleMaximize(),
  )

  registry.register(IpcChannel.WindowClose, (_payload, { app: context }) => {
    context.windows.close()
  })

  registry.register(IpcChannel.WindowGetState, (_payload, { app: context }) =>
    context.windows.getState(),
  )
}

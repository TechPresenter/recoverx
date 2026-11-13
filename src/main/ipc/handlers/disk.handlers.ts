import { IpcChannel } from '@shared/ipc/channels'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Storage device channels.
 *
 * `disk:list` serves the cached inventory when one exists. Enumeration takes a
 * couple of seconds — it queries three CIM providers and opens every physical
 * device — so re-running it every time the user navigates back to the device
 * list would make the application feel broken.
 */
export function registerDiskHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.DiskList, async (_payload, { app: context }) => {
    const cached = context.disks.getCached()
    if (cached !== null) return cached

    return context.disks.refresh()
  })

  registry.register(IpcChannel.DiskRefresh, async (_payload, { app: context }) =>
    context.disks.refresh(),
  )
}

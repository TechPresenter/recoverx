import { IpcChannel } from '@shared/ipc/channels'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Licensing channels.
 *
 * The recovered-byte total that the Free edition's ceiling is measured against
 * is read from the recovery history on every call rather than tracked
 * separately. There is then exactly one figure, it survives a restart, and it
 * cannot be reset by clearing a preference — while remaining something the user
 * can audit, because every job it counts is listed on the History screen.
 */
export function registerLicenseHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.LicenseGetStatus, async (_payload, { app: context }) =>
    Promise.resolve(context.licensing.status(context.recoveries.totalRecoveredBytes())),
  )

  registry.register(IpcChannel.LicenseActivate, async (payload, { app: context }) =>
    context.licensing.activate(payload),
  )

  registry.register(IpcChannel.LicenseActivateOffline, async (payload, { app: context }) =>
    Promise.resolve(context.licensing.activateOffline(payload)),
  )

  registry.register(IpcChannel.LicenseDeactivate, async (_payload, { app: context }) =>
    Promise.resolve(context.licensing.deactivate(context.recoveries.totalRecoveredBytes())),
  )

  registry.register(IpcChannel.LicenseCheckRenewal, async (_payload, { app: context }) =>
    context.licensing.checkForRenewal(context.recoveries.totalRecoveredBytes()),
  )
}

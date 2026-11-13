import { IpcChannel } from '@shared/ipc/channels'
import { AppError, ErrorCode } from '@shared/utils/errors'
import { inspectPath } from '../../security/path-safety'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Settings channels.
 *
 * The recovery destination is validated here rather than only in the UI: it is
 * the one setting with data-loss consequences, and a value that reached the
 * database through any other path would still be trusted by the recovery
 * pipeline later.
 */
export function registerSettingsHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.SettingsGetAll, (_payload, { app: context }) =>
    context.settings.getAll(),
  )

  registry.register(IpcChannel.SettingsUpdate, async ({ patch }, { app: context }) => {
    if (patch.defaultRecoveryPath !== undefined) {
      await assertUsableRecoveryPath(patch.defaultRecoveryPath)
    }

    return context.settings.update(patch)
  })

  registry.register(IpcChannel.SettingsReset, (_payload, { app: context }) =>
    context.settings.reset(),
  )
}

/**
 * Reject a recovery destination that cannot actually receive files.
 *
 * Discovering this at the end of a two-hour scan, with the results already
 * enumerated, is the worst possible moment — so the check happens when the
 * setting is chosen.
 */
async function assertUsableRecoveryPath(path: string): Promise<void> {
  const inspection = await inspectPath(path)

  if (!inspection.exists) {
    throw new AppError(ErrorCode.NotFound, 'That folder does not exist', {
      details: path,
      retryable: false,
    })
  }

  if (!inspection.isDirectory) {
    throw new AppError(ErrorCode.Validation, 'The recovery destination must be a folder', {
      details: path,
      retryable: false,
    })
  }

  if (!inspection.isWritable) {
    throw new AppError(ErrorCode.PermissionDenied, 'That folder cannot be written to', {
      details: path,
      retryable: false,
    })
  }
}

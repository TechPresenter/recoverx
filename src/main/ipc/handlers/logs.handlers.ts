import { shell } from 'electron'
import { IpcChannel } from '@shared/ipc/channels'
import { AppError, ErrorCode } from '@shared/utils/errors'
import { getActiveLogFileName, getLogger } from '../../logging/logger'
import { clearLogs, listLogFiles, queryLogs } from '../../logging/log-reader'
import { ensureDirectory } from '../../security/path-safety'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Diagnostics log channels.
 *
 * Exposing the log through the UI, with filtering and full-text search, is what
 * lets a user answer "what actually happened" without being asked to find a
 * folder under %APPDATA% and attach a file to an email.
 */
export function registerLogsHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.LogsListFiles, async (_payload, { app: context }) =>
    listLogFiles(context.paths.logs, getActiveLogFileName()),
  )

  registry.register(IpcChannel.LogsQuery, async (query, { app: context }) =>
    queryLogs(context.paths.logs, query, getActiveLogFileName()),
  )

  registry.register(IpcChannel.LogsOpenFolder, async (_payload, { app: context }) => {
    // The directory is created during boot, but a user can delete it while the
    // app is running; recreating it is friendlier than an error dialog.
    await ensureDirectory(context.paths.logs)

    const failure = await shell.openPath(context.paths.logs)
    if (failure.length > 0) {
      throw new AppError(ErrorCode.Io, 'Could not open the log folder', {
        details: failure,
        retryable: true,
      })
    }
  })

  registry.register(IpcChannel.LogsClear, async (_payload, { app: context }) => {
    const result = await clearLogs(context.paths.logs, getActiveLogFileName())

    context.logger.info('Diagnostics logs cleared', {
      removedFiles: result.removedFiles,
      freedBytes: result.freedBytes,
    })

    return result
  })

  registry.register(IpcChannel.LogsWrite, (record) => {
    // Renderer records are tagged with their own scope so a support engineer can
    // tell a UI-side failure from a main-process one at a glance.
    const logger = getLogger(`renderer:${record.scope}`)

    switch (record.level) {
      case 'error':
        logger.error(record.message, record.meta)
        break
      case 'warn':
        logger.warn(record.message, record.meta)
        break
      case 'info':
        logger.info(record.message, record.meta)
        break
      case 'debug':
        logger.debug(record.message, record.meta)
        break
    }
  })
}

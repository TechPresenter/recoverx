import { IpcChannel } from '@shared/ipc/channels'
import { ScanRepository } from '../../database/repositories/scan.repository'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Scanning channels.
 *
 * `scan:start` returns as soon as the session exists rather than when the scan
 * finishes — a scan can run for hours, and blocking the IPC call for its
 * duration would hold a channel open and give the renderer nothing to display.
 * Progress arrives on `evt:scan-progress` instead.
 */
export function registerScanHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.ScanStart, (request, { app: context }) =>
    context.scans.start(request),
  )

  registry.register(IpcChannel.ScanPause, ({ sessionId }, { app: context }) => {
    context.scans.pause(sessionId)
  })

  registry.register(IpcChannel.ScanResume, ({ sessionId }, { app: context }) => {
    context.scans.resume(sessionId)
  })

  registry.register(IpcChannel.ScanCancel, ({ sessionId }, { app: context }) => {
    context.scans.cancel(sessionId)
  })

  registry.register(IpcChannel.ScanGetProgress, ({ sessionId }, { app: context }) =>
    context.scans.getProgress(sessionId),
  )

  registry.register(IpcChannel.ScanListSessions, (_payload, { app: context }) =>
    new ScanRepository(context.database.db).listSessions(),
  )

  registry.register(IpcChannel.ScanGetSession, ({ sessionId }, { app: context }) =>
    new ScanRepository(context.database.db).getSession(sessionId),
  )

  registry.register(IpcChannel.ScanDeleteSession, ({ sessionId }, { app: context }) => {
    // Cancel first: deleting the session row while a scan is still writing to
    // it would fail every subsequent insert on a foreign-key constraint.
    if (context.scans.isActive(sessionId)) context.scans.cancel(sessionId)

    new ScanRepository(context.database.db).deleteSession(sessionId)
  })

  registry.register(IpcChannel.ScanQueryFiles, (filter, { app: context }) =>
    new ScanRepository(context.database.db).queryFiles(filter),
  )

  registry.register(IpcChannel.ScanListFolders, ({ sessionId }, { app: context }) =>
    new ScanRepository(context.database.db).listFolders(sessionId),
  )

  registry.register(IpcChannel.ScanSummariseSelection, (selection, { app: context }) =>
    new ScanRepository(context.database.db).summariseSelection(selection),
  )
}

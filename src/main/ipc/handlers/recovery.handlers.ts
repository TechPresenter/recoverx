import { IpcChannel } from '@shared/ipc/channels'
import { RecoveryRepository } from '../../database/repositories/recovery.repository'
import { describeProblem } from '../../recovery/destination-guard'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Recovery channels.
 *
 * The destination check is its own channel so the UI can refuse an unsafe
 * folder while the user is still choosing it, rather than after they commit.
 * Its response carries the explanation, not just the code, because the reason
 * a destination is refused is the part the user needs.
 */
export function registerRecoveryHandlers(registry: IpcRegistry): void {
  registry.register(
    IpcChannel.RecoveryCheckDestination,
    async ({ selection, destination }, { app: context }) => {
      const check = await context.recoveries.checkDestination(selection, destination)

      return {
        path: check.path,
        isUsable: check.isUsable,
        problem: check.problem,
        message: describeProblem(check.problem),
        freeBytes: check.freeBytes,
        totalBytes: check.totalBytes,
      }
    },
  )

  registry.register(IpcChannel.RecoveryStart, async (request, { app: context }) =>
    context.recoveries.start(request),
  )

  registry.register(IpcChannel.RecoveryPause, ({ jobId }, { app: context }) => {
    context.recoveries.pause(jobId)
  })

  registry.register(IpcChannel.RecoveryResume, ({ jobId }, { app: context }) => {
    context.recoveries.resume(jobId)
  })

  registry.register(IpcChannel.RecoveryCancel, ({ jobId }, { app: context }) => {
    context.recoveries.cancel(jobId)
  })

  registry.register(IpcChannel.RecoveryGetProgress, ({ jobId }, { app: context }) =>
    context.recoveries.getProgress(jobId),
  )

  registry.register(IpcChannel.RecoveryListJobs, (_payload, { app: context }) =>
    new RecoveryRepository(context.database.db).listJobs(),
  )

  registry.register(IpcChannel.RecoveryListItems, (filter, { app: context }) =>
    new RecoveryRepository(context.database.db).listItems(filter),
  )

  registry.register(IpcChannel.RecoveryDeleteJob, ({ jobId }, { app: context }) => {
    // Stop the run first: deleting the job row while it is still writing
    // outcomes would fail every subsequent insert on a foreign-key constraint.
    if (context.recoveries.isActive(jobId)) context.recoveries.cancel(jobId)

    new RecoveryRepository(context.database.db).deleteJob(jobId)
  })
}

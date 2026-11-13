import { IpcChannel } from '@shared/ipc/channels'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Drive health channels.
 *
 * `health:get` serves the cached reading. Querying SMART spins up PowerShell
 * and talks to the storage driver, which takes seconds and — on a drive that is
 * already struggling — can block for considerably longer, so it must not run
 * every time the user navigates back to the screen.
 *
 * Every successful refresh is offered to the history table. Trend is what
 * actually predicts failure: a reallocated sector count that has been steady
 * for a year means something very different from the same count reached last
 * week, and one reading cannot tell them apart.
 */
export function registerHealthHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.HealthGet, async (_payload, { app: context }) => {
    const cached = context.health.getCached()
    if (cached !== null) return cached

    return recordAll(context)
  })

  registry.register(IpcChannel.HealthRefresh, async (_payload, { app: context }) =>
    recordAll(context),
  )

  registry.register(IpcChannel.HealthHistory, async (payload, { app: context }) =>
    Promise.resolve(context.healthHistory.history(payload.deviceId, payload.limit ?? 500)),
  )
}

type Context = Parameters<Parameters<IpcRegistry['register']>[1]>[1]['app']

/**
 * Take a reading and file it.
 *
 * A failure to store history must not lose the reading the user asked for: the
 * live figures are the point of the screen, and the chart is a bonus.
 */
async function recordAll(context: Context) {
  const report = await context.health.refresh()

  for (const drive of report.drives) {
    try {
      context.healthHistory.record(drive)
    } catch (error) {
      context.logger.warn('A health reading could not be stored', {
        deviceId: drive.deviceId,
        error: String(error),
      })
    }
  }

  return report
}

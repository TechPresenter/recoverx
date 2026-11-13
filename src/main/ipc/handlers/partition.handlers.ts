import { IpcChannel } from '@shared/ipc/channels'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Lost-partition channels.
 *
 * A search runs for as long as the disk takes to read, so `partition:search-start`
 * returns the moment the search is registered and progress arrives on
 * `evt:partition-progress`. `partition:search-get` re-reads the same envelope,
 * which is what lets a renderer that was reloaded mid-search pick it back up.
 *
 * `partition:adopt` is the bridge to the rest of the application: it folds the
 * found volumes into the cached device inventory as recovered partitions, after
 * which they are ordinary scan targets. Nothing is written to the disk — the
 * adoption exists only in this process's model of it.
 */
export function registerPartitionHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.PartitionSearchStart, async (payload, { app: context }) =>
    Promise.resolve(context.partitionSearches.start(payload)),
  )

  registry.register(IpcChannel.PartitionSearchCancel, async (payload, { app: context }) => {
    context.partitionSearches.cancel(payload.searchId)
    return Promise.resolve(undefined)
  })

  registry.register(IpcChannel.PartitionSearchGet, async (payload, { app: context }) =>
    Promise.resolve(context.partitionSearches.getResult(payload.searchId)),
  )

  registry.register(IpcChannel.PartitionAdopt, async (payload, { app: context }) => {
    const result = context.partitionSearches.getResult(payload.searchId)

    return Promise.resolve(
      context.disks.adoptRecoveredPartitions(result.deviceId, result.candidates),
    )
  })
}

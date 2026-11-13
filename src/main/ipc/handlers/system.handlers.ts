import { IpcChannel } from '@shared/ipc/channels'
import { captureSystemSnapshot } from '../../services/system-info.service'
import type { IpcRegistry } from '../ipc-registry'

/**
 * Host telemetry channels.
 *
 * The Dashboard polls this while it is visible; the snapshot is cheap because
 * it reads only `os` counters and the process's own memory usage.
 */
export function registerSystemHandlers(registry: IpcRegistry): void {
  registry.register(IpcChannel.SystemGetSnapshot, async () => captureSystemSnapshot())
}

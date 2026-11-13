import type { AppContext } from '../app/context'
import { IpcRegistry } from './ipc-registry'
import { registerAppHandlers } from './handlers/app.handlers'
import { registerDiskHandlers } from './handlers/disk.handlers'
import { registerHealthHandlers } from './handlers/health.handlers'
import { registerDiagnosticsHandlers } from './handlers/diagnostics.handlers'
import { registerLicenseHandlers } from './handlers/license.handlers'
import { registerLogsHandlers } from './handlers/logs.handlers'
import { registerPartitionHandlers } from './handlers/partition.handlers'
import { registerPreviewHandlers } from './handlers/preview.handlers'
import { registerRecoveryHandlers } from './handlers/recovery.handlers'
import { registerScanHandlers } from './handlers/scan.handlers'
import { registerSettingsHandlers } from './handlers/settings.handlers'
import { registerSystemHandlers } from './handlers/system.handlers'
import { registerWindowHandlers } from './handlers/window.handlers'

/**
 * Build the complete IPC surface.
 *
 * `assertComplete` runs last and fails the boot if any channel declared in the
 * contract has no handler — the alternative is discovering the gap when a user
 * clicks the feature that needs it.
 */
export function createIpcSurface(context: AppContext): IpcRegistry {
  const registry = new IpcRegistry(context)

  registerAppHandlers(registry)
  registerWindowHandlers(registry)
  registerSettingsHandlers(registry)
  registerSystemHandlers(registry)
  registerLogsHandlers(registry)
  registerDiskHandlers(registry)
  registerDiagnosticsHandlers(registry)
  registerLicenseHandlers(registry)
  registerHealthHandlers(registry)
  registerPartitionHandlers(registry)
  registerScanHandlers(registry)
  registerPreviewHandlers(registry)
  registerRecoveryHandlers(registry)

  registry.assertComplete()

  return registry
}

export { IpcRegistry } from './ipc-registry'

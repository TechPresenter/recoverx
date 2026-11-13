import type { AppPaths } from '../config/paths'
import type { RuntimeConfig } from '../config/runtime'
import type { DatabaseConnection } from '../database/connection'
import type { DiskService } from '../disk/disk.service'
import type { Logger } from '../logging/logger'
import type { HealthRepository } from '../database/repositories/health.repository'
import type { HealthService } from '../health/health.service'
import type { CrashReporter } from '../diagnostics/crash-reporter'
import type { LicenseService } from '../licensing/license.service'
import type { UpdateService } from '../updates/update.service'
import type { PartitionSearchManager } from '../disk/partition-search.service'
import type { PreviewService } from '../preview/preview.service'
import type { RecoveryManager } from '../recovery/recovery.service'
import type { ScanManager } from '../scan/scan-session'
import type { SettingsService } from '../services/settings.service'
import type { StartupMetrics } from './startup-metrics'
import type { WindowManager } from './window-manager'

/**
 * The application's composition root, assembled once during boot.
 *
 * Services receive their collaborators through this object rather than reaching
 * for module-level singletons. That keeps the dependency graph explicit — it is
 * readable straight off this interface — and it lets a test construct a context
 * with a temporary database and an in-memory logger without touching global
 * state.
 */
export interface AppContext {
  readonly config: RuntimeConfig
  readonly paths: AppPaths
  readonly logger: Logger
  readonly database: DatabaseConnection
  readonly settings: SettingsService
  readonly disks: DiskService
  readonly licensing: LicenseService
  readonly updates: UpdateService
  readonly crashes: CrashReporter
  readonly health: HealthService
  readonly healthHistory: HealthRepository
  readonly partitionSearches: PartitionSearchManager
  readonly scans: ScanManager
  readonly previews: PreviewService
  readonly recoveries: RecoveryManager
  readonly windows: WindowManager
  readonly startup: StartupMetrics
}

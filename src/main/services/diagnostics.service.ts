import { app } from 'electron'
import type { AppInfo, Diagnostics } from '@shared/types/system'
import { APP_NAME } from '@shared/constants/app'
import type { AppContext } from '../app/context'
import { countAppliedMigrations, readCurrentVersion } from '../database/migrator'
import { measureLogDirectory } from '../logging/log-reader'

/**
 * Build identity and internal health.
 *
 * Both are surfaced in the About screen and copied into support bundles. When a
 * user reports "it did not find my drive", the first question is always which
 * build, on which OS, with which schema version — having that one click away
 * removes an entire round trip from every support conversation.
 */

/** Static identity of the running build. */
export function collectAppInfo(context: AppContext): AppInfo {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    isPackaged: context.config.isPackaged,
    channel: context.config.channel,
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    runtime: {
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      v8: process.versions.v8,
    },
  }
}

/** Live health of the application's own infrastructure. */
export async function collectDiagnostics(context: AppContext): Promise<Diagnostics> {
  const logs = await measureLogDirectory(context.paths.logs)

  return {
    startupMs: context.startup.startupMs,
    userDataDir: context.paths.userData,
    databasePath: context.database.path,
    databaseSizeBytes: context.database.sizeBytes(),
    schemaVersion: readCurrentVersion(context.database.db),
    appliedMigrations: countAppliedMigrations(context.database.db),
    logDirectory: context.paths.logs,
    logSizeBytes: logs.sizeBytes,
    logFileCount: logs.fileCount,
  }
}

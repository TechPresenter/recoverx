import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DATABASE_FILE_NAME, LOG_DIR_NAME } from '@shared/constants/app'

/**
 * Filesystem layout.
 *
 * Every path the application writes to is resolved here, once, so there is a
 * single place to audit what RecoverX touches on a user's machine — which
 * matters for a tool that is trusted to run elevated against raw block devices.
 */

export interface AppPaths {
  /** %APPDATA%/RecoverX (or the RECOVERX_USER_DATA_DIR override). */
  readonly userData: string
  /** SQLite database file. */
  readonly database: string
  /** Directory holding the rotated diagnostics logs. */
  readonly logs: string
  /** Scratch space for previews and extraction buffers. */
  readonly temp: string
  /** Default destination offered for recovered files. */
  readonly defaultRecovery: string
}

let cached: AppPaths | null = null

/**
 * Apply the development-only user-data override.
 *
 * MUST run before anything reads `app.getPath('userData')`, and therefore before
 * the database is opened. Keeping a dev session out of an installed copy's data
 * directory prevents a debug build from migrating a paying customer's database
 * to an unreleased schema.
 */
export function applyUserDataOverride(overridePath: string | undefined): void {
  if (overridePath === undefined || overridePath.trim().length === 0) return
  if (app.isPackaged) return

  const resolved = overridePath.trim()
  mkdirSync(resolved, { recursive: true })
  app.setPath('userData', resolved)
}

/**
 * Resolve — and create — the application's directories.
 * Cached because it is read on every diagnostics request.
 */
export function resolveAppPaths(): AppPaths {
  if (cached !== null) return cached

  const userData = app.getPath('userData')

  const paths: AppPaths = {
    userData,
    database: join(userData, DATABASE_FILE_NAME),
    logs: join(userData, LOG_DIR_NAME),
    temp: join(userData, 'temp'),
    defaultRecovery: join(app.getPath('documents'), 'RecoverX Recovered'),
  }

  // The logs and temp directories are created eagerly: the logger needs its
  // directory before the first record, and creating it lazily inside a transport
  // hides permission failures until the first write.
  mkdirSync(paths.logs, { recursive: true })
  mkdirSync(paths.temp, { recursive: true })

  cached = paths
  return paths
}

/** Reset the cache. Used by tests that relocate the user-data directory. */
export function resetPathCache(): void {
  cached = null
}

import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import type { Logger } from '../logging/logger'
import { type SqliteDatabase, checkpoint, openSqlite, pragmaGet } from './sqlite'

/**
 * Application database lifecycle.
 *
 * The database is opened synchronously during boot. `node:sqlite` is a
 * synchronous driver, and at a few milliseconds for open plus migration that is
 * cheaper than the async ceremony would cost — while removing every race
 * between "the app is starting" and "settings are readable".
 */

export interface DatabaseConnection {
  readonly db: SqliteDatabase
  readonly path: string
  /** On-disk size, including the WAL and shared-memory side files. */
  sizeBytes(): number
  /** Checkpoint the WAL and release the handle. */
  close(): void
}

export interface OpenDatabaseOptions {
  readonly filePath: string
  readonly logger: Logger
  /**
   * When `true` (the default), a database that fails its integrity check is
   * moved aside and recreated rather than blocking startup.
   */
  readonly quarantineOnCorruption?: boolean
}

/**
 * Open the application database, creating the file and its parent directory as
 * needed.
 *
 * Corruption handling is a deliberate product decision: the user most likely to
 * hold a damaged settings database is the one whose drive just failed — exactly
 * the user who cannot afford the application to refuse to start. A corrupt file
 * is renamed aside, never deleted, so support can still extract an activation
 * record from it, and a fresh database takes its place.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseConnection {
  const { filePath, logger } = options
  const quarantineOnCorruption = options.quarantineOnCorruption ?? true

  mkdirSync(dirname(filePath), { recursive: true })

  let db: SqliteDatabase

  try {
    db = openHealthy(filePath)
  } catch (error) {
    if (!quarantineOnCorruption) {
      throw new AppError(ErrorCode.Database, 'Unable to open the settings database', {
        details: describeUnknown(error),
        cause: error,
        retryable: false,
      })
    }

    let quarantinePath: string
    try {
      quarantinePath = quarantine(filePath)
    } catch (quarantineError) {
      throw new AppError(
        ErrorCode.Database,
        'The settings database is damaged and cannot be replaced',
        {
          details: describeUnknown(quarantineError),
          cause: quarantineError,
          retryable: false,
        },
      )
    }

    logger.error('Settings database was unreadable and has been moved aside', {
      original: filePath,
      quarantined: quarantinePath,
      reason: describeUnknown(error),
    })

    try {
      db = openHealthy(filePath)
    } catch (retryError) {
      throw new AppError(ErrorCode.Database, 'Unable to create a new settings database', {
        details: describeUnknown(retryError),
        cause: retryError,
        retryable: false,
      })
    }
  }

  logger.debug('Database connection established', { path: filePath })

  let closed = false

  return {
    db,
    path: filePath,
    sizeBytes: () => measureDatabase(filePath),
    close: () => {
      if (closed) return
      closed = true
      checkpoint(db)
      db.close()
    },
  }
}

/** Compose the database path from a user-data directory. */
export function resolveDatabasePath(userDataDir: string, fileName: string): string {
  return join(userDataDir, fileName)
}

// --- internals -------------------------------------------------------------

/**
 * Open a connection and verify it, closing the handle if either step fails.
 *
 * Closing on failure is what makes quarantine possible: Windows refuses to
 * rename a file that still has an open handle.
 */
function openHealthy(filePath: string): SqliteDatabase {
  const db = openSqlite(filePath)

  try {
    assertHealthy(db)
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // Reported through the original error.
    }
    throw error
  }
}

/**
 * Cheap structural check.
 *
 * `quick_check` validates page structure and index integrity without the full
 * table scan `integrity_check` performs, keeping startup fast even once the
 * recovery history has grown large.
 */
function assertHealthy(db: SqliteDatabase): void {
  const row = pragmaGet(db, 'quick_check(1)')
  const verdict = row === undefined ? 'unknown' : String(Object.values(row)[0] ?? 'unknown')

  if (verdict !== 'ok') {
    throw new AppError(ErrorCode.Database, 'Database failed its integrity check', {
      details: verdict,
      retryable: false,
    })
  }
}

/**
 * Move a damaged database and its WAL side files out of the way.
 * Returns the path the main file was moved to.
 */
function quarantine(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const quarantinePath = `${filePath}.corrupt-${stamp}`

  // Deliberately not caught. If the main file cannot be moved — a stale handle,
  // a read-only volume — then reopening would just hit the same corrupt file
  // and report a misleading "could not create database" error. The caller turns
  // this into an accurate message instead.
  if (existsSync(filePath)) {
    renameSync(filePath, quarantinePath)
  }

  // The WAL and shared-memory files are rebuilt from scratch on the next open,
  // so losing them costs nothing and must not fail the recovery.
  for (const suffix of ['-wal', '-shm']) {
    const source = `${filePath}${suffix}`
    if (!existsSync(source)) continue

    try {
      renameSync(source, `${quarantinePath}${suffix}`)
    } catch {
      continue
    }
  }

  return quarantinePath
}

/** Sum the main database file and its WAL/SHM companions. */
function measureDatabase(filePath: string): number {
  let total = 0

  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(`${filePath}${suffix}`).size
    } catch {
      continue
    }
  }

  return total
}

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'

/**
 * Thin, typed wrapper over Node's built-in SQLite driver.
 *
 * Why `node:sqlite` rather than `better-sqlite3`:
 *
 *  - `better-sqlite3` ships no Windows prebuilds, so every install compiles the
 *    amalgamation from source and requires a ~6 GB Visual Studio C++ toolchain
 *    on the developer machine *and* on every CI runner.
 *  - A compiled addon is also bound to one ABI. Rebuilt for Electron it cannot
 *    be loaded by a plain Node test process, which pushes all database coverage
 *    out of the unit suite and into a slow end-to-end harness.
 *  - `node:sqlite` is compiled into the Node runtime that Electron already
 *    embeds. Verified against Electron 43.2.0 / Node 24.18.0: WAL journalling,
 *    pragmas, transactions, upserts, `quick_check` and `wal_checkpoint` all
 *    behave identically to the addon.
 *
 * The cost is a narrower API — no `.pragma()` or `.transaction()` helper, and
 * untyped result rows — which is exactly what this module supplies.
 */

export type SqliteDatabase = DatabaseSync
export type SqliteStatement = StatementSync

/** A result row as the driver returns it: column name to primitive. */
export type SqliteRow = Record<string, null | number | bigint | string | NodeJS.TypedArray>

export interface OpenSqliteOptions {
  /** Milliseconds to wait on a locked database before failing. */
  readonly busyTimeoutMs?: number
  readonly readOnly?: boolean
}

/**
 * Open a database file and apply the connection pragmas.
 *
 *  - `journal_mode = WAL` lets the Logs screen read while a settings write
 *    commits; a rollback journal would serialise them.
 *  - `synchronous = NORMAL` is the correct pairing with WAL — durable across an
 *    application crash, at risk only from OS-level power loss, which is an
 *    acceptable trade for a settings database.
 *  - `temp_store = MEMORY` and a negative `cache_size` (KiB) keep sort and join
 *    scratch space off the very disk the user may be trying to recover.
 */
export function openSqlite(filePath: string, options: OpenSqliteOptions = {}): SqliteDatabase {
  const db = new DatabaseSync(filePath, {
    open: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    readOnly: options.readOnly ?? false,
    timeout: options.busyTimeoutMs ?? 5000,
  })

  try {
    // `journal_mode` returns a row, so it must go through prepare/get rather
    // than exec; the rest are plain statements.
    db.prepare('PRAGMA journal_mode = WAL').get()
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA temp_store = MEMORY')
    db.exec('PRAGMA cache_size = -8000')

    return db
  } catch (error) {
    // `sqlite3_open_v2` does not read the file header, so opening a corrupt or
    // non-SQLite file succeeds and the first pragma is what fails. The handle is
    // already open at that point: leaving it dangling would keep an OS file lock
    // on Windows and block the caller from moving the bad file aside.
    try {
      db.close()
    } catch {
      // Nothing further can be done with a connection that will not close.
    }
    throw error
  }
}

/** Read a single-row pragma, e.g. `quick_check(1)`. */
export function pragmaGet(db: SqliteDatabase, pragma: string): SqliteRow | undefined {
  return db.prepare(`PRAGMA ${pragma}`).get()
}

const transactionDepth = new WeakMap<SqliteDatabase, number>()

/**
 * Run `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * Nested calls become savepoints rather than a second `BEGIN`, which SQLite
 * would reject. `BEGIN IMMEDIATE` takes the write lock up front: deferring it
 * lets two connections both start a read transaction and then deadlock when
 * each tries to upgrade.
 */
export function withTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  const depth = transactionDepth.get(db) ?? 0
  const isOutermost = depth === 0
  const savepoint = `recoverx_sp_${depth}`

  db.exec(isOutermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
  transactionDepth.set(db, depth + 1)

  let result: T
  try {
    result = fn()
  } catch (error) {
    transactionDepth.set(db, depth)
    try {
      db.exec(isOutermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
    } catch {
      // The connection may already have unwound the transaction itself; the
      // original error is what the caller needs to see.
    }
    throw error
  }

  transactionDepth.set(db, depth)
  db.exec(isOutermost ? 'COMMIT' : `RELEASE ${savepoint}`)
  return result
}

/**
 * Checkpoint the write-ahead log into the main database file.
 * Called before close so the next start has no WAL to replay and the reported
 * on-disk size reflects reality.
 */
export function checkpoint(db: SqliteDatabase): void {
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  } catch {
    // A busy checkpoint is not a reason to block shutdown.
  }
}

// --- typed column readers --------------------------------------------------
//
// The driver returns `Record<string, primitive>`, so every column access is an
// unchecked widening. These readers turn a schema/scheme mismatch into a
// precise, logged error at the point of access rather than an `undefined`
// propagating into application state.

export function readText(row: SqliteRow, column: string): string {
  const value = row[column]
  if (typeof value === 'string') return value
  throw columnTypeError(column, 'text', value)
}

export function readOptionalText(row: SqliteRow, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  throw columnTypeError(column, 'text or null', value)
}

export function readInteger(row: SqliteRow, column: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw columnTypeError(column, 'integer', value)
}

export function readOptionalInteger(row: SqliteRow, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw columnTypeError(column, 'integer or null', value)
}

/** SQLite has no boolean type; the schema stores 0/1 with a CHECK constraint. */
export function readBoolean(row: SqliteRow, column: string): boolean {
  return readInteger(row, column) !== 0
}

/**
 * Normalise the `changes` count from a write, which the driver may return as a
 * bigint for large values.
 */
export function toChangeCount(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}

function columnTypeError(column: string, expected: string, actual: unknown): AppError {
  return new AppError(ErrorCode.Database, `Column "${column}" did not hold ${expected}`, {
    details: `received ${actual === null ? 'null' : typeof actual}`,
    retryable: false,
  })
}

/** Wrap a driver failure in an `AppError` carrying the operation that failed. */
export function databaseError(operation: string, error: unknown): AppError {
  return new AppError(ErrorCode.Database, `Database operation failed: ${operation}`, {
    details: describeUnknown(error),
    cause: error,
  })
}

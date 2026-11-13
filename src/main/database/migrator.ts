import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import type { Logger } from '../logging/logger'
import { type Migration, latestVersion, planMigrations } from './migration-plan'
import { MIGRATIONS } from './migrations'
import { type SqliteDatabase, readInteger, readOptionalInteger, withTransaction } from './sqlite'

/**
 * Applies schema migrations.
 *
 * Planning and validation live in `migration-plan.ts` and are pure; this module
 * is only the execution shell around them.
 */

export interface MigrationOutcome {
  readonly fromVersion: number
  readonly toVersion: number
  readonly applied: readonly string[]
  readonly durationMs: number
}

const SCHEMA_TABLE = 'schema_migrations'

/**
 * Bring the database up to the latest schema version.
 *
 * Each migration runs inside a transaction *together with* the bookkeeping row
 * that records it. That pairing is what makes the process crash-safe: it is
 * impossible to end up with a schema change whose version was not recorded, or
 * a recorded version whose change did not apply.
 */
export function runMigrations(
  db: SqliteDatabase,
  logger: Logger,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationOutcome {
  const startedAt = Date.now()

  ensureBookkeepingTable(db)

  const fromVersion = readCurrentVersion(db)
  const pending = planMigrations(migrations, fromVersion)

  if (pending.length === 0) {
    logger.debug('Database schema is up to date', { version: fromVersion })
    return { fromVersion, toVersion: fromVersion, applied: [], durationMs: Date.now() - startedAt }
  }

  logger.info('Applying database migrations', {
    from: fromVersion,
    to: latestVersion(migrations),
    pending: pending.length,
  })

  const record = db.prepare(
    `INSERT INTO ${SCHEMA_TABLE} (version, name, applied_at, duration_ms) VALUES (?, ?, ?, ?)`,
  )

  const applied: string[] = []

  for (const migration of pending) {
    const migrationStartedAt = Date.now()

    try {
      withTransaction(db, () => {
        migration.up(db)
        record.run(migration.version, migration.name, Date.now(), Date.now() - migrationStartedAt)
      })
    } catch (error) {
      throw new AppError(
        ErrorCode.Database,
        `Migration ${migration.version} ("${migration.name}") failed`,
        { details: describeUnknown(error), cause: error, retryable: false },
      )
    }

    applied.push(`${migration.version}-${migration.name}`)
    logger.debug('Migration applied', {
      version: migration.version,
      name: migration.name,
      durationMs: Date.now() - migrationStartedAt,
    })
  }

  const toVersion = readCurrentVersion(db)

  logger.info('Database migrations complete', {
    from: fromVersion,
    to: toVersion,
    durationMs: Date.now() - startedAt,
  })

  return { fromVersion, toVersion, applied, durationMs: Date.now() - startedAt }
}

/** Highest migration version recorded. `0` for a fresh database. */
export function readCurrentVersion(db: SqliteDatabase): number {
  const row = db.prepare(`SELECT MAX(version) AS version FROM ${SCHEMA_TABLE}`).get()
  if (row === undefined) return 0
  return readOptionalInteger(row, 'version') ?? 0
}

/** Number of migrations recorded as applied. */
export function countAppliedMigrations(db: SqliteDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${SCHEMA_TABLE}`).get()
  return row === undefined ? 0 : readInteger(row, 'total')
}

/**
 * Create the bookkeeping table if this is a fresh database.
 *
 * Owned by the migrator rather than by migration 1, because the migrator has to
 * read this table before it can decide what to run.
 */
function ensureBookkeepingTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
      version     INTEGER NOT NULL PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );
  `)
}

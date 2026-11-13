import { AppError, ErrorCode } from '@shared/utils/errors'
import type { SqliteDatabase } from './sqlite'

/**
 * Migration declaration and the pure planning logic around it.
 *
 * The plan is computed and validated *before* a single statement runs. The
 * settings database also holds licence activation state and recovery history, so
 * a half-applied or out-of-order migration is a support incident — catching a
 * malformed migration list deterministically at startup is worth the extra
 * indirection.
 */

export interface Migration {
  /** 1-based, contiguous, ascending. */
  readonly version: number
  /** Short slug recorded in `schema_migrations` and in the logs. */
  readonly name: string
  /** Applied inside a transaction by the migrator. */
  readonly up: (db: SqliteDatabase) => void
}

/**
 * Validate the structure of a migration list.
 *
 * Throws on duplicate versions, gaps, non-ascending order, or a version below 1.
 * Every one of those indicates a bad merge, and every one of them is silent
 * schema corruption if allowed through.
 */
export function assertValidMigrationList(migrations: readonly Migration[]): void {
  if (migrations.length === 0) {
    throw new AppError(ErrorCode.Database, 'Migration list is empty')
  }

  const seen = new Set<number>()

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]
    if (migration === undefined) continue

    const expected = index + 1

    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new AppError(
        ErrorCode.Database,
        `Migration "${migration.name}" has an invalid version: ${migration.version}`,
      )
    }

    if (seen.has(migration.version)) {
      throw new AppError(ErrorCode.Database, `Duplicate migration version ${migration.version}`)
    }
    seen.add(migration.version)

    if (migration.version !== expected) {
      throw new AppError(
        ErrorCode.Database,
        `Migrations must be contiguous and ascending: expected version ${expected} at index ${index}, found ${migration.version} ("${migration.name}")`,
      )
    }

    if (migration.name.trim().length === 0) {
      throw new AppError(ErrorCode.Database, `Migration ${migration.version} has an empty name`)
    }
  }
}

/**
 * Select the migrations that still need to run.
 *
 * A `currentVersion` above anything this build ships means the user downgraded
 * the application over a newer database. Proceeding would let old code read a
 * schema it does not understand, so it is refused outright.
 */
export function planMigrations(
  migrations: readonly Migration[],
  currentVersion: number,
): readonly Migration[] {
  assertValidMigrationList(migrations)

  const latest = latestVersion(migrations)

  if (currentVersion > latest) {
    throw new AppError(
      ErrorCode.Database,
      'The settings database was created by a newer version of RecoverX',
      {
        details: `database schema v${currentVersion}, this build supports up to v${latest}`,
        retryable: false,
      },
    )
  }

  return migrations.filter((migration) => migration.version > currentVersion)
}

/** Highest version in a migration list. */
export function latestVersion(migrations: readonly Migration[]): number {
  return migrations[migrations.length - 1]?.version ?? 0
}

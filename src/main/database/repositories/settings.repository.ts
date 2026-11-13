import {
  type SqliteDatabase,
  type SqliteStatement,
  databaseError,
  readText,
  withTransaction,
} from '../sqlite'

/**
 * Persistence for the `app_settings` key/value table.
 *
 * Deliberately thin: it moves rows, nothing more. Validation, defaulting and
 * merging live in `settings-codec.ts`, which is pure and directly testable.
 * Statements are prepared once and reused — settings are read on every window
 * creation and written on every toggle, so re-preparing would be measurable.
 */
export class SettingsRepository {
  private readonly db: SqliteDatabase
  private readonly selectAll: SqliteStatement
  private readonly upsert: SqliteStatement
  private readonly deleteByKey: SqliteStatement
  private readonly deleteAll: SqliteStatement

  constructor(db: SqliteDatabase) {
    this.db = db

    this.selectAll = db.prepare('SELECT key, value FROM app_settings')

    this.upsert = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)

    this.deleteByKey = db.prepare('DELETE FROM app_settings WHERE key = ?')
    this.deleteAll = db.prepare('DELETE FROM app_settings')
  }

  /** Every stored setting, as raw JSON strings keyed by setting name. */
  readAll(): Record<string, string> {
    try {
      const result: Record<string, string> = {}

      for (const row of this.selectAll.all()) {
        result[readText(row, 'key')] = readText(row, 'value')
      }

      return result
    } catch (error) {
      throw databaseError('read settings', error)
    }
  }

  /**
   * Write a batch of rows atomically.
   *
   * The transaction matters beyond durability: the renderer is notified of the
   * new settings immediately after the write, and a partially applied batch
   * would leave the UI and the database permanently disagreeing.
   */
  writeMany(rows: Readonly<Record<string, string>>): void {
    const entries = Object.entries(rows)
    if (entries.length === 0) return

    const now = Date.now()

    try {
      withTransaction(this.db, () => {
        for (const [key, value] of entries) {
          this.upsert.run(key, value, now)
        }
      })
    } catch (error) {
      throw databaseError('persist settings', error)
    }
  }

  /** Remove specific keys — used to prune settings dropped by an upgrade. */
  removeKeys(keys: readonly string[]): void {
    if (keys.length === 0) return

    try {
      withTransaction(this.db, () => {
        for (const key of keys) {
          this.deleteByKey.run(key)
        }
      })
    } catch (error) {
      throw databaseError('remove settings', error)
    }
  }

  /** Clear every stored setting, returning the app to factory defaults. */
  clear(): void {
    try {
      this.deleteAll.run()
    } catch (error) {
      throw databaseError('reset settings', error)
    }
  }
}

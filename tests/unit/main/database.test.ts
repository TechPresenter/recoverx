import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/types/settings'
import { AppError } from '@shared/utils/errors'
import { openDatabase, type DatabaseConnection } from '@main/database/connection'
import { countAppliedMigrations, readCurrentVersion, runMigrations } from '@main/database/migrator'
import { MIGRATIONS } from '@main/database/migrations'
import { SettingsRepository } from '@main/database/repositories/settings.repository'
import { WindowStateRepository } from '@main/database/repositories/window-state.repository'
import { pragmaGet, withTransaction } from '@main/database/sqlite'
import { SettingsService } from '@main/services/settings.service'
import type { Logger } from '@main/logging/logger'

/**
 * Integration coverage for the persistence layer, against a real SQLite file.
 *
 * This is possible because RecoverX uses `node:sqlite` rather than a compiled
 * addon: the same driver Electron runs is available to a plain Node test
 * process, so migrations, pragmas, transactions and corruption recovery are all
 * exercised for real rather than against a mock.
 */

/** Collects records so a test can assert on what was reported. */
function createTestLogger(): Logger & { records: Array<{ level: string; message: string }> } {
  const records: Array<{ level: string; message: string }> = []

  const make = (): Logger => ({
    error: (message) => records.push({ level: 'error', message }),
    warn: (message) => records.push({ level: 'warn', message }),
    info: (message) => records.push({ level: 'info', message }),
    debug: (message) => records.push({ level: 'debug', message }),
    child: () => make(),
  })

  return Object.assign(make(), { records })
}

describe('database persistence', () => {
  let directory: string
  let databasePath: string
  let connection: DatabaseConnection | null
  let logger: ReturnType<typeof createTestLogger>

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-db-'))
    databasePath = join(directory, 'recoverx.db')
    logger = createTestLogger()
    connection = null
  })

  afterEach(() => {
    connection?.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const open = (): DatabaseConnection => {
    connection = openDatabase({ filePath: databasePath, logger })
    return connection
  }

  describe('connection', () => {
    it('creates the database file and its parent directory', () => {
      const nested = join(directory, 'a', 'b', 'recoverx.db')
      const nestedConnection = openDatabase({ filePath: nested, logger })

      expect(nestedConnection.path).toBe(nested)
      expect(nestedConnection.sizeBytes()).toBeGreaterThan(0)

      nestedConnection.close()
    })

    it('enables write-ahead logging', () => {
      const { db } = open()

      expect(pragmaGet(db, 'journal_mode')?.journal_mode).toBe('wal')
    })

    it('enforces foreign keys, which SQLite disables per connection by default', () => {
      const { db } = open()

      expect(pragmaGet(db, 'foreign_keys')?.foreign_keys).toBe(1)
    })

    it('reports a size that includes the WAL side files', () => {
      const { db, sizeBytes } = open()
      runMigrations(db, logger)

      expect(sizeBytes()).toBeGreaterThan(0)
    })

    it('quarantines an unreadable database instead of refusing to start', () => {
      // The user most likely to hold a damaged settings database is the one
      // whose drive just failed — exactly the user who cannot afford a refusal.
      writeFileSync(databasePath, 'this is definitely not a SQLite file')

      const recovered = openDatabase({ filePath: databasePath, logger })
      connection = recovered

      expect(recovered.sizeBytes()).toBeGreaterThan(0)
      expect(readdirSync(directory).some((name) => name.includes('.corrupt-'))).toBe(true)
      expect(logger.records.some((record) => record.level === 'error')).toBe(true)

      // And the fresh database is fully usable.
      expect(() => runMigrations(recovered.db, logger)).not.toThrow()
    })

    it('surfaces a hard error when quarantine is disabled', () => {
      writeFileSync(databasePath, 'not a database')

      expect(() =>
        openDatabase({ filePath: databasePath, logger, quarantineOnCorruption: false }),
      ).toThrow(AppError)
    })
  })

  describe('migrations', () => {
    it('applies every migration to a fresh database', () => {
      const { db } = open()
      const outcome = runMigrations(db, logger)

      expect(outcome.fromVersion).toBe(0)
      expect(outcome.toVersion).toBe(MIGRATIONS.length)
      expect(outcome.applied).toHaveLength(MIGRATIONS.length)
      expect(readCurrentVersion(db)).toBe(MIGRATIONS.length)
      expect(countAppliedMigrations(db)).toBe(MIGRATIONS.length)
    })

    it('is a no-op on a database that is already current', () => {
      const { db } = open()
      runMigrations(db, logger)

      const second = runMigrations(db, logger)

      expect(second.applied).toEqual([])
      expect(second.fromVersion).toBe(second.toVersion)
    })

    it('creates the tables the application expects', () => {
      const { db } = open()
      runMigrations(db, logger)

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name)

      expect(tables).toContain('app_settings')
      expect(tables).toContain('window_state')
      expect(tables).toContain('schema_migrations')
    })

    it('leaves the schema at its previous version when a migration throws', () => {
      const { db } = open()
      runMigrations(db, logger)
      const before = readCurrentVersion(db)

      const failing = [
        ...MIGRATIONS,
        {
          version: MIGRATIONS.length + 1,
          name: 'explodes',
          up: () => {
            throw new Error('migration failure')
          },
        },
      ]

      expect(() => runMigrations(db, logger, failing)).toThrow(AppError)
      // The bookkeeping row and the schema change share one transaction, so a
      // failure can never record a version whose change did not apply.
      expect(readCurrentVersion(db)).toBe(before)
    })

    it('refuses to open a database written by a newer build', () => {
      const { db } = open()
      runMigrations(db, logger)

      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at, duration_ms) VALUES (?, ?, ?, ?)',
      ).run(99, 'from-the-future', Date.now(), 0)

      expect(() => runMigrations(db, logger)).toThrow(/newer version/)
    })
  })

  describe('transactions', () => {
    it('commits on success', () => {
      const { db } = open()
      runMigrations(db, logger)

      withTransaction(db, () => {
        db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
          'theme',
          '"dark"',
          Date.now(),
        )
      })

      expect(db.prepare('SELECT COUNT(*) AS n FROM app_settings').get()?.n).toBe(1)
    })

    it('rolls back every write when the body throws', () => {
      const { db } = open()
      runMigrations(db, logger)

      expect(() =>
        withTransaction(db, () => {
          db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
            'theme',
            '"dark"',
            Date.now(),
          )
          throw new Error('failed halfway')
        }),
      ).toThrow('failed halfway')

      expect(db.prepare('SELECT COUNT(*) AS n FROM app_settings').get()?.n).toBe(0)
    })

    it('nests via savepoints rather than a second BEGIN', () => {
      const { db } = open()
      runMigrations(db, logger)

      const insert = db.prepare(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
      )

      withTransaction(db, () => {
        insert.run('outer', '"1"', Date.now())

        // An inner failure unwinds only to its savepoint.
        expect(() =>
          withTransaction(db, () => {
            insert.run('inner', '"2"', Date.now())
            throw new Error('inner failed')
          }),
        ).toThrow('inner failed')
      })

      const keys = db
        .prepare('SELECT key FROM app_settings ORDER BY key')
        .all()
        .map((row) => row.key)

      expect(keys).toEqual(['outer'])
    })
  })

  describe('SettingsRepository', () => {
    it('round-trips rows', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new SettingsRepository(db)
      repository.writeMany({ theme: '"dark"', accent: '"rose"' })

      expect(repository.readAll()).toEqual({ theme: '"dark"', accent: '"rose"' })
    })

    it('overwrites an existing key rather than inserting a duplicate', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new SettingsRepository(db)
      repository.writeMany({ theme: '"dark"' })
      repository.writeMany({ theme: '"light"' })

      expect(repository.readAll()).toEqual({ theme: '"light"' })
    })

    it('removes specified keys and clears everything on reset', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new SettingsRepository(db)
      repository.writeMany({ theme: '"dark"', legacy: '"x"' })
      repository.removeKeys(['legacy'])

      expect(Object.keys(repository.readAll())).toEqual(['theme'])

      repository.clear()
      expect(repository.readAll()).toEqual({})
    })

    it('tolerates an empty batch', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new SettingsRepository(db)

      expect(() => {
        repository.writeMany({})
        repository.removeKeys([])
      }).not.toThrow()
    })
  })

  describe('WindowStateRepository', () => {
    it('returns null before anything is stored', () => {
      const { db } = open()
      runMigrations(db, logger)

      expect(new WindowStateRepository(db, logger).read()).toBeNull()
    })

    it('round-trips geometry, including a null position', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new WindowStateRepository(db, logger)
      repository.write({ x: 100, y: 200, width: 1280, height: 820, isMaximized: true })

      expect(repository.read()).toEqual({
        x: 100,
        y: 200,
        width: 1280,
        height: 820,
        isMaximized: true,
      })

      repository.write({ x: null, y: null, width: 1024, height: 700, isMaximized: false })

      expect(repository.read()).toEqual({
        x: null,
        y: null,
        width: 1024,
        height: 700,
        isMaximized: false,
      })
    })

    it('keeps exactly one row however many times it is written', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new WindowStateRepository(db, logger)
      for (let i = 0; i < 5; i += 1) {
        repository.write({ x: i, y: i, width: 1280, height: 820, isMaximized: false })
      }

      expect(db.prepare('SELECT COUNT(*) AS n FROM window_state').get()?.n).toBe(1)
    })
  })

  describe('SettingsService', () => {
    const createService = (): SettingsService => {
      const { db } = open()
      runMigrations(db, logger)
      return new SettingsService(new SettingsRepository(db), 'D:\\Recovered', logger)
    }

    it('loads defaults on first run', () => {
      const service = createService()

      expect(service.load()).toEqual(createDefaultSettings('D:\\Recovered'))
    })

    it('persists an update and serves it from cache afterwards', () => {
      const service = createService()
      service.load()

      const updated = service.update({ theme: 'dark', accent: 'violet' })

      expect(updated.theme).toBe('dark')
      expect(service.getAll().accent).toBe('violet')
    })

    it('survives a reload with the persisted values intact', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new SettingsRepository(db)
      const first = new SettingsService(repository, 'D:\\Recovered', logger)
      first.load()
      first.update({ theme: 'light', logRetentionDays: 60 })

      const second = new SettingsService(repository, 'D:\\Recovered', logger)
      const reloaded = second.load()

      expect(reloaded.theme).toBe('light')
      expect(reloaded.logRetentionDays).toBe(60)
    })

    it('repairs an invalid stored value and rewrites the default', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new SettingsRepository(db)
      repository.writeMany({ theme: '"neon"' })

      const service = new SettingsService(repository, 'D:\\Recovered', logger)
      const loaded = service.load()

      expect(loaded.theme).toBe('system')
      // Repaired in place, so the next start is clean rather than repeating the
      // same warning forever.
      expect(repository.readAll().theme).toBe('"system"')
    })

    it('prunes settings that are no longer part of the schema', () => {
      const { db } = open()
      runMigrations(db, logger)

      const repository = new SettingsRepository(db)
      repository.writeMany({ theme: '"dark"', removedInV2: '"x"' })

      new SettingsService(repository, 'D:\\Recovered', logger).load()

      expect(Object.keys(repository.readAll())).not.toContain('removedInV2')
    })

    it('rejects an invalid update and leaves the stored value untouched', () => {
      const service = createService()
      service.load()

      expect(() => service.update({ logRetentionDays: 9999 })).toThrow(AppError)
      expect(service.getAll().logRetentionDays).toBe(14)
    })

    it('notifies subscribers only about keys that actually changed', () => {
      const service = createService()
      service.load()

      const changes: string[][] = []
      service.onChange((_settings, changed) => changes.push(changed.map(String)))

      service.update({ theme: 'dark' })
      service.update({ theme: 'dark' })

      expect(changes).toEqual([['theme']])
    })

    it('keeps notifying after a subscriber throws', () => {
      const service = createService()
      service.load()

      let secondCalled = false
      service.onChange(() => {
        throw new Error('subscriber exploded')
      })
      service.onChange(() => {
        secondCalled = true
      })

      expect(() => service.update({ theme: 'dark' })).not.toThrow()
      expect(secondCalled).toBe(true)
    })

    it('restores factory defaults on reset', () => {
      const service = createService()
      service.load()
      service.update({ theme: 'dark', compactDensity: true })

      expect(service.reset()).toEqual(createDefaultSettings('D:\\Recovered'))
    })

    it('stops notifying after unsubscribe', () => {
      const service = createService()
      service.load()

      let calls = 0
      const unsubscribe = service.onChange(() => {
        calls += 1
      })

      service.update({ theme: 'dark' })
      unsubscribe()
      service.update({ theme: 'light' })

      expect(calls).toBe(1)
    })
  })
})

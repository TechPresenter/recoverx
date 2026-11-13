import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '@shared/utils/errors'
import {
  type SqliteDatabase,
  checkpoint,
  databaseError,
  openSqlite,
  pragmaGet,
  readBoolean,
  readInteger,
  readOptionalInteger,
  readOptionalText,
  readText,
  toChangeCount,
  withTransaction,
} from '@main/database/sqlite'

/**
 * Driver-level behaviour of the `node:sqlite` wrapper.
 *
 * The typed column readers exist because the driver returns
 * `Record<string, primitive>`: without them a schema mismatch propagates an
 * `undefined` into application state instead of failing where it happened.
 */
describe('sqlite wrapper', () => {
  let directory: string
  let db: SqliteDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-sqlite-'))
    db = openSqlite(join(directory, 'test.db'))
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT, flag INTEGER)')
    db.prepare('INSERT INTO t (id, name, note, flag) VALUES (?, ?, ?, ?)').run(1, 'alpha', null, 1)
  })

  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const row = () => db.prepare('SELECT * FROM t WHERE id = 1').get()!

  describe('column readers', () => {
    it('reads text, integers and booleans', () => {
      expect(readText(row(), 'name')).toBe('alpha')
      expect(readInteger(row(), 'id')).toBe(1)
      expect(readBoolean(row(), 'flag')).toBe(true)
    })

    it('distinguishes null from missing for optional columns', () => {
      expect(readOptionalText(row(), 'note')).toBeNull()
      expect(readOptionalText(row(), 'name')).toBe('alpha')
      expect(readOptionalInteger(row(), 'note')).toBeNull()
      expect(readOptionalInteger(row(), 'id')).toBe(1)
    })

    it('throws a precise error when a column holds the wrong type', () => {
      expect(() => readText(row(), 'id')).toThrow(AppError)
      expect(() => readText(row(), 'id')).toThrow(/did not hold text/)
      expect(() => readInteger(row(), 'name')).toThrow(/did not hold integer/)
      expect(() => readText(row(), 'note')).toThrow(/did not hold text/)
    })

    it('names the offending column, so a failure is traceable', () => {
      expect(() => readInteger(row(), 'name')).toThrow(/"name"/)
    })

    it('widens bigint counters returned for large values', () => {
      expect(toChangeCount(5)).toBe(5)
      expect(toChangeCount(9_007_199_254_740_993n)).toBeTypeOf('number')
    })
  })

  describe('pragmas', () => {
    it('applies the connection pragmas on open', () => {
      expect(pragmaGet(db, 'journal_mode')?.journal_mode).toBe('wal')
      expect(pragmaGet(db, 'foreign_keys')?.foreign_keys).toBe(1)
      expect(pragmaGet(db, 'synchronous')?.synchronous).toBe(1)
    })

    it('checkpoints without throwing', () => {
      expect(() => {
        checkpoint(db)
      }).not.toThrow()
    })
  })

  describe('withTransaction', () => {
    it('returns the callback result on commit', () => {
      expect(withTransaction(db, () => 'done')).toBe('done')
    })

    it('re-throws the original error after rolling back', () => {
      const boom = new Error('boom')

      expect(() =>
        withTransaction(db, () => {
          throw boom
        }),
      ).toThrow(boom)
    })

    it('leaves the connection usable after a rollback', () => {
      expect(() =>
        withTransaction(db, () => {
          throw new Error('first')
        }),
      ).toThrow()

      // A leaked transaction would make this fail with "cannot start a
      // transaction within a transaction".
      expect(() => withTransaction(db, () => undefined)).not.toThrow()
    })

    it('supports nesting to more than one level', () => {
      const insert = db.prepare('INSERT INTO t (id, name, note, flag) VALUES (?, ?, ?, ?)')

      withTransaction(db, () => {
        insert.run(2, 'b', null, 0)
        withTransaction(db, () => {
          insert.run(3, 'c', null, 0)
          withTransaction(db, () => {
            insert.run(4, 'd', null, 0)
          })
        })
      })

      expect(readInteger(db.prepare('SELECT COUNT(*) AS n FROM t').get()!, 'n')).toBe(4)
    })

    it('rolls the outer transaction back when an inner failure escapes', () => {
      const insert = db.prepare('INSERT INTO t (id, name, note, flag) VALUES (?, ?, ?, ?)')

      expect(() =>
        withTransaction(db, () => {
          insert.run(2, 'b', null, 0)
          withTransaction(db, () => {
            insert.run(3, 'c', null, 0)
            throw new Error('inner')
          })
        }),
      ).toThrow('inner')

      expect(readInteger(db.prepare('SELECT COUNT(*) AS n FROM t').get()!, 'n')).toBe(1)
    })
  })

  describe('databaseError', () => {
    it('wraps a driver failure with the operation that failed', () => {
      const wrapped = databaseError('read settings', new Error('SQLITE_BUSY'))

      expect(wrapped).toBeInstanceOf(AppError)
      expect(wrapped.message).toContain('read settings')
      expect(wrapped.details).toContain('SQLITE_BUSY')
      expect(wrapped.retryable).toBe(true)
    })
  })

  describe('read-only mode', () => {
    it('refuses writes', () => {
      const path = join(directory, 'test.db')
      checkpoint(db)

      const readOnly = openSqlite(path, { readOnly: true })
      try {
        expect(() => {
          readOnly.exec('INSERT INTO t (id, name) VALUES (99, ?)')
        }).toThrow()
      } finally {
        readOnly.close()
      }
    })
  })
})

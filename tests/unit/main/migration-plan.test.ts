import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/utils/errors'
import {
  assertValidMigrationList,
  latestVersion,
  planMigrations,
  type Migration,
} from '@main/database/migration-plan'

const migration = (version: number, name = `m${version}`): Migration => ({
  version,
  name,
  up: () => undefined,
})

describe('assertValidMigrationList', () => {
  it('accepts a contiguous ascending list', () => {
    expect(() => {
      assertValidMigrationList([migration(1), migration(2), migration(3)])
    }).not.toThrow()
  })

  it('rejects an empty list', () => {
    expect(() => {
      assertValidMigrationList([])
    }).toThrow(AppError)
  })

  it('rejects a gap, which indicates a bad merge', () => {
    expect(() => {
      assertValidMigrationList([migration(1), migration(3)])
    }).toThrow(/contiguous/)
  })

  it('rejects duplicate versions', () => {
    expect(() => {
      assertValidMigrationList([migration(1), migration(1)])
    }).toThrow(/Duplicate/)
  })

  it('rejects a list that does not start at 1', () => {
    expect(() => {
      assertValidMigrationList([migration(2), migration(3)])
    }).toThrow(/expected version 1/)
  })

  it('rejects out-of-order versions', () => {
    expect(() => {
      assertValidMigrationList([migration(2), migration(1)])
    }).toThrow()
  })

  it('rejects a non-integer or non-positive version', () => {
    expect(() => {
      assertValidMigrationList([migration(0)])
    }).toThrow()
    expect(() => {
      assertValidMigrationList([migration(1.5)])
    }).toThrow()
  })

  it('rejects an empty migration name, which would make logs unreadable', () => {
    expect(() => {
      assertValidMigrationList([migration(1, '   ')])
    }).toThrow(/empty name/)
  })
})

describe('planMigrations', () => {
  const migrations = [migration(1), migration(2), migration(3)]

  it('returns every migration for a fresh database', () => {
    expect(planMigrations(migrations, 0)).toHaveLength(3)
  })

  it('returns only migrations above the current version', () => {
    expect(planMigrations(migrations, 2).map((m) => m.version)).toEqual([3])
  })

  it('returns nothing when the schema is current', () => {
    expect(planMigrations(migrations, 3)).toEqual([])
  })

  it('refuses to run against a database from a newer build', () => {
    // The user downgraded the application. Proceeding would let old code read a
    // schema it does not understand.
    expect(() => planMigrations(migrations, 7)).toThrow(/newer version/)
  })

  it('validates the list before planning', () => {
    expect(() => planMigrations([migration(1), migration(5)], 0)).toThrow(/contiguous/)
  })
})

describe('latestVersion', () => {
  it('returns the highest version', () => {
    expect(latestVersion([migration(1), migration(2)])).toBe(2)
  })

  it('returns 0 for an empty list', () => {
    expect(latestVersion([])).toBe(0)
  })
})

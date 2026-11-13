import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Sqlite from '@main/database/sqlite'
import { openSqlite, pragmaGet } from '@main/database/sqlite'
import { DEFAULT_BUSY_TIMEOUT_MS, LicenseStore } from '@server/store'
import { tempDir, type TempDir } from './fixtures'

/**
 * The store's lock wait, on a Node release that ignores DatabaseSync's
 * `timeout` option.
 *
 * `openSqlite` passes the busy timeout as that constructor option, which only
 * newer Node releases honour; older ones that still have node:sqlite leave it
 * at 0. The driver here is replaced by one that behaves like those releases, so
 * the test fails if the store ever relies on the option alone again — on such a
 * release the server and the admin CLI would fail each other's writes with
 * SQLITE_BUSY at once instead of waiting.
 */
vi.mock('@main/database/sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof Sqlite>()
  return {
    ...actual,
    openSqlite: (filePath: string, options: Sqlite.OpenSqliteOptions = {}) =>
      actual.openSqlite(filePath, { ...options, busyTimeoutMs: 0 }),
  }
})

describe('busy timeout', () => {
  let dir: TempDir

  beforeEach(() => {
    dir = tempDir('recoverx-licence-store-')
  })

  afterEach(() => {
    dir.cleanup()
  })

  it('is what the simulated old driver leaves unset', () => {
    const db = openSqlite(join(dir.path, 'plain.db'), { busyTimeoutMs: 5000 })
    try {
      expect(pragmaGet(db, 'busy_timeout')).toEqual({ timeout: 0 })
    } finally {
      db.close()
    }
  })

  it('is set on the connection by the store itself', () => {
    const store = LicenseStore.open(join(dir.path, 'licences.db'))
    try {
      expect(pragmaGet(store.db, 'busy_timeout')).toEqual({ timeout: DEFAULT_BUSY_TIMEOUT_MS })
    } finally {
      store.close()
    }
  })

  it('honours a caller-chosen timeout', () => {
    const store = LicenseStore.open(join(dir.path, 'licences.db'), { busyTimeoutMs: 250 })
    try {
      expect(pragmaGet(store.db, 'busy_timeout')).toEqual({ timeout: 250 })
    } finally {
      store.close()
    }
  })
})

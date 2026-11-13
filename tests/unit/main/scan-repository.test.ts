import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseConnection } from '@main/database/connection'
import { runMigrations } from '@main/database/migrator'
import { ScanRepository, buildWhereClause } from '@main/database/repositories/scan.repository'
import type { Logger } from '@main/logging/logger'
import {
  emptySelection,
  isSelected,
  isSelectionEmpty,
  toggleSelection,
  type FileFilter,
  type RecoveredFile,
  type Selection,
} from '@shared/types/scan'

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
}

const SESSION = 'session-1'

function file(overrides: Partial<RecoveredFile> & { id: string; name: string }): RecoveredFile {
  return {
    sessionId: SESSION,
    path: '',
    extension: overrides.name.includes('.')
      ? (overrides.name.split('.').pop() ?? '').toLowerCase()
      : '',
    category: 'other',
    sizeBytes: 1000,
    isDeleted: false,
    isDirectory: false,
    createdAt: null,
    modifiedAt: null,
    accessedAt: null,
    quality: 'good',
    source: 'ntfs-mft',
    extents: [{ offsetBytes: 4096, lengthBytes: 1000 }],
    hasResidentData: false,
    isFragmented: false,
    isCompressed: false,
    isEncrypted: false,
    ...overrides,
  }
}

const baseFilter: FileFilter = {
  sessionId: SESSION,
  sortBy: 'name',
  sortDirection: 'asc',
  limit: 100,
  offset: 0,
}

describe('ScanRepository', () => {
  let directory: string
  let connection: DatabaseConnection
  let repository: ScanRepository

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-scan-'))
    connection = openDatabase({ filePath: join(directory, 'test.db'), logger: silentLogger })
    runMigrations(connection.db, silentLogger)
    repository = new ScanRepository(connection.db)

    repository.createSession({
      id: SESSION,
      deviceId: 'disk0',
      partitionId: 'disk0:p1',
      deviceModel: 'Test Drive',
      volumeLabel: 'DATA',
      fileSystem: 'ntfs',
      scanType: 'quick',
      status: 'running',
      startedAt: Date.now(),
    })
  })

  afterEach(() => {
    connection.close()
    rmSync(directory, { recursive: true, force: true })
  })

  describe('migration 002', () => {
    it('creates the scan tables and their indexes', () => {
      const names = connection.db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
        .all()
        .map((row) => row.name)

      expect(names).toContain('scan_session')
      expect(names).toContain('recovered_file')
      expect(names).toContain('idx_recovered_name')
      expect(names).toContain('idx_recovered_quality')
    })
  })

  describe('sessions', () => {
    it('round-trips a session', () => {
      const session = repository.getSession(SESSION)

      expect(session?.deviceModel).toBe('Test Drive')
      expect(session?.volumeLabel).toBe('DATA')
      expect(session?.status).toBe('running')
      expect(session?.finishedAt).toBeNull()
    })

    it('records progress and completion', () => {
      repository.saveProgress(SESSION, 'running', 500, 1000, 42, 99_000)
      expect(repository.getSession(SESSION)?.processed).toBe(500)
      expect(repository.getSession(SESSION)?.filesFound).toBe(42)

      repository.completeSession(SESSION, 'completed', null)
      const done = repository.getSession(SESSION)

      expect(done?.status).toBe('completed')
      expect(done?.finishedAt).not.toBeNull()
    })

    it('records a failure reason', () => {
      repository.completeSession(SESSION, 'failed', 'The device was removed')

      expect(repository.getSession(SESSION)?.errorMessage).toBe('The device was removed')
    })

    it('lists sessions newest first', () => {
      repository.createSession({
        id: 'session-2',
        deviceId: 'disk1',
        partitionId: null,
        deviceModel: 'Second',
        volumeLabel: null,
        fileSystem: 'exfat',
        scanType: 'deep',
        status: 'running',
        startedAt: Date.now() + 1000,
      })

      expect(repository.listSessions().map((session) => session.id)).toEqual(['session-2', SESSION])
    })

    it('returns null for an unknown session', () => {
      expect(repository.getSession('nope')).toBeNull()
    })
  })

  describe('results', () => {
    beforeEach(() => {
      repository.addFiles([
        file({
          id: 'f1',
          name: 'holiday.jpg',
          category: 'image',
          sizeBytes: 5_000_000,
          quality: 'excellent',
          isDeleted: true,
          modifiedAt: Date.UTC(2025, 0, 1),
          path: 'Pictures',
        }),
        file({
          id: 'f2',
          name: 'budget.xlsx',
          category: 'spreadsheet',
          sizeBytes: 20_000,
          quality: 'fair',
          modifiedAt: Date.UTC(2024, 5, 1),
        }),
        file({
          id: 'f3',
          name: 'archive.zip',
          category: 'archive',
          sizeBytes: 900_000_000,
          quality: 'poor',
          isDeleted: true,
        }),
        file({
          id: 'f4',
          name: 'notes.txt',
          category: 'document',
          sizeBytes: 400,
          quality: 'good',
        }),
        file({ id: 'f5', name: 'Pictures', category: 'other', isDirectory: true, sizeBytes: 0 }),
      ])
    })

    it('stores and returns files, excluding directories by default', () => {
      const result = repository.queryFiles(baseFilter)

      expect(result.total).toBe(4)
      expect(result.files.map((entry) => entry.name)).not.toContain('Pictures')
    })

    it('includes directories when asked', () => {
      const result = repository.queryFiles({ ...baseFilter, includeDirectories: true })

      expect(result.total).toBe(5)
    })

    it('round-trips every field, including extents', () => {
      const [found] = repository.getFilesByIds(['f1'])

      expect(found?.name).toBe('holiday.jpg')
      expect(found?.path).toBe('Pictures')
      expect(found?.category).toBe('image')
      expect(found?.quality).toBe('excellent')
      expect(found?.isDeleted).toBe(true)
      expect(found?.extents).toEqual([{ offsetBytes: 4096, lengthBytes: 1000 }])
    })

    it('searches by name, case-insensitively', () => {
      expect(repository.queryFiles({ ...baseFilter, search: 'HOLIDAY' }).total).toBe(1)
      expect(repository.queryFiles({ ...baseFilter, search: 'o' }).total).toBeGreaterThan(1)
      expect(repository.queryFiles({ ...baseFilter, search: 'nothing' }).total).toBe(0)
    })

    it('treats LIKE wildcards in a search term literally', () => {
      // Without an ESCAPE clause on the statement these would match every row.
      expect(repository.queryFiles({ ...baseFilter, search: '%' }).total).toBe(0)
      expect(repository.queryFiles({ ...baseFilter, search: '_' }).total).toBe(0)
    })

    it('finds a file whose name genuinely contains a wildcard character', () => {
      // The real test of escaping. Escaping without an ESCAPE clause makes this
      // unfindable; no escaping at all makes a '%' search match everything.
      repository.addFiles([
        file({ id: 'w1', name: '100% final.docx', category: 'document' }),
        file({ id: 'w2', name: 'draft_v2.docx', category: 'document' }),
      ])

      const percent = repository.queryFiles({ ...baseFilter, search: '100%' })
      expect(percent.total).toBe(1)
      expect(percent.files[0]?.name).toBe('100% final.docx')

      expect(repository.queryFiles({ ...baseFilter, search: 'draft_v2' }).total).toBe(1)
    })

    it('is not injectable through the search box', () => {
      // File names come off a hostile disk image, so this reaches SQL from
      // untrusted input.
      const attack = "'; DROP TABLE recovered_file; --"

      expect(() => repository.queryFiles({ ...baseFilter, search: attack })).not.toThrow()
      expect(repository.countFiles(SESSION)).toBe(5)
    })

    it('filters by category, quality and extension', () => {
      expect(repository.queryFiles({ ...baseFilter, categories: ['image'] }).total).toBe(1)
      expect(repository.queryFiles({ ...baseFilter, qualities: ['poor', 'fair'] }).total).toBe(2)
      expect(repository.queryFiles({ ...baseFilter, extensions: ['ZIP'] }).total).toBe(1)
    })

    it('filters to deleted files only', () => {
      const result = repository.queryFiles({ ...baseFilter, deletedOnly: true })

      expect(result.total).toBe(2)
      expect(result.files.every((entry) => entry.isDeleted)).toBe(true)
    })

    it('filters by size and date range', () => {
      expect(repository.queryFiles({ ...baseFilter, minSizeBytes: 1_000_000 }).total).toBe(2)
      expect(repository.queryFiles({ ...baseFilter, maxSizeBytes: 1000 }).total).toBe(1)
      expect(
        repository.queryFiles({ ...baseFilter, modifiedAfter: Date.UTC(2024, 11, 1) }).total,
      ).toBe(1)
    })

    it('combines filters conjunctively', () => {
      const result = repository.queryFiles({
        ...baseFilter,
        deletedOnly: true,
        categories: ['image'],
      })

      expect(result.total).toBe(1)
      expect(result.files[0]?.name).toBe('holiday.jpg')
    })

    it('sorts by quality with excellent first, not alphabetically', () => {
      // Sorting the enum as text would put "excellent" after "fair".
      const result = repository.queryFiles({ ...baseFilter, sortBy: 'quality' })

      expect(result.files.map((entry) => entry.quality)).toEqual([
        'excellent',
        'good',
        'fair',
        'poor',
      ])
    })

    it('sorts by size and name in both directions', () => {
      expect(
        repository.queryFiles({ ...baseFilter, sortBy: 'size', sortDirection: 'desc' }).files[0]
          ?.name,
      ).toBe('archive.zip')

      expect(
        repository.queryFiles({ ...baseFilter, sortBy: 'name', sortDirection: 'asc' }).files[0]
          ?.name,
      ).toBe('archive.zip')
    })

    it('pages without losing or repeating rows', () => {
      const first = repository.queryFiles({ ...baseFilter, limit: 2, offset: 0 })
      const second = repository.queryFiles({ ...baseFilter, limit: 2, offset: 2 })

      expect(first.files).toHaveLength(2)
      expect(second.files).toHaveLength(2)
      expect(first.total).toBe(4)

      const ids = [...first.files, ...second.files].map((entry) => entry.id)
      expect(new Set(ids).size).toBe(4)
    })

    it('returns category counts and total size for the filtered set', () => {
      const result = repository.queryFiles(baseFilter)

      expect(result.categoryCounts.image).toBe(1)
      expect(result.categoryCounts.archive).toBe(1)
      expect(result.totalSizeBytes).toBe(5_000_000 + 20_000 + 900_000_000 + 400)
    })

    it('scopes counts to the active filter', () => {
      const result = repository.queryFiles({ ...baseFilter, deletedOnly: true })

      expect(result.categoryCounts.spreadsheet).toBeUndefined()
      expect(result.categoryCounts.image).toBe(1)
    })

    it('replaces a row rather than failing on a repeated id', () => {
      // A rescan of the same volume produces the same deterministic ids.
      repository.addFiles([file({ id: 'f1', name: 'renamed.jpg', category: 'image' })])

      expect(repository.countFiles(SESSION)).toBe(5)
      expect(repository.getFilesByIds(['f1'])[0]?.name).toBe('renamed.jpg')
    })

    it('tolerates an empty batch and an empty id list', () => {
      expect(() => {
        repository.addFiles([])
      }).not.toThrow()
      expect(repository.getFilesByIds([])).toEqual([])
    })

    it('deletes a session and its results by cascade', () => {
      repository.deleteSession(SESSION)

      expect(repository.getSession(SESSION)).toBeNull()
      expect(repository.countFiles(SESSION)).toBe(0)
    })
  })
})

describe('folders and selection', () => {
  let directory: string
  let connection: DatabaseConnection
  let repository: ScanRepository

  const SEP = '\\'

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-sel-'))
    connection = openDatabase({ filePath: join(directory, 'test.db'), logger: silentLogger })
    runMigrations(connection.db, silentLogger)
    repository = new ScanRepository(connection.db)

    repository.createSession({
      id: SESSION,
      deviceId: 'disk0',
      partitionId: null,
      deviceModel: 'Test',
      volumeLabel: null,
      fileSystem: 'ntfs',
      scanType: 'quick',
      status: 'completed',
      startedAt: Date.now(),
    })

    repository.addFiles([
      file({ id: 'a', name: 'root.txt', path: '', sizeBytes: 100 }),
      file({ id: 'b', name: 'one.jpg', path: 'Pictures', sizeBytes: 200, category: 'image' }),
      file({
        id: 'c',
        name: 'two.jpg',
        path: `Pictures${SEP}2025`,
        sizeBytes: 300,
        category: 'image',
      }),
      file({ id: 'd', name: 'doc.pdf', path: 'Documents', sizeBytes: 400, category: 'document' }),
      // A folder sharing a prefix with another, to catch a match that forgets
      // the separator.
      file({ id: 'e', name: 'x.txt', path: 'PicturesOld', sizeBytes: 500 }),
    ])
  })

  afterEach(() => {
    connection.close()
    rmSync(directory, { recursive: true, force: true })
  })

  describe('listFolders', () => {
    it('returns every distinct folder with its totals', () => {
      const folders = repository.listFolders(SESSION)

      // Byte order, not tree order: 'O' (0x4F) sorts before the separator
      // (0x5C), so a sibling folder precedes a child. The tree view rebuilds
      // the hierarchy from the paths, so this order is display-irrelevant.
      expect(folders.map((folder) => folder.path)).toEqual([
        '',
        'Documents',
        'Pictures',
        'PicturesOld',
        `Pictures${SEP}2025`,
      ])
      expect(folders.find((folder) => folder.path === 'Documents')?.fileCount).toBe(1)
      expect(folders.find((folder) => folder.path === 'Documents')?.totalSizeBytes).toBe(400)
    })

    it('uses the final segment as the display name', () => {
      const nested = repository.listFolders(SESSION).find((folder) => folder.path.includes(SEP))

      expect(nested?.name).toBe('2025')
    })
  })

  describe('pathPrefix filter', () => {
    it('includes the folder and its descendants', () => {
      const result = repository.queryFiles({ ...baseFilter, pathPrefix: 'Pictures' })

      expect(result.files.map((entry) => entry.id).sort()).toEqual(['b', 'c'])
    })

    it('does not leak into a folder that merely shares a prefix', () => {
      const result = repository.queryFiles({ ...baseFilter, pathPrefix: 'Pictures' })

      expect(result.files.some((entry) => entry.id === 'e')).toBe(false)
    })

    it('treats an empty prefix as no folder filter', () => {
      expect(repository.queryFiles({ ...baseFilter, pathPrefix: '' }).total).toBe(5)
    })
  })

  describe('selection', () => {
    it('an empty include selection matches nothing', () => {
      // The dangerous failure mode is a missing WHERE that matches the whole
      // volume, so this asserts the opposite of "recover everything".
      expect(repository.summariseSelection(emptySelection(baseFilter)).count).toBe(0)
      expect(repository.resolveSelection(emptySelection(baseFilter), 100, 0)).toEqual([])
    })

    it('include mode returns exactly the listed files', () => {
      const selection: Selection = { mode: 'include', ids: ['b', 'd'], filter: baseFilter }

      expect(repository.summariseSelection(selection)).toEqual({ count: 2, totalSizeBytes: 600 })
      expect(
        repository
          .resolveSelection(selection, 100, 0)
          .map((entry) => entry.id)
          .sort(),
      ).toEqual(['b', 'd'])
    })

    it('include mode ignores the filter, so a ticked file survives a filter change', () => {
      const selection: Selection = {
        mode: 'include',
        ids: ['d'],
        // A filter that would otherwise exclude 'd' entirely.
        filter: { ...baseFilter, categories: ['image'] },
      }

      expect(repository.summariseSelection(selection).count).toBe(1)
    })

    it('exclude mode is everything matching the filter, minus the listed ids', () => {
      const selection: Selection = { mode: 'exclude', ids: ['a'], filter: baseFilter }
      const summary = repository.summariseSelection(selection)

      expect(summary.count).toBe(4)
      expect(summary.totalSizeBytes).toBe(200 + 300 + 400 + 500)
    })

    it('exclude mode honours the filter', () => {
      const selection: Selection = {
        mode: 'exclude',
        ids: [],
        filter: { ...baseFilter, categories: ['image'] },
      }

      expect(repository.summariseSelection(selection).count).toBe(2)
    })

    it('exclude mode with no exclusions is the whole filtered set', () => {
      expect(
        repository.summariseSelection({ mode: 'exclude', ids: [], filter: baseFilter }).count,
      ).toBe(5)
    })

    it('pages a resolved selection without repeating rows', () => {
      const selection: Selection = { mode: 'exclude', ids: [], filter: baseFilter }

      const first = repository.resolveSelection(selection, 2, 0)
      const second = repository.resolveSelection(selection, 2, 2)

      expect(first).toHaveLength(2)
      expect(second).toHaveLength(2)
      expect(new Set([...first, ...second].map((entry) => entry.id)).size).toBe(4)
    })
  })
})

describe('selection helpers', () => {
  it('reports membership by mode', () => {
    expect(isSelected({ mode: 'include', ids: ['a'], filter: baseFilter }, 'a')).toBe(true)
    expect(isSelected({ mode: 'include', ids: ['a'], filter: baseFilter }, 'b')).toBe(false)
    // In exclude mode the listed ids are the ones NOT selected.
    expect(isSelected({ mode: 'exclude', ids: ['a'], filter: baseFilter }, 'a')).toBe(false)
    expect(isSelected({ mode: 'exclude', ids: ['a'], filter: baseFilter }, 'b')).toBe(true)
  })

  it('toggles without changing the mode', () => {
    const selection: Selection = { mode: 'exclude', ids: [], filter: baseFilter }
    const afterUntick = toggleSelection(selection, 'a')

    expect(afterUntick.mode).toBe('exclude')
    expect(afterUntick.ids).toEqual(['a'])
    expect(toggleSelection(afterUntick, 'a').ids).toEqual([])
  })

  it('treats only an empty include selection as empty', () => {
    expect(isSelectionEmpty(emptySelection(baseFilter))).toBe(true)
    expect(isSelectionEmpty({ mode: 'exclude', ids: [], filter: baseFilter })).toBe(false)
  })
})

describe('buildWhereClause', () => {
  it('binds every value as a parameter', () => {
    const { clause, parameters } = buildWhereClause({
      ...baseFilter,
      search: 'photo',
      categories: ['image', 'video'],
      minSizeBytes: 100,
    })

    // Nothing from the caller may appear inline in the SQL text.
    expect(clause).not.toContain('photo')
    expect(clause).not.toContain('image')
    expect(parameters).toContain('%photo%')
    expect(parameters).toContain('image')
    expect(parameters).toContain(100)
  })

  it('always scopes to a session', () => {
    const { clause, parameters } = buildWhereClause(baseFilter)

    expect(clause).toContain('session_id = ?')
    expect(parameters[0]).toBe(SESSION)
  })
})

import {
  type FileFilter,
  type FileQueryResult,
  type FolderNode,
  type Selection,
  type SelectionSummary,
  type RecoveredFile,
  type RecoveryQuality,
  type ScanSession,
  type ScanStatus,
  FileCategorySchema,
  RecoveredFileSchema,
} from '@shared/types/scan'
import { parseJson } from '@shared/utils/json'
import { z } from 'zod'
import {
  type SqliteDatabase,
  type SqliteRow,
  type SqliteStatement,
  databaseError,
  readBoolean,
  readInteger,
  readOptionalInteger,
  readText,
  withTransaction,
} from '../sqlite'

/**
 * Persistence for scan sessions and their results.
 *
 * The results table is the only one in the application that will routinely hold
 * millions of rows, so the query path is built for that: every filter is pushed
 * into SQL, pagination is done by the database, and the aggregate counts the UI
 * needs come back in the same round trip as the page.
 */

/**
 * Ordinal ranks for sorting.
 *
 * Sorting the enum alphabetically would place "excellent" below "fair", which
 * is precisely backwards for the column users sort by most.
 */
const QUALITY_RANK: Readonly<Record<RecoveryQuality, number>> = {
  excellent: 0,
  good: 1,
  fair: 2,
  poor: 3,
  unknown: 4,
}

const ExtentsSchema = z.array(z.object({ offsetBytes: z.number(), lengthBytes: z.number() }))

/** Columns a caller may sort by, mapped to real column names. */
const SORT_COLUMNS: Readonly<Record<FileFilter['sortBy'], string>> = {
  name: 'name_lower',
  path: 'path',
  size: 'size_bytes',
  modified: 'modified_at',
  quality: 'quality_rank',
}

export class ScanRepository {
  private readonly db: SqliteDatabase
  private readonly insertFile: SqliteStatement
  private readonly insertSession: SqliteStatement
  private readonly updateProgress: SqliteStatement
  private readonly finishSession: SqliteStatement

  constructor(db: SqliteDatabase) {
    this.db = db

    this.insertSession = db.prepare(`
      INSERT INTO scan_session (
        id, device_id, partition_id, device_model, volume_label, file_system,
        scan_type, status, started_at, finished_at, files_found, bytes_found,
        processed, total, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0, NULL)
    `)

    this.updateProgress = db.prepare(`
      UPDATE scan_session
      SET status = ?, processed = ?, total = ?, files_found = ?, bytes_found = ?
      WHERE id = ?
    `)

    this.finishSession = db.prepare(`
      UPDATE scan_session
      SET status = ?, finished_at = ?, error_message = ?
      WHERE id = ?
    `)

    this.insertFile = db.prepare(`
      INSERT OR REPLACE INTO recovered_file (
        id, session_id, name, name_lower, path, extension, category, size_bytes,
        is_deleted, is_directory, created_at, modified_at, accessed_at,
        quality, quality_rank, source, extents,
        has_resident, is_fragmented, is_compressed, is_encrypted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  }

  // --- Sessions ------------------------------------------------------------

  createSession(
    session: Omit<
      ScanSession,
      'finishedAt' | 'filesFound' | 'bytesFound' | 'processed' | 'total' | 'errorMessage'
    >,
  ): void {
    try {
      this.insertSession.run(
        session.id,
        session.deviceId,
        session.partitionId,
        session.deviceModel,
        session.volumeLabel,
        session.fileSystem,
        session.scanType,
        session.status,
        session.startedAt,
      )
    } catch (error) {
      throw databaseError('create scan session', error)
    }
  }

  saveProgress(
    sessionId: string,
    status: ScanStatus,
    processed: number,
    total: number,
    filesFound: number,
    bytesFound: number,
  ): void {
    try {
      this.updateProgress.run(status, processed, total, filesFound, bytesFound, sessionId)
    } catch (error) {
      throw databaseError('save scan progress', error)
    }
  }

  completeSession(sessionId: string, status: ScanStatus, errorMessage: string | null): void {
    try {
      this.finishSession.run(status, Date.now(), errorMessage, sessionId)
    } catch (error) {
      throw databaseError('complete scan session', error)
    }
  }

  getSession(sessionId: string): ScanSession | null {
    try {
      const row = this.db.prepare('SELECT * FROM scan_session WHERE id = ?').get(sessionId)
      return row === undefined ? null : toSession(row)
    } catch (error) {
      throw databaseError('read scan session', error)
    }
  }

  /** Sessions, newest first. Drives the scan history screen. */
  listSessions(limit = 50): ScanSession[] {
    try {
      return this.db
        .prepare('SELECT * FROM scan_session ORDER BY started_at DESC LIMIT ?')
        .all(limit)
        .map((row) => toSession(row as SqliteRow))
    } catch (error) {
      throw databaseError('list scan sessions', error)
    }
  }

  /** Remove a session and, by cascade, every result it produced. */
  deleteSession(sessionId: string): void {
    try {
      this.db.prepare('DELETE FROM scan_session WHERE id = ?').run(sessionId)
    } catch (error) {
      throw databaseError('delete scan session', error)
    }
  }

  // --- Results -------------------------------------------------------------

  /**
   * Insert a batch of results.
   *
   * One transaction per batch: a scan producing a million rows would otherwise
   * pay a disk sync per row, which is the difference between a scan that takes
   * minutes and one that takes hours.
   */
  addFiles(files: readonly RecoveredFile[]): void {
    if (files.length === 0) return

    try {
      withTransaction(this.db, () => {
        for (const file of files) {
          this.insertFile.run(
            file.id,
            file.sessionId,
            file.name,
            file.name.toLowerCase(),
            file.path,
            file.extension,
            file.category,
            file.sizeBytes,
            file.isDeleted ? 1 : 0,
            file.isDirectory ? 1 : 0,
            file.createdAt,
            file.modifiedAt,
            file.accessedAt,
            file.quality,
            QUALITY_RANK[file.quality],
            file.source,
            JSON.stringify(file.extents),
            file.hasResidentData ? 1 : 0,
            file.isFragmented ? 1 : 0,
            file.isCompressed ? 1 : 0,
            file.isEncrypted ? 1 : 0,
          )
        }
      })
    } catch (error) {
      throw databaseError('store scan results', error)
    }
  }

  /**
   * Query results.
   *
   * Returns the page, the total match count and per-category counts together.
   * The counts are what the category chips display, and computing them in the
   * same call avoids three round trips per keystroke in the search box.
   */
  queryFiles(filter: FileFilter): FileQueryResult {
    const { clause, parameters } = buildWhereClause(filter)

    try {
      const totals = this.db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM recovered_file ${clause}`,
        )
        .get(...parameters) as SqliteRow | undefined

      const categoryRows = this.db
        .prepare(`SELECT category, COUNT(*) AS n FROM recovered_file ${clause} GROUP BY category`)
        .all(...parameters)

      const sortColumn = SORT_COLUMNS[filter.sortBy]
      const direction = filter.sortDirection === 'desc' ? 'DESC' : 'ASC'

      const rows = this.db
        .prepare(
          `SELECT * FROM recovered_file ${clause}
           ORDER BY ${sortColumn} ${direction}, id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, filter.limit, filter.offset)

      const categoryCounts: Record<string, number> = {}
      for (const row of categoryRows) {
        const parsed = FileCategorySchema.safeParse(readText(row, 'category'))
        if (parsed.success) categoryCounts[parsed.data] = readInteger(row, 'n')
      }

      return {
        files: rows.map((row) => toRecoveredFile(row as SqliteRow)),
        total: totals === undefined ? 0 : readInteger(totals, 'n'),
        categoryCounts,
        totalSizeBytes: totals === undefined ? 0 : readInteger(totals, 'bytes'),
      }
    } catch (error) {
      throw databaseError('query scan results', error)
    }
  }

  /** Fetch specific results by id — used when starting a recovery job. */
  getFilesByIds(ids: readonly string[]): RecoveredFile[] {
    if (ids.length === 0) return []

    try {
      const placeholders = ids.map(() => '?').join(', ')

      return this.db
        .prepare(`SELECT * FROM recovered_file WHERE id IN (${placeholders})`)
        .all(...ids)
        .map((row) => toRecoveredFile(row as SqliteRow))
    } catch (error) {
      throw databaseError('read scan results', error)
    }
  }

  /**
   * Distinct folders holding results, with per-folder totals.
   *
   * Aggregated in SQL rather than by grouping the rows in the renderer: on a
   * volume with a million files the flat folder list is a few thousand rows,
   * and the alternative is transferring all million to count them.
   */
  listFolders(sessionId: string): FolderNode[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT path,
                  COUNT(*)                AS n,
                  SUM(is_deleted)         AS deleted,
                  COALESCE(SUM(size_bytes), 0) AS bytes
             FROM recovered_file
            WHERE session_id = ? AND is_directory = 0
            GROUP BY path
            ORDER BY path ASC`,
        )
        .all(sessionId)

      return rows.map((row) => {
        const path = readText(row, 'path')
        const segments = path.split('\\')

        return {
          path,
          name: segments.at(-1) ?? '',
          fileCount: readInteger(row, 'n'),
          deletedCount: readInteger(row, 'deleted'),
          totalSizeBytes: readInteger(row, 'bytes'),
        }
      })
    } catch (error) {
      throw databaseError('list result folders', error)
    }
  }

  /**
   * Size a selection without materialising it.
   *
   * This is what the "Recover 412 files (2.3 GB)" button reads, and it has to
   * be cheap enough to run on every tick of a checkbox.
   */
  summariseSelection(selection: Selection): SelectionSummary {
    const { clause, parameters } = buildSelectionClause(selection)

    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM recovered_file ${clause}`,
        )
        .get(...parameters) as SqliteRow | undefined

      return {
        count: row === undefined ? 0 : readInteger(row, 'n'),
        totalSizeBytes: row === undefined ? 0 : readInteger(row, 'bytes'),
      }
    } catch (error) {
      throw databaseError('summarise selection', error)
    }
  }

  /**
   * Materialise a selection, in pages.
   *
   * The recovery pipeline pulls this a page at a time rather than all at once,
   * so restoring two million files does not require holding two million rows in
   * memory before the first byte is written.
   */
  resolveSelection(selection: Selection, limit: number, offset: number): RecoveredFile[] {
    const { clause, parameters } = buildSelectionClause(selection)

    try {
      return this.db
        .prepare(
          `SELECT * FROM recovered_file ${clause}
            ORDER BY path ASC, name_lower ASC, id ASC
            LIMIT ? OFFSET ?`,
        )
        .all(...parameters, limit, offset)
        .map((row) => toRecoveredFile(row as SqliteRow))
    } catch (error) {
      throw databaseError('resolve selection', error)
    }
  }

  countFiles(sessionId: string): number {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM recovered_file WHERE session_id = ?')
        .get(sessionId)

      return row === undefined ? 0 : readInteger(row, 'n')
    } catch (error) {
      throw databaseError('count scan results', error)
    }
  }
}

// --- SQL construction ------------------------------------------------------

interface WhereClause {
  readonly clause: string
  readonly parameters: Array<string | number>
}

/**
 * Build the WHERE clause for a filter.
 *
 * Every value is bound as a parameter. Interpolating a user's search term into
 * SQL would be an injection hole reachable from a text box, and the search term
 * on this screen comes from file names read off a hostile disk image.
 */
export function buildWhereClause(filter: FileFilter): WhereClause {
  const conditions: string[] = ['session_id = ?']
  const parameters: Array<string | number> = [filter.sessionId]

  if (filter.search !== undefined && filter.search.trim().length > 0) {
    conditions.push("name_lower LIKE ? ESCAPE '\\'")
    // The term is escaped for LIKE wildcards so a literal '%' searches for '%'.
    parameters.push(`%${escapeLike(filter.search.trim().toLowerCase())}%`)
  }

  if (filter.categories !== undefined && filter.categories.length > 0) {
    conditions.push(`category IN (${filter.categories.map(() => '?').join(', ')})`)
    parameters.push(...filter.categories)
  }

  if (filter.qualities !== undefined && filter.qualities.length > 0) {
    conditions.push(`quality IN (${filter.qualities.map(() => '?').join(', ')})`)
    parameters.push(...filter.qualities)
  }

  if (filter.extensions !== undefined && filter.extensions.length > 0) {
    conditions.push(`extension IN (${filter.extensions.map(() => '?').join(', ')})`)
    parameters.push(...filter.extensions.map((extension) => extension.toLowerCase()))
  }

  // An empty prefix is the volume root, which matches everything: treating it
  // as a literal LIKE would exclude every file whose path is also empty.
  if (filter.pathPrefix !== undefined && filter.pathPrefix.length > 0) {
    conditions.push("(path = ? OR path LIKE ? ESCAPE '\\')")
    // The separator is escaped through the same helper, so the pattern is
    // `Folder<escaped-separator>%` - matching the folder and its descendants.
    parameters.push(filter.pathPrefix, escapeLike(filter.pathPrefix + PATH_SEPARATOR) + '%')
  }

  if (filter.deletedOnly === true) conditions.push('is_deleted = 1')
  if (filter.includeDirectories !== true) conditions.push('is_directory = 0')

  if (filter.minSizeBytes !== undefined) {
    conditions.push('size_bytes >= ?')
    parameters.push(filter.minSizeBytes)
  }

  if (filter.maxSizeBytes !== undefined) {
    conditions.push('size_bytes <= ?')
    parameters.push(filter.maxSizeBytes)
  }

  if (filter.modifiedAfter !== undefined) {
    conditions.push('modified_at >= ?')
    parameters.push(filter.modifiedAfter)
  }

  if (filter.modifiedBefore !== undefined) {
    conditions.push('modified_at <= ?')
    parameters.push(filter.modifiedBefore)
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, parameters }
}

/**
 * WHERE clause for a selection.
 *
 * `include` narrows to the listed ids alone — the active filter is deliberately
 * ignored, so a file stays selected after the user changes the filter that was
 * in force when they ticked it.
 *
 * `exclude` applies the filter and subtracts the listed ids.
 */
export function buildSelectionClause(selection: Selection): WhereClause {
  if (selection.mode === 'include') {
    if (selection.ids.length === 0) {
      // A clause that cannot match, rather than a missing WHERE that would
      // match everything — the difference between recovering nothing and
      // recovering the entire volume.
      return { clause: 'WHERE 1 = 0', parameters: [] }
    }

    const placeholders = selection.ids.map(() => '?').join(', ')
    return {
      clause: `WHERE session_id = ? AND id IN (${placeholders})`,
      parameters: [selection.filter.sessionId, ...selection.ids],
    }
  }

  const base = buildWhereClause(selection.filter)

  if (selection.ids.length === 0) return base

  const placeholders = selection.ids.map(() => '?').join(', ')

  return {
    clause: `${base.clause} AND id NOT IN (${placeholders})`,
    parameters: [...base.parameters, ...selection.ids],
  }
}

/** Path separator used in stored result paths. */
const PATH_SEPARATOR = '\\'

/**
 * Escape the LIKE metacharacters.
 *
 * Only meaningful in combination with an `ESCAPE` clause on the statement:
 * SQLite has no default escape character, so without one these backslashes
 * would be matched literally instead of escaping anything.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&')
}

// --- Row mapping -----------------------------------------------------------

function toSession(row: SqliteRow): ScanSession {
  return {
    id: readText(row, 'id'),
    deviceId: readText(row, 'device_id'),
    partitionId: row.partition_id === null ? null : readText(row, 'partition_id'),
    deviceModel: readText(row, 'device_model'),
    volumeLabel: row.volume_label === null ? null : readText(row, 'volume_label'),
    fileSystem: readText(row, 'file_system'),
    scanType: readText(row, 'scan_type') as ScanSession['scanType'],
    status: readText(row, 'status') as ScanStatus,
    startedAt: readInteger(row, 'started_at'),
    finishedAt: readOptionalInteger(row, 'finished_at'),
    filesFound: readInteger(row, 'files_found'),
    bytesFound: readInteger(row, 'bytes_found'),
    processed: readInteger(row, 'processed'),
    total: readInteger(row, 'total'),
    errorMessage: row.error_message === null ? null : readText(row, 'error_message'),
  }
}

function toRecoveredFile(row: SqliteRow): RecoveredFile {
  const extents = parseJson(readText(row, 'extents'), ExtentsSchema)

  return {
    id: readText(row, 'id'),
    sessionId: readText(row, 'session_id'),
    name: readText(row, 'name'),
    path: readText(row, 'path'),
    extension: readText(row, 'extension'),
    category: readText(row, 'category') as RecoveredFile['category'],
    sizeBytes: readInteger(row, 'size_bytes'),
    isDeleted: readBoolean(row, 'is_deleted'),
    isDirectory: readBoolean(row, 'is_directory'),
    createdAt: readOptionalInteger(row, 'created_at'),
    modifiedAt: readOptionalInteger(row, 'modified_at'),
    accessedAt: readOptionalInteger(row, 'accessed_at'),
    quality: readText(row, 'quality') as RecoveryQuality,
    source: readText(row, 'source') as RecoveredFile['source'],
    // A row whose extents will not parse is still worth returning: the name and
    // size tell the user what was lost even when the data cannot be read.
    extents: extents.ok ? extents.data : [],
    hasResidentData: readBoolean(row, 'has_resident'),
    isFragmented: readBoolean(row, 'is_fragmented'),
    isCompressed: readBoolean(row, 'is_compressed'),
    isEncrypted: readBoolean(row, 'is_encrypted'),
  }
}

/** Validate a row against the shared schema. Used by tests and diagnostics. */
export function validateRecoveredFile(value: unknown): boolean {
  return RecoveredFileSchema.safeParse(value).success
}

import type {
  RecoveryItem,
  RecoveryItemFilter,
  RecoveryItemStatus,
  RecoveryJob,
  RecoveryStatus,
} from '@shared/types/recovery'
import {
  type SqliteDatabase,
  type SqliteRow,
  type SqliteStatement,
  databaseError,
  readBoolean,
  readInteger,
  readText,
  readOptionalInteger,
  withTransaction,
} from '../sqlite'

/**
 * Persistence for recovery jobs and their per-file outcomes.
 *
 * Outcomes are appended in batches as the run proceeds rather than at the end,
 * so a job that is cancelled — or that dies with the application — still leaves
 * an accurate record of what reached disk.
 */
export class RecoveryRepository {
  private readonly db: SqliteDatabase
  private readonly insertJob: SqliteStatement
  private readonly updateCounters: SqliteStatement
  private readonly finishJob: SqliteStatement
  private readonly insertItem: SqliteStatement
  private readonly chargeAllowance: SqliteStatement

  constructor(db: SqliteDatabase) {
    this.db = db

    this.insertJob = db.prepare(`
      INSERT INTO recovery_job (
        id, session_id, destination, status, restore_structure,
        started_at, total_files, total_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.updateCounters = db.prepare(`
      UPDATE recovery_job
         SET status = ?, recovered_files = ?, recovered_bytes = ?,
             partial_files = ?, skipped_files = ?, failed_files = ?, mismatched_files = ?
       WHERE id = ?
    `)

    this.finishJob = db.prepare(`
      UPDATE recovery_job SET status = ?, finished_at = ?, error_message = ? WHERE id = ?
    `)

    this.insertItem = db.prepare(`
      INSERT INTO recovery_item (
        job_id, file_id, name, target_path, status, verification,
        bytes_written, expected_bytes, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    // An upsert rather than a plain UPDATE, so a ledger row that has somehow
    // gone missing is recreated by the next charge instead of every charge
    // silently updating nothing.
    this.chargeAllowance = db.prepare(`
      INSERT INTO recovery_allowance (id, recovered_bytes) VALUES (1, ?)
        ON CONFLICT (id) DO UPDATE SET recovered_bytes = recovered_bytes + excluded.recovered_bytes
    `)
  }

  createJob(job: {
    id: string
    sessionId: string
    destination: string
    restoreFolderStructure: boolean
    startedAt: number
    totalFiles: number
    totalBytes: number
  }): void {
    try {
      this.insertJob.run(
        job.id,
        job.sessionId,
        job.destination,
        'running',
        job.restoreFolderStructure ? 1 : 0,
        job.startedAt,
        job.totalFiles,
        job.totalBytes,
      )
    } catch (error) {
      throw databaseError('create recovery job', error)
    }
  }

  /**
   * Save a job's counters, and charge the bytes it recovered since the last
   * save to the allowance ledger, in one transaction.
   *
   * The charge does not depend on the job's row still existing. Deleting a
   * record while its run is still winding down removes the row, so the run's
   * last saves update nothing — but what it wrote in that time is on the
   * user's disk all the same, and the ledger counts it.
   */
  saveCounters(
    jobId: string,
    status: RecoveryStatus,
    counters: {
      recoveredFiles: number
      recoveredBytes: number
      partialFiles: number
      skippedFiles: number
      failedFiles: number
      mismatchedFiles: number
    },
    newlyRecoveredBytes: number,
  ): void {
    try {
      withTransaction(this.db, () => {
        this.updateCounters.run(
          status,
          counters.recoveredFiles,
          counters.recoveredBytes,
          counters.partialFiles,
          counters.skippedFiles,
          counters.failedFiles,
          counters.mismatchedFiles,
          jobId,
        )

        if (newlyRecoveredBytes > 0) this.chargeAllowance.run(newlyRecoveredBytes)
      })
    } catch (error) {
      throw databaseError('save recovery progress', error)
    }
  }

  completeJob(jobId: string, status: RecoveryStatus, errorMessage: string | null): void {
    try {
      this.finishJob.run(status, Date.now(), errorMessage, jobId)
    } catch (error) {
      throw databaseError('complete recovery job', error)
    }
  }

  /** Append a batch of per-file outcomes, in one transaction. */
  addItems(items: readonly RecoveryItem[]): void {
    if (items.length === 0) return

    try {
      withTransaction(this.db, () => {
        for (const item of items) {
          this.insertItem.run(
            item.jobId,
            item.fileId,
            item.name,
            item.targetPath,
            item.status,
            item.verification,
            item.bytesWritten,
            item.expectedBytes,
            item.error,
          )
        }
      })
    } catch (error) {
      throw databaseError('store recovery results', error)
    }
  }

  getJob(jobId: string): RecoveryJob | null {
    try {
      const row = this.db.prepare('SELECT * FROM recovery_job WHERE id = ?').get(jobId)
      return row === undefined ? null : toJob(row)
    } catch (error) {
      throw databaseError('read recovery job', error)
    }
  }

  /** Jobs, newest first. Drives the recovery history screen. */
  listJobs(limit = 50): RecoveryJob[] {
    try {
      return this.db
        .prepare('SELECT * FROM recovery_job ORDER BY started_at DESC LIMIT ?')
        .all(limit)
        .map((row) => toJob(row as SqliteRow))
    } catch (error) {
      throw databaseError('list recovery jobs', error)
    }
  }

  /**
   * Per-file outcomes, optionally narrowed to specific statuses.
   *
   * The common query is "show me only what failed", which is why the status
   * filter is pushed into SQL rather than applied after loading everything.
   */
  listItems(filter: RecoveryItemFilter): RecoveryItem[] {
    const conditions = ['job_id = ?']
    const parameters: Array<string | number> = [filter.jobId]

    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      conditions.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
      parameters.push(...filter.statuses)
    }

    try {
      return this.db
        .prepare(
          `SELECT * FROM recovery_item
            WHERE ${conditions.join(' AND ')}
            ORDER BY id ASC
            LIMIT ? OFFSET ?`,
        )
        .all(...parameters, filter.limit, filter.offset)
        .map((row) => toItem(row as SqliteRow))
    } catch (error) {
      throw databaseError('read recovery results', error)
    }
  }

  countItems(jobId: string): number {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM recovery_item WHERE job_id = ?')
        .get(jobId)

      return row === undefined ? 0 : readInteger(row, 'n')
    } catch (error) {
      throw databaseError('count recovery results', error)
    }
  }

  /**
   * Bytes successfully recovered across every job ever run on this computer,
   * including jobs whose records have since been deleted.
   *
   * Read from the allowance ledger (see migration 005), never summed over the
   * jobs: the history can be deleted, the allowance cannot be given back. Like
   * the jobs' own `recovered_bytes` it excludes files that failed or were
   * skipped: an edition ceiling must be charged for the data a user actually
   * got back, not for attempts that produced nothing.
   */
  totalRecoveredBytes(): number {
    try {
      const row = this.db
        .prepare('SELECT recovered_bytes AS total FROM recovery_allowance WHERE id = 1')
        .get() as SqliteRow | undefined

      return row === undefined ? 0 : readInteger(row, 'total')
    } catch (error) {
      throw databaseError('The recovered total could not be read', error)
    }
  }

  deleteJob(jobId: string): void {
    try {
      this.db.prepare('DELETE FROM recovery_job WHERE id = ?').run(jobId)
    } catch (error) {
      throw databaseError('delete recovery job', error)
    }
  }
}

function toJob(row: SqliteRow): RecoveryJob {
  return {
    id: readText(row, 'id'),
    sessionId: readText(row, 'session_id'),
    destination: readText(row, 'destination'),
    status: readText(row, 'status') as RecoveryStatus,
    restoreFolderStructure: readBoolean(row, 'restore_structure'),
    startedAt: readInteger(row, 'started_at'),
    finishedAt: readOptionalInteger(row, 'finished_at'),
    totalFiles: readInteger(row, 'total_files'),
    totalBytes: readInteger(row, 'total_bytes'),
    recoveredFiles: readInteger(row, 'recovered_files'),
    recoveredBytes: readInteger(row, 'recovered_bytes'),
    partialFiles: readInteger(row, 'partial_files'),
    skippedFiles: readInteger(row, 'skipped_files'),
    failedFiles: readInteger(row, 'failed_files'),
    mismatchedFiles: readInteger(row, 'mismatched_files'),
    errorMessage: row.error_message === null ? null : readText(row, 'error_message'),
  }
}

function toItem(row: SqliteRow): RecoveryItem {
  return {
    jobId: readText(row, 'job_id'),
    fileId: readText(row, 'file_id'),
    name: readText(row, 'name'),
    targetPath: readText(row, 'target_path'),
    status: readText(row, 'status') as RecoveryItemStatus,
    verification: readText(row, 'verification') as RecoveryItem['verification'],
    bytesWritten: readInteger(row, 'bytes_written'),
    expectedBytes: readInteger(row, 'expected_bytes'),
    error: row.error === null ? null : readText(row, 'error'),
  }
}

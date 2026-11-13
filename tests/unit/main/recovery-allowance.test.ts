import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseConnection } from '@main/database/connection'
import { runMigrations } from '@main/database/migrator'
import { MIGRATIONS } from '@main/database/migrations'
import { RecoveryRepository } from '@main/database/repositories/recovery.repository'
import { ScanRepository } from '@main/database/repositories/scan.repository'
import type { Logger } from '@main/logging/logger'
import { entitlementsFor } from '@shared/types/license'

/**
 * The figure the Free allowance is charged against.
 *
 * The listing promises "1 GB of recovered files in total on each computer".
 * The recovery history is the user's to delete — a record at a time from
 * History, or a scan with every recovery made from it — and none of that may
 * hand the allowance back.
 */

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
}

const SESSION = 'session-1'
const MIB = 1024 * 1024
const FREE_LIMIT = entitlementsFor('free').recoveryLimitBytes ?? 0

/** A job's counters with only the recovered bytes of interest. */
function counters(recoveredBytes: number) {
  return {
    recoveredFiles: 1,
    recoveredBytes,
    partialFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    mismatchedFiles: 0,
  }
}

describe('the Free recovery allowance', () => {
  let directory: string
  let connection: DatabaseConnection
  let scans: ScanRepository
  let recoveries: RecoveryRepository

  function createSession(id = SESSION): void {
    scans.createSession({
      id,
      deviceId: 'disk0',
      partitionId: 'disk0:p1',
      deviceModel: 'Test Drive',
      volumeLabel: 'DATA',
      fileSystem: 'ntfs',
      scanType: 'quick',
      status: 'completed',
      startedAt: Date.now(),
    })
  }

  /** A finished job that recovered `bytes`, saved the way a run saves it. */
  function recovered(jobId: string, bytes: number, sessionId = SESSION): void {
    recoveries.createJob({
      id: jobId,
      sessionId,
      destination: 'E:\\Recovered',
      restoreFolderStructure: false,
      startedAt: Date.now(),
      totalFiles: 1,
      totalBytes: bytes,
    })
    recoveries.saveCounters(jobId, 'completed', counters(bytes), bytes)
    recoveries.completeJob(jobId, 'completed', null)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-allowance-'))
    connection = openDatabase({ filePath: join(directory, 'test.db'), logger: silentLogger })
    runMigrations(connection.db, silentLogger)
    scans = new ScanRepository(connection.db)
    recoveries = new RecoveryRepository(connection.db)
    createSession()
  })

  afterEach(() => {
    connection.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('starts at nothing on a new computer', () => {
    expect(recoveries.totalRecoveredBytes()).toBe(0)
  })

  it('is charged as a run saves its progress, once per byte', () => {
    recoveries.createJob({
      id: 'job-1',
      sessionId: SESSION,
      destination: 'E:\\Recovered',
      restoreFolderStructure: false,
      startedAt: Date.now(),
      totalFiles: 3,
      totalBytes: 900 * MIB,
    })

    // Each save carries the job's running total and what is new since the last.
    recoveries.saveCounters('job-1', 'running', counters(300 * MIB), 300 * MIB)
    recoveries.saveCounters('job-1', 'running', counters(700 * MIB), 400 * MIB)
    recoveries.saveCounters('job-1', 'completed', counters(700 * MIB), 0)

    expect(recoveries.totalRecoveredBytes()).toBe(700 * MIB)
    expect(recoveries.getJob('job-1')?.recoveredBytes).toBe(700 * MIB)
  })

  it('adds up every run', () => {
    recovered('job-1', 400 * MIB)
    recovered('job-2', 250 * MIB)

    expect(recoveries.totalRecoveredBytes()).toBe(650 * MIB)
  })

  it('is not given back when a record is deleted from History', () => {
    recovered('job-1', FREE_LIMIT)

    recoveries.deleteJob('job-1')

    expect(recoveries.listJobs()).toEqual([])
    expect(recoveries.totalRecoveredBytes()).toBe(FREE_LIMIT)
  })

  it('is not given back when the scan the recoveries came from is deleted', () => {
    recovered('job-1', 600 * MIB)
    recovered('job-2', 424 * MIB)

    // Removes both jobs through ON DELETE CASCADE.
    scans.deleteSession(SESSION)

    expect(recoveries.listJobs()).toEqual([])
    expect(recoveries.totalRecoveredBytes()).toBe(1024 * MIB)
  })

  it('stays spent through delete-and-recover-again', () => {
    for (let round = 1; round <= 3; round += 1) {
      recovered(`job-${round}`, FREE_LIMIT)
      recoveries.deleteJob(`job-${round}`)
    }

    expect(recoveries.totalRecoveredBytes()).toBe(3 * FREE_LIMIT)
  })

  it('counts what a run wrote after its record was deleted under it', () => {
    // History → Delete record on a running job cancels it and deletes the row;
    // the run's last saves then find no row, but the files are on disk.
    recoveries.createJob({
      id: 'job-1',
      sessionId: SESSION,
      destination: 'E:\\Recovered',
      restoreFolderStructure: false,
      startedAt: Date.now(),
      totalFiles: 2,
      totalBytes: 500 * MIB,
    })
    recoveries.saveCounters('job-1', 'running', counters(100 * MIB), 100 * MIB)
    recoveries.deleteJob('job-1')

    recoveries.saveCounters('job-1', 'cancelled', counters(180 * MIB), 80 * MIB)

    expect(recoveries.getJob('job-1')).toBeNull()
    expect(recoveries.totalRecoveredBytes()).toBe(180 * MIB)
  })

  it('charges a database from before the ledger for what it had recovered', () => {
    const previous = join(directory, 'previous.db')
    const old = openDatabase({ filePath: previous, logger: silentLogger })

    try {
      runMigrations(old.db, silentLogger, MIGRATIONS.slice(0, 4))
      old.db
        .prepare(
          `INSERT INTO scan_session (id, device_id, device_model, file_system, scan_type, status, started_at)
           VALUES ('s', 'disk0', 'Test Drive', 'ntfs', 'quick', 'completed', 0)`,
        )
        .run()
      const insertJob = old.db.prepare(
        `INSERT INTO recovery_job (id, session_id, destination, status, restore_structure, started_at, recovered_bytes)
         VALUES (?, 's', 'E:\\', 'completed', 0, 0, ?)`,
      )
      insertJob.run('a', 300 * MIB)
      insertJob.run('b', 200 * MIB)

      runMigrations(old.db, silentLogger)

      const upgraded = new RecoveryRepository(old.db)
      expect(upgraded.totalRecoveredBytes()).toBe(500 * MIB)

      upgraded.deleteJob('a')
      expect(upgraded.totalRecoveredBytes()).toBe(500 * MIB)
    } finally {
      old.close()
    }
  })

  it('recreates its row rather than charging nothing if the row has gone', () => {
    connection.db.prepare('DELETE FROM recovery_allowance').run()

    recovered('job-1', 10 * MIB)

    expect(recoveries.totalRecoveredBytes()).toBe(10 * MIB)
  })
})

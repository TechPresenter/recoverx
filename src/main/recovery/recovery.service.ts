import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type {
  RecoveryItem,
  RecoveryJob,
  RecoveryOptions,
  RecoveryProgress,
  RecoveryStatus,
  StartRecoveryRequest,
} from '@shared/types/recovery'
import type { RecoveredFile, Selection } from '@shared/types/scan'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import { estimateRemainingMs } from '@shared/utils/time'
import type { RecoveryRepository } from '../database/repositories/recovery.repository'
import type { ScanRepository } from '../database/repositories/scan.repository'
import type { BlockReader } from '../disk/block-device'
import type { DiskService } from '../disk/disk.service'
import type { Logger } from '../logging/logger'
import {
  assertUsableDestination,
  ensureDirectory,
  validateDestination,
  type DestinationCheck,
} from './destination-guard'
import { recoverFile, type RecoveryControl } from './recovery-writer'
import { buildTargetSegments, isInsideRoot, uniqueName } from './safe-path'

/**
 * Recovery orchestration.
 *
 * Files are pulled from the database a page at a time and written one by one.
 * Nothing about a run is held in memory beyond the current page and the set of
 * names already used, so restoring two million files costs the same as
 * restoring two hundred.
 *
 * The destination is validated before the job row exists and re-asserted before
 * the first byte is written. Both checks are cheap; the failure they prevent is
 * not recoverable.
 */

const PROGRESS_INTERVAL_MS = 250
const PAGE_SIZE = 200
/** Outcomes buffered before a database write. */
const ITEM_BATCH = 100

export type RecoveryProgressListener = (progress: RecoveryProgress) => void

interface ActiveJob {
  readonly id: string
  readonly sessionId: string
  status: RecoveryStatus
  readonly startedAt: number
  readonly totalFiles: number
  readonly totalBytes: number
  processedFiles: number
  recoveredBytes: number
  /** How much of `recoveredBytes` has been charged to the allowance ledger. */
  chargedBytes: number
  currentFile: string | null
  recoveredFiles: number
  partialFiles: number
  skippedFiles: number
  failedFiles: number
  mismatchedFiles: number
  cancelled: boolean
  resume: (() => void) | null
}

/**
 * The part of licensing this module needs.
 *
 * Depending on the interface rather than the service keeps the recovery engine
 * testable without a licence file, a machine identifier or a signing key — and
 * makes it obvious that recovery asks licensing exactly one question.
 */
export interface LicenseEnforcer {
  assertRecoveryAllowed(recoveredBytes: number, requestedBytes: number): Promise<void>
}

export class RecoveryManager {
  private readonly licensing: LicenseEnforcer
  private readonly disks: DiskService
  private readonly scans: ScanRepository
  private readonly repository: RecoveryRepository
  private readonly logger: Logger
  private readonly listeners = new Set<RecoveryProgressListener>()
  private readonly active = new Map<string, ActiveJob>()

  constructor(
    disks: DiskService,
    scans: ScanRepository,
    repository: RecoveryRepository,
    licensing: LicenseEnforcer,
    logger: Logger,
  ) {
    this.disks = disks
    this.scans = scans
    this.repository = repository
    this.licensing = licensing
    this.logger = logger.child('recovery')
  }

  /**
   * Bytes successfully recovered across every job ever run, the figure the
   * Free allowance is charged against.
   *
   * Kept in the database's allowance ledger, which is charged in the same
   * transaction as each job's counters, so it survives a restart and never
   * runs behind the history. It is deliberately not summed from the history:
   * the user can delete records there, and deleting a record must not give
   * the allowance back.
   */
  totalRecoveredBytes(): number {
    return this.repository.totalRecoveredBytes()
  }

  onProgress(listener: RecoveryProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Check a destination without starting anything.
   *
   * Called as the user types or picks a folder, so the refusal appears before
   * they commit rather than after.
   */
  async checkDestination(selection: Selection, destination: string): Promise<DestinationCheck> {
    const session = this.scans.getSession(selection.filter.sessionId)

    if (session === null) {
      throw new AppError(ErrorCode.NotFound, 'That scan no longer exists', { retryable: false })
    }

    const summary = this.scans.summariseSelection(selection)

    return validateDestination({
      destination,
      sourceDeviceId: session.deviceId,
      devices: this.disks.getCached()?.devices ?? [],
      requiredBytes: summary.totalSizeBytes,
    })
  }

  /** Begin a recovery. Returns once the job row exists; the run is detached. */
  async start(request: StartRecoveryRequest): Promise<RecoveryJob> {
    const { selection, options } = request
    const sessionId = selection.filter.sessionId

    const session = this.scans.getSession(sessionId)
    if (session === null) {
      throw new AppError(ErrorCode.NotFound, 'That scan no longer exists', { retryable: false })
    }

    // The guard runs before anything is created, so a refused destination
    // leaves no job row behind to confuse the history.
    const check = await this.checkDestination(selection, options.destination)
    assertUsableDestination(check)

    const summary = this.scans.summariseSelection(selection)
    if (summary.count === 0) {
      throw new AppError(ErrorCode.Validation, 'No files are selected', { retryable: false })
    }

    /*
     * The edition ceiling is checked here, before a job row exists and before a
     * single byte is written. Checking it in the UI as well is a courtesy to
     * the user; checking it here is what actually enforces it, because this is
     * the one path every recovery must pass through.
     */
    await this.licensing.assertRecoveryAllowed(this.totalRecoveredBytes(), summary.totalSizeBytes)

    await ensureDirectory(options.destination)

    const job: ActiveJob = {
      id: randomUUID(),
      sessionId,
      status: 'running',
      startedAt: Date.now(),
      totalFiles: summary.count,
      totalBytes: summary.totalSizeBytes,
      processedFiles: 0,
      recoveredBytes: 0,
      chargedBytes: 0,
      currentFile: null,
      recoveredFiles: 0,
      partialFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      mismatchedFiles: 0,
      cancelled: false,
      resume: null,
    }

    this.repository.createJob({
      id: job.id,
      sessionId,
      destination: options.destination,
      restoreFolderStructure: options.restoreFolderStructure,
      startedAt: job.startedAt,
      totalFiles: job.totalFiles,
      totalBytes: job.totalBytes,
    })

    this.active.set(job.id, job)

    this.logger.info('Recovery started', {
      jobId: job.id,
      destination: options.destination,
      files: job.totalFiles,
      bytes: job.totalBytes,
    })

    void this.run(job, selection, options, session.deviceId)

    const created = this.repository.getJob(job.id)
    if (created === null) {
      throw new AppError(ErrorCode.Database, 'The recovery job could not be recorded', {
        retryable: false,
      })
    }

    return created
  }

  pause(jobId: string): void {
    const job = this.requireActive(jobId)
    if (job.status !== 'running') return

    job.status = 'paused'
    this.emit(job)
    this.logger.info('Recovery paused', { jobId })
  }

  resume(jobId: string): void {
    const job = this.requireActive(jobId)
    if (job.status !== 'paused') return

    job.status = 'running'
    job.resume?.()
    job.resume = null
    this.emit(job)
    this.logger.info('Recovery resumed', { jobId })
  }

  /**
   * Stop a run, keeping every file already written.
   *
   * The file in flight is removed by the writer, because a truncated file on
   * disk is worse than no file: the user would take it for a complete recovery.
   */
  cancel(jobId: string): void {
    const job = this.requireActive(jobId)

    job.cancelled = true
    job.status = 'cancelled'
    job.resume?.()
    job.resume = null

    this.logger.info('Recovery cancelled', { jobId, recovered: job.recoveredFiles })
  }

  getProgress(jobId: string): RecoveryProgress | null {
    const active = this.active.get(jobId)
    if (active !== undefined) return this.toProgress(active)

    const stored = this.repository.getJob(jobId)
    if (stored === null) return null

    return {
      jobId: stored.id,
      status: stored.status,
      processedFiles:
        stored.recoveredFiles + stored.partialFiles + stored.skippedFiles + stored.failedFiles,
      totalFiles: stored.totalFiles,
      recoveredBytes: stored.recoveredBytes,
      totalBytes: stored.totalBytes,
      currentFile: null,
      elapsedMs: (stored.finishedAt ?? Date.now()) - stored.startedAt,
      estimatedRemainingMs: null,
      bytesPerSecond: 0,
    }
  }

  isActive(jobId: string): boolean {
    return this.active.has(jobId)
  }

  /**
   * `true` while anything is still running.
   *
   * Asked before the application is allowed to quit and install an update: a
   * restart in the middle of this work would leave a half-written file the user
   * believes is intact, which is worse than not updating at all.
   */
  hasActiveWork(): boolean {
    return this.active.size > 0
  }

  cancelAll(): void {
    for (const jobId of [...this.active.keys()]) {
      try {
        this.cancel(jobId)
      } catch {
        continue
      }
    }
  }

  // --- internals -----------------------------------------------------------

  private async run(
    job: ActiveJob,
    selection: Selection,
    options: RecoveryOptions,
    deviceId: string,
  ): Promise<void> {
    let device: BlockReader | null = null

    // Case-insensitive, because the destination filesystem almost certainly is.
    const usedPaths = new Set<string>()
    let pending: RecoveryItem[] = []
    let lastEmit = 0

    const control: RecoveryControl = {
      cancelled: false,
      waitWhilePaused: async () => {
        if (job.status !== 'paused') return
        await new Promise<void>((resolve) => {
          job.resume = resolve
        })
      },
    }

    try {
      device = this.disks.openDevice(deviceId)

      for (let offset = 0; ; offset += PAGE_SIZE) {
        if (job.cancelled) break

        const page = this.scans.resolveSelection(selection, PAGE_SIZE, offset)
        if (page.length === 0) break

        for (const file of page) {
          if (job.cancelled) break

          await control.waitWhilePaused()
          if (job.cancelled) break

          control.cancelled = job.cancelled
          job.currentFile = file.name

          const target = this.resolveTarget(file, options, usedPaths)

          const outcome =
            target === null
              ? {
                  fileId: file.id,
                  name: file.name,
                  targetPath: '',
                  bytesWritten: 0,
                  expectedBytes: file.sizeBytes,
                  status: 'failed' as const,
                  verification: 'empty' as const,
                  detectedLabel: null,
                  error: 'The destination path for this file was not valid',
                }
              : await recoverFile(device, file, target, control, (delta) => {
                  job.recoveredBytes += delta
                })

          this.tally(job, outcome.status, outcome.verification)

          pending.push({
            jobId: job.id,
            fileId: outcome.fileId,
            name: outcome.name,
            targetPath: outcome.targetPath,
            status: outcome.status,
            verification: outcome.verification,
            bytesWritten: outcome.bytesWritten,
            expectedBytes: outcome.expectedBytes,
            error: outcome.error,
          })

          if (pending.length >= ITEM_BATCH) {
            this.repository.addItems(pending)
            pending = []
          }

          job.processedFiles += 1

          const now = Date.now()
          if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
            lastEmit = now
            this.persist(job)
            this.emit(job)
          }

          // Hand the event loop back so IPC and the UI stay responsive during
          // a long run.
          await yieldToEventLoop()
        }
      }

      if (pending.length > 0) this.repository.addItems(pending)

      this.finish(job, job.cancelled ? 'cancelled' : 'completed', null)
    } catch (error) {
      if (pending.length > 0) {
        try {
          this.repository.addItems(pending)
        } catch {
          // The run is already failing; losing the tail of the log is the
          // lesser problem.
        }
      }

      const message = describeUnknown(error)
      this.logger.error('Recovery failed', { jobId: job.id, reason: message })
      this.finish(job, 'failed', message)
    } finally {
      device?.close()
      this.active.delete(job.id)
    }
  }

  /**
   * Work out where a file should be written, refusing anything that escapes.
   *
   * Returns `null` when the resolved path would land outside the destination —
   * a condition the segment sanitiser should already prevent, checked again
   * here because the consequence of being wrong is writing into the user's
   * system folders.
   */
  private resolveTarget(
    file: RecoveredFile,
    options: RecoveryOptions,
    usedPaths: Set<string>,
  ): string | null {
    const segments = buildTargetSegments(file.name, file.path, {
      restoreFolderStructure: options.restoreFolderStructure,
      ...(options.groupByCategory ? { groupByCategory: categoryFolder(file.category) } : {}),
    })

    const name = segments.pop() ?? 'unnamed'
    const directory = join(options.destination, ...segments)

    // Uniqueness is per directory: two files with the same name in different
    // folders must not collide with each other.
    const takenHere = new Set(
      [...usedPaths]
        .filter((path) => path.startsWith(`${directory.toLowerCase()}\\`))
        .map((path) => path.slice(directory.length + 1)),
    )

    const finalName = uniqueName(takenHere, name)
    const target = join(directory, finalName)

    if (!isInsideRoot(options.destination, target)) return null

    usedPaths.add(target.toLowerCase())

    return target
  }

  private tally(
    job: ActiveJob,
    status: RecoveryItem['status'],
    verification: RecoveryItem['verification'],
  ): void {
    switch (status) {
      case 'recovered':
        job.recoveredFiles += 1
        break
      case 'partial':
        job.partialFiles += 1
        break
      case 'skipped':
        job.skippedFiles += 1
        break
      case 'failed':
        job.failedFiles += 1
        break
    }

    if (verification === 'mismatch') job.mismatchedFiles += 1
  }

  private finish(job: ActiveJob, status: RecoveryStatus, errorMessage: string | null): void {
    job.status = status
    job.currentFile = null

    this.persist(job)
    this.repository.completeJob(job.id, status, errorMessage)
    this.emit(job)

    this.logger.info('Recovery finished', {
      jobId: job.id,
      status,
      recovered: job.recoveredFiles,
      partial: job.partialFiles,
      failed: job.failedFiles,
      durationMs: Date.now() - job.startedAt,
    })
  }

  /**
   * Save the job's counters and charge what it has recovered since the last
   * save to the Free allowance.
   *
   * The charge is worked out here, from what this run wrote, rather than from
   * the job's row: the row can be deleted from History while the run is still
   * winding down, and the bytes it wrote meanwhile must still count.
   */
  private persist(job: ActiveJob): void {
    const recoveredBytes = job.recoveredBytes

    this.repository.saveCounters(
      job.id,
      job.status,
      {
        recoveredFiles: job.recoveredFiles,
        recoveredBytes,
        partialFiles: job.partialFiles,
        skippedFiles: job.skippedFiles,
        failedFiles: job.failedFiles,
        mismatchedFiles: job.mismatchedFiles,
      },
      recoveredBytes - job.chargedBytes,
    )

    job.chargedBytes = recoveredBytes
  }

  private toProgress(job: ActiveJob): RecoveryProgress {
    const elapsedMs = Date.now() - job.startedAt

    return {
      jobId: job.id,
      status: job.status,
      processedFiles: job.processedFiles,
      totalFiles: job.totalFiles,
      recoveredBytes: job.recoveredBytes,
      totalBytes: job.totalBytes,
      currentFile: job.currentFile,
      elapsedMs,
      // Estimated from bytes rather than file count: a run of one large video
      // and a thousand thumbnails is nowhere near linear in files.
      estimatedRemainingMs:
        job.status === 'running'
          ? estimateRemainingMs(job.recoveredBytes, job.totalBytes, elapsedMs)
          : null,
      bytesPerSecond: elapsedMs > 0 ? Math.round((job.recoveredBytes / elapsedMs) * 1000) : 0,
    }
  }

  private emit(job: ActiveJob): void {
    const progress = this.toProgress(job)

    for (const listener of this.listeners) {
      try {
        listener(progress)
      } catch {
        continue
      }
    }
  }

  private requireActive(jobId: string): ActiveJob {
    const job = this.active.get(jobId)

    if (job === undefined) {
      throw new AppError(ErrorCode.NotFound, 'That recovery is no longer running', {
        details: jobId,
        retryable: false,
      })
    }

    return job
  }
}

/** Folder name for a category when grouping is enabled. */
function categoryFolder(category: RecoveredFile['category']): string {
  return category.charAt(0).toUpperCase() + category.slice(1)
}

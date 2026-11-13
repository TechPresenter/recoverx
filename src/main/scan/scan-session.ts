import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { supportsQuickScan, type FileSystem } from '@shared/types/disk'
import {
  type RecoveredFile,
  type ScanProgress,
  type ScanSession,
  type ScanStatus,
  type ScanType,
} from '@shared/types/scan'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import { estimateRemainingMs } from '@shared/utils/time'
import type { ScanRepository } from '../database/repositories/scan.repository'
import type { BlockReader } from '../disk/block-device'
import type { DiskService } from '../disk/disk.service'
import type { Logger } from '../logging/logger'
import { carveVolume } from './carve/carve-scanner'
import { scanExfatVolume } from './fat/exfat-scanner'
import { scanFatVolume } from './fat/fat-scanner'
import { scanNtfsVolume } from './ntfs/ntfs-scanner'
import type { ScanBatch } from './scan-types'

/**
 * Scan orchestration.
 *
 * The scanners are async generators, so the consumer sets the pace. That makes
 * the control model almost free: pausing is not pulling, cancelling is breaking
 * out of the loop, and back-pressure is automatic when SQLite writes are slower
 * than parsing.
 *
 * A quick scan runs in the main process rather than a worker. It is I/O-bound —
 * it reads metadata structures, it does not compute — and the event loop is
 * yielded between batches so IPC stays responsive. Signature carving is the
 * CPU-bound workload that genuinely needs worker threads, and it will bring them
 * when it lands.
 */

/** How often progress is pushed to the renderer. */
const PROGRESS_INTERVAL_MS = 250

/** Sampling window for the throughput figure behind the ETA. */
const RATE_WINDOW_MS = 5000

export interface StartScanRequest {
  readonly deviceId: string
  /** `null` scans the whole device, including unallocated space. */
  readonly partitionId: string | null
  readonly scanType: ScanType
  /** Include files that still exist, not just deleted ones. */
  readonly includeExisting: boolean
}

export type ProgressListener = (progress: ScanProgress) => void

interface ActiveScan {
  session: ScanSession
  status: ScanStatus
  filesFound: number
  bytesFound: number
  processed: number
  total: number
  startedAt: number
  /** Resolved when a paused scan is allowed to continue. */
  resume: (() => void) | null
  cancelled: boolean
  /** Rolling sample for the throughput estimate. */
  rateSample: { at: number; processed: number }
}

export class ScanManager {
  private readonly disks: DiskService
  private readonly repository: ScanRepository
  private readonly logger: Logger
  private readonly listeners = new Set<ProgressListener>()
  private readonly active = new Map<string, ActiveScan>()

  constructor(disks: DiskService, repository: ScanRepository, logger: Logger) {
    this.disks = disks
    this.repository = repository
    this.logger = logger.child('scan')
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Begin a scan.
   *
   * Returns as soon as the session row exists; the scan itself runs detached so
   * the IPC call does not block for the duration of a multi-hour operation.
   */
  start(request: StartScanRequest): ScanSession {
    const device = this.disks.requireDevice(request.deviceId)

    const partition =
      request.partitionId === null
        ? null
        : device.partitions.find((candidate) => candidate.id === request.partitionId)

    if (request.partitionId !== null && partition === undefined) {
      throw new AppError(ErrorCode.NotFound, 'That partition is no longer present', {
        details: request.partitionId,
        retryable: false,
      })
    }

    const fileSystem: FileSystem = partition?.fileSystem ?? 'unknown'

    if (request.scanType === 'quick' && !supportsQuickScan(fileSystem)) {
      throw new AppError(
        ErrorCode.Unsupported,
        'A quick scan needs a filesystem it can read. Run a deep scan on this volume instead.',
        { details: fileSystem, retryable: false },
      )
    }

    const session: ScanSession = {
      id: randomUUID(),
      deviceId: device.id,
      partitionId: partition?.id ?? null,
      deviceModel: device.model,
      volumeLabel: partition?.label ?? null,
      fileSystem,
      scanType: request.scanType,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      filesFound: 0,
      bytesFound: 0,
      processed: 0,
      total: 0,
      errorMessage: null,
    }

    this.repository.createSession(session)

    const state: ActiveScan = {
      session,
      status: 'running',
      filesFound: 0,
      bytesFound: 0,
      processed: 0,
      total: 0,
      startedAt: session.startedAt,
      resume: null,
      cancelled: false,
      rateSample: { at: session.startedAt, processed: 0 },
    }

    this.active.set(session.id, state)

    this.logger.info('Scan started', {
      sessionId: session.id,
      device: device.model,
      partition: partition?.id ?? 'whole device',
      fileSystem,
      scanType: request.scanType,
    })

    // Detached on purpose: `run` owns the session's lifetime and records its own
    // failures, so a rejection here has nowhere useful to go.
    void this.run(
      state,
      request,
      partition?.offsetBytes ?? 0,
      partition?.sizeBytes ?? device.sizeBytes,
    )

    return session
  }

  pause(sessionId: string): void {
    const state = this.requireActive(sessionId)
    if (state.status !== 'running') return

    state.status = 'paused'
    this.persistProgress(state)
    this.emit(state)
    this.logger.info('Scan paused', { sessionId })
  }

  resume(sessionId: string): void {
    const state = this.requireActive(sessionId)
    if (state.status !== 'paused') return

    state.status = 'running'
    state.resume?.()
    state.resume = null
    this.emit(state)
    this.logger.info('Scan resumed', { sessionId })
  }

  /**
   * Stop a scan, keeping everything found so far.
   *
   * Discarding partial results would be actively hostile: a user who cancels a
   * six-hour scan after finding what they came for must keep it.
   */
  cancel(sessionId: string): void {
    const state = this.requireActive(sessionId)

    state.cancelled = true
    state.status = 'cancelled'
    // A paused scan has to be woken before it can observe the cancellation.
    state.resume?.()
    state.resume = null

    this.logger.info('Scan cancelled', { sessionId, filesFound: state.filesFound })
  }

  getProgress(sessionId: string): ScanProgress | null {
    const state = this.active.get(sessionId)
    if (state !== undefined) return this.toProgress(state)

    const stored = this.repository.getSession(sessionId)
    if (stored === null) return null

    return {
      sessionId: stored.id,
      status: stored.status,
      processed: stored.processed,
      total: stored.total,
      filesFound: stored.filesFound,
      bytesFound: stored.bytesFound,
      elapsedMs: (stored.finishedAt ?? Date.now()) - stored.startedAt,
      estimatedRemainingMs: null,
      filesPerSecond: 0,
    }
  }

  /** `true` when a scan is currently running or paused. */
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /** Cancel everything. Called during shutdown. */
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
    for (const sessionId of [...this.active.keys()]) {
      try {
        this.cancel(sessionId)
      } catch {
        continue
      }
    }
  }

  // --- internals -----------------------------------------------------------

  private async run(
    state: ActiveScan,
    request: StartScanRequest,
    volumeOffsetBytes: number,
    volumeSizeBytes: number,
  ): Promise<void> {
    let owner: BlockReader | null = null
    let reader: BlockReader | null = null

    try {
      if (request.partitionId === null) {
        reader = this.disks.openDevice(request.deviceId)
        owner = reader
      } else {
        const opened = this.disks.openPartition(request.deviceId, request.partitionId)
        reader = opened.reader
        owner = opened.owner
      }

      const generator =
        request.scanType === 'deep'
          ? carveVolume(reader, state.session.id, volumeOffsetBytes, {
              includeExisting: request.includeExisting,
            })
          : this.createScanner(
              state.session.fileSystem as FileSystem,
              reader,
              state.session.id,
              volumeOffsetBytes,
              request.includeExisting,
            )

      let lastEmit = 0

      for await (const batch of generator) {
        if (state.cancelled) break

        await this.waitWhilePaused(state)
        if (state.cancelled) break

        this.absorb(state, batch)

        const now = Date.now()
        if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = now
          this.persistProgress(state)
          this.emit(state)
        }

        // Hand the event loop back so IPC, window events and the renderer's
        // progress updates are not starved by a tight scan loop.
        await yieldToEventLoop()
      }

      this.finish(state, state.cancelled ? 'cancelled' : 'completed', null)
    } catch (error) {
      const message = describeUnknown(error)

      this.logger.error('Scan failed', { sessionId: state.session.id, reason: message })
      this.finish(state, 'failed', message)
    } finally {
      // A partition reader is a slice; the owner holds the real handle, and
      // closing only the slice would leak it and keep the volume locked.
      owner?.close()
      if (reader !== owner) reader?.close()

      this.active.delete(state.session.id)
      void volumeSizeBytes
    }
  }

  private createScanner(
    fileSystem: FileSystem,
    reader: BlockReader,
    sessionId: string,
    volumeOffsetBytes: number,
    includeExisting: boolean,
  ): AsyncGenerator<ScanBatch> {
    const options = { includeExisting }

    // An if-chain rather than a switch: only five of the eighteen filesystems
    // have a metadata scanner, and the rest are all one outcome.
    if (fileSystem === 'ntfs') {
      return scanNtfsVolume(reader, sessionId, volumeOffsetBytes, options)
    }

    if (fileSystem === 'exfat') {
      return scanExfatVolume(reader, sessionId, volumeOffsetBytes, options)
    }

    if (fileSystem === 'fat12' || fileSystem === 'fat16' || fileSystem === 'fat32') {
      return scanFatVolume(reader, sessionId, volumeOffsetBytes, options)
    }

    throw new AppError(ErrorCode.Unsupported, 'No quick scanner supports this filesystem', {
      details: fileSystem,
      retryable: false,
    })
  }

  /** Store a batch and fold its counts into the session state. */
  private absorb(state: ActiveScan, batch: ScanBatch): void {
    if (batch.files.length > 0) {
      this.repository.addFiles(batch.files)

      state.filesFound += batch.files.length
      state.bytesFound += batch.files.reduce(
        (total: number, file: RecoveredFile) => total + file.sizeBytes,
        0,
      )
    }

    state.processed = batch.processed
    state.total = Math.max(batch.total, batch.processed)
  }

  /** Block until the scan is resumed or cancelled. */
  private async waitWhilePaused(state: ActiveScan): Promise<void> {
    if (state.status !== 'paused') return

    this.persistProgress(state)
    this.emit(state)

    await new Promise<void>((resolve) => {
      state.resume = resolve
    })
  }

  private finish(state: ActiveScan, status: ScanStatus, errorMessage: string | null): void {
    state.status = status

    this.persistProgress(state)
    this.repository.completeSession(state.session.id, status, errorMessage)
    this.emit(state)

    this.logger.info('Scan finished', {
      sessionId: state.session.id,
      status,
      filesFound: state.filesFound,
      durationMs: Date.now() - state.startedAt,
    })
  }

  private persistProgress(state: ActiveScan): void {
    this.repository.saveProgress(
      state.session.id,
      state.status,
      state.processed,
      state.total,
      state.filesFound,
      state.bytesFound,
    )
  }

  private toProgress(state: ActiveScan): ScanProgress {
    const now = Date.now()
    const elapsedMs = now - state.startedAt

    // Rate is measured over a rolling window rather than the whole scan, so a
    // slow start does not depress the ETA for the remaining hours.
    const windowMs = now - state.rateSample.at
    let filesPerSecond = 0

    if (windowMs >= RATE_WINDOW_MS) {
      filesPerSecond = ((state.processed - state.rateSample.processed) / windowMs) * 1000
      state.rateSample = { at: now, processed: state.processed }
    }

    return {
      sessionId: state.session.id,
      status: state.status,
      processed: state.processed,
      total: state.total,
      filesFound: state.filesFound,
      bytesFound: state.bytesFound,
      elapsedMs,
      estimatedRemainingMs:
        state.status === 'running' && state.total > 0
          ? estimateRemainingMs(state.processed, state.total, elapsedMs)
          : null,
      filesPerSecond: Math.max(0, Math.round(filesPerSecond)),
    }
  }

  private emit(state: ActiveScan): void {
    const progress = this.toProgress(state)

    for (const listener of this.listeners) {
      try {
        listener(progress)
      } catch {
        // A closed window must not interrupt the scan.
        continue
      }
    }
  }

  private requireActive(sessionId: string): ActiveScan {
    const state = this.active.get(sessionId)

    if (state === undefined) {
      throw new AppError(ErrorCode.NotFound, 'That scan is no longer running', {
        details: sessionId,
        retryable: false,
      })
    }

    return state
  }
}

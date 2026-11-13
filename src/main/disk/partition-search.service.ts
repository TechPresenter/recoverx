import { randomUUID } from 'node:crypto'
import type {
  PartitionCandidate,
  PartitionSearchProgress,
  PartitionSearchResult,
  PartitionSearchScope,
} from '@shared/types/partition-search'
import type { StorageDevice, UnallocatedRegion } from '@shared/types/disk'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import type { Logger } from '../logging/logger'
import type { BlockReader } from './block-device'
import type { DiskService } from './disk.service'
import { evaluateCandidate, findAnchorHits, resolveCandidates } from './partition-finder'

/**
 * Driving a lost-partition search across a device.
 *
 * The search is I/O bound in the most literal sense: it reads regions of a disk
 * from end to end and does almost nothing with the bytes. Everything here is
 * therefore arranged around keeping the read queue busy — large sequential
 * chunks, no per-sector work in JavaScript, and no synchronous pauses.
 *
 * Like the file scanner, a search runs detached from the IPC call that started
 * it. A 4 TB disk takes hours; a request/response round trip cannot span that,
 * and the user must be able to watch, cancel, and act on partial results.
 */

/**
 * Read size.
 *
 * Large enough that per-read overhead disappears against the transfer, small
 * enough that a cancel is observed promptly and that several concurrent
 * searches cannot exhaust memory. At typical SATA speeds this is a ~30 ms unit
 * of work, which is also the responsiveness floor for cancellation.
 */
const CHUNK_BYTES = 8 * 1024 * 1024

/** How often progress is pushed to the renderer. */
const PROGRESS_INTERVAL_MS = 250

export type PartitionProgressListener = (progress: PartitionSearchProgress) => void

export interface StartPartitionSearchRequest {
  readonly deviceId: string
  readonly scope: PartitionSearchScope
}

interface ActiveSearch {
  readonly searchId: string
  readonly deviceId: string
  readonly scope: PartitionSearchScope
  readonly startedAt: number
  readonly bytesTotal: number
  bytesScanned: number
  currentOffsetBytes: number
  candidates: PartitionCandidate[]
  warnings: string[]
  status: PartitionSearchResult['status']
  completedAt: number | null
  cancelled: boolean
}

export class PartitionSearchManager {
  private readonly disks: DiskService
  private readonly logger: Logger
  private readonly listeners = new Set<PartitionProgressListener>()
  private readonly searches = new Map<string, ActiveSearch>()

  constructor(disks: DiskService, logger: Logger) {
    this.disks = disks
    this.logger = logger.child('partition-search')
  }

  onProgress(listener: PartitionProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Begin a search.
   *
   * Returns the initial result envelope immediately. Candidates accumulate in
   * it as they are found, so a user who spots the partition they wanted in the
   * first minute can act on it without waiting for the disk to finish.
   */
  start(request: StartPartitionSearchRequest): PartitionSearchResult {
    const device = this.disks.requireDevice(request.deviceId)
    const regions = this.regionsFor(device, request.scope)

    if (regions.length === 0) {
      throw new AppError(ErrorCode.Validation, 'This device has no space left to search', {
        details:
          'Every part of the device is already claimed by a partition. Search the whole device to look inside them.',
        retryable: false,
      })
    }

    const searchId = randomUUID()
    const bytesTotal = regions.reduce((sum, region) => sum + region.sizeBytes, 0)

    const state: ActiveSearch = {
      searchId,
      deviceId: device.id,
      scope: request.scope,
      startedAt: Date.now(),
      bytesTotal,
      bytesScanned: 0,
      currentOffsetBytes: regions[0]?.offsetBytes ?? 0,
      candidates: [],
      warnings: [],
      status: 'running',
      completedAt: null,
      cancelled: false,
    }

    this.searches.set(searchId, state)
    this.logger.info('Partition search started', {
      searchId,
      deviceId: device.id,
      scope: request.scope,
      regions: regions.length,
      bytesTotal,
    })

    void this.run(state, device, regions)

    return this.toResult(state)
  }

  /**
   * Stop a running search.
   *
   * Candidates found so far are kept. A user who cancels after seeing their
   * partition appear wants that partition, not an empty list.
   */
  cancel(searchId: string): void {
    const state = this.searches.get(searchId)
    if (state?.status !== 'running') return

    state.cancelled = true
    this.logger.info('Partition search cancelled', {
      searchId,
      candidates: state.candidates.length,
    })
  }

  cancelAll(): void {
    for (const searchId of this.searches.keys()) this.cancel(searchId)
  }

  getResult(searchId: string): PartitionSearchResult {
    const state = this.searches.get(searchId)

    if (state === undefined) {
      throw new AppError(ErrorCode.NotFound, 'That search is no longer available', {
        details: searchId,
        retryable: false,
      })
    }

    return this.toResult(state)
  }

  // --- internals -----------------------------------------------------------

  /**
   * Decide what to read.
   *
   * An `unallocated` search trusts the table's account of which space is spare.
   * A `whole-device` search does not, and reads everything — including the
   * regions the table claims — because after a bad repartition those claims are
   * exactly what is wrong.
   */
  private regionsFor(
    device: StorageDevice,
    scope: PartitionSearchScope,
  ): readonly UnallocatedRegion[] {
    if (scope === 'whole-device') {
      return device.sizeBytes > 0 ? [{ offsetBytes: 0, sizeBytes: device.sizeBytes }] : []
    }

    return device.unallocated.filter((region) => region.sizeBytes > 0)
  }

  private async run(
    state: ActiveSearch,
    device: StorageDevice,
    regions: readonly UnallocatedRegion[],
  ): Promise<void> {
    let reader: BlockReader | null = null
    let lastEmit = 0
    let nextIndex = 1

    try {
      reader = this.disks.openDevice(device.id)
      const sectorSize = reader.sectorSize

      for (const region of regions) {
        if (state.cancelled) break

        const regionEnd = Math.min(region.offsetBytes + region.sizeBytes, reader.sizeBytes)
        let position = region.offsetBytes

        while (position < regionEnd) {
          if (state.cancelled) break

          const length = Math.min(CHUNK_BYTES, regionEnd - position)

          let chunk: Buffer
          try {
            chunk = await reader.read(position, length)
          } catch (error) {
            // A bad sector run is expected on the disks this product exists for.
            // Skipping the chunk and carrying on recovers everything after it;
            // aborting the search would throw away the rest of the device.
            state.warnings.push(
              `Could not read ${formatOffset(position)}: ${describeUnknown(error)}`,
            )
            position += length
            state.bytesScanned += length
            continue
          }

          if (chunk.length === 0) break

          for (const hit of findAnchorHits(chunk, position, sectorSize)) {
            const candidate = await evaluateCandidate(reader, hit, device.id, nextIndex, regionEnd)

            if (candidate === null) continue

            nextIndex += 1
            // Re-resolved on every find so the list the user is watching never
            // shows a volume and its own backup copy side by side.
            state.candidates = resolveCandidates([...state.candidates, candidate])
          }

          position += chunk.length
          state.bytesScanned += chunk.length
          state.currentOffsetBytes = position

          const now = Date.now()
          if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
            lastEmit = now
            this.emit(state)
          }

          /*
           * No explicit yield is needed here. `reader.read` above is real
           * asynchronous file I/O, so every iteration already returns to the
           * event loop and lets IPC, window paints and the cancel request be
           * serviced. A `Promise.resolve()` would only queue a microtask, which
           * runs before any of that and would buy nothing.
           */
        }
      }

      state.status = state.cancelled ? 'cancelled' : 'completed'
    } catch (error) {
      state.status = 'failed'
      state.warnings.push(describeUnknown(error))
      this.logger.error('Partition search failed', {
        searchId: state.searchId,
        error: describeUnknown(error),
      })
    } finally {
      reader?.close()
      state.completedAt = Date.now()
      this.emit(state)

      this.logger.info('Partition search finished', {
        searchId: state.searchId,
        status: state.status,
        candidates: state.candidates.length,
        bytesScanned: state.bytesScanned,
        elapsedMs: state.completedAt - state.startedAt,
      })
    }
  }

  private emit(state: ActiveSearch): void {
    const progress = this.toProgress(state)
    for (const listener of this.listeners) listener(progress)
  }

  private toProgress(state: ActiveSearch): PartitionSearchProgress {
    const elapsedMs = (state.completedAt ?? Date.now()) - state.startedAt
    const bytesPerSecond = elapsedMs > 0 ? (state.bytesScanned / elapsedMs) * 1000 : 0
    const remaining = state.bytesTotal - state.bytesScanned

    return {
      searchId: state.searchId,
      deviceId: state.deviceId,
      status: state.status,
      bytesScanned: state.bytesScanned,
      bytesTotal: state.bytesTotal,
      currentOffsetBytes: state.currentOffsetBytes,
      candidatesFound: state.candidates.length,
      elapsedMs,
      estimatedRemainingMs:
        bytesPerSecond > 0 && remaining > 0 ? (remaining / bytesPerSecond) * 1000 : null,
      bytesPerSecond,
    }
  }

  private toResult(state: ActiveSearch): PartitionSearchResult {
    return {
      searchId: state.searchId,
      deviceId: state.deviceId,
      scope: state.scope,
      status: state.status,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      bytesScanned: state.bytesScanned,
      bytesTotal: state.bytesTotal,
      candidates: [...state.candidates],
      warnings: [...state.warnings],
    }
  }
}

/** Offsets appear in warnings a user may quote back to support. */
function formatOffset(bytes: number): string {
  return `offset ${bytes.toLocaleString('en-US')}`
}

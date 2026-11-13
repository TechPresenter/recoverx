import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import type { StorageDevice } from '@shared/types/disk'
import { AppError, ErrorCode } from '@shared/utils/errors'

/**
 * Destination validation.
 *
 * **The rule this module exists to enforce: recovered data is never written to
 * the device it was recovered from.**
 *
 * The reason is not tidiness. A deleted file survives because its clusters are
 * marked free but still hold the original bytes. Writing a recovered file back
 * onto the same device asks the filesystem for free clusters — and the clusters
 * it hands out are exactly the ones still holding the *other* files waiting to
 * be recovered. Restoring one file destroys the rest, and the destruction is
 * silent and irreversible.
 *
 * Every failure here refuses the operation. There is no override, because a
 * user in the middle of losing data is in no position to evaluate the risk.
 */

export type DestinationProblem =
  | 'same-device'
  | 'does-not-exist'
  | 'not-a-directory'
  | 'not-writable'
  | 'insufficient-space'
  | 'unresolvable-volume'
  | 'not-absolute'

export interface DestinationCheck {
  readonly path: string
  readonly isUsable: boolean
  readonly problem: DestinationProblem | null
  readonly freeBytes: number
  readonly totalBytes: number
  /** Device the destination resolves to, when it could be determined. */
  readonly deviceId: string | null
}

/**
 * Work out which device a path lives on.
 *
 * Windows exposes each partition as a drive letter, and several letters can
 * belong to one physical disk — which is precisely the case this must catch. A
 * user recovering from `C:` onto `D:` is safe only if `D:` is a different
 * *device*, not merely a different letter.
 *
 * Returns `null` when the path is not on a local lettered volume. A UNC share
 * cannot be the local source device, so the caller treats that as safe; an
 * unmappable drive letter is treated as unsafe.
 */
export function resolveDeviceForPath(
  path: string,
  devices: readonly StorageDevice[],
): { deviceId: string | null; isLocalVolume: boolean } {
  // A UNC path (\\server\share) is on another machine by definition.
  if (path.startsWith('\\\\')) return { deviceId: null, isLocalVolume: false }

  const root = parse(path).root
  const letter = /^([A-Za-z]):/u.exec(root)?.[1]

  if (letter === undefined) return { deviceId: null, isLocalVolume: false }

  const upper = letter.toUpperCase()

  for (const device of devices) {
    for (const partition of device.partitions) {
      if (partition.driveLetter?.toUpperCase() === upper) {
        return { deviceId: device.id, isLocalVolume: true }
      }
    }
  }

  // A lettered volume we could not attribute to a device. Reported as local so
  // the caller refuses: an unknown local volume might be the source.
  return { deviceId: null, isLocalVolume: true }
}

export interface ValidateDestinationOptions {
  readonly destination: string
  readonly sourceDeviceId: string
  readonly devices: readonly StorageDevice[]
  /** Total bytes about to be written, for the space check. */
  readonly requiredBytes: number
}

/**
 * Check a destination before any recovery begins.
 *
 * Ordered so the most consequential failure is reported first: a user who picks
 * the source drive should be told *that*, not that they are short on space.
 */
export async function validateDestination(
  options: ValidateDestinationOptions,
): Promise<DestinationCheck> {
  const { destination, sourceDeviceId, devices, requiredBytes } = options

  const reject = (problem: DestinationProblem): DestinationCheck => ({
    path: destination,
    isUsable: false,
    problem,
    freeBytes: 0,
    totalBytes: 0,
    deviceId: null,
  })

  if (!isAbsolute(destination)) return reject('not-absolute')

  // --- The critical check, before anything touches the filesystem ---------
  const resolved = resolveDeviceForPath(destination, devices)

  if (resolved.deviceId === sourceDeviceId) return reject('same-device')
  if (resolved.deviceId === null && resolved.isLocalVolume) return reject('unresolvable-volume')

  // --- Existence and type -------------------------------------------------
  let stats
  try {
    stats = await stat(destination)
  } catch {
    return reject('does-not-exist')
  }

  if (!stats.isDirectory()) return reject('not-a-directory')

  // --- Writability --------------------------------------------------------
  // `access(W_OK)` is unreliable on Windows: it reports the read-only attribute
  // rather than the effective ACL. Creating and deleting a probe file is the
  // only answer that reflects what will actually happen.
  if (!(await canActuallyWrite(destination))) return reject('not-writable')

  // --- Capacity -----------------------------------------------------------
  const space = await measureFreeSpace(destination)

  if (space.freeBytes > 0 && space.freeBytes < requiredBytes) {
    return {
      path: destination,
      isUsable: false,
      problem: 'insufficient-space',
      freeBytes: space.freeBytes,
      totalBytes: space.totalBytes,
      deviceId: resolved.deviceId,
    }
  }

  return {
    path: destination,
    isUsable: true,
    problem: null,
    freeBytes: space.freeBytes,
    totalBytes: space.totalBytes,
    deviceId: resolved.deviceId,
  }
}

/**
 * Throw unless the destination is usable.
 * Used at the moment a job starts, as a last line of defence.
 */
export function assertUsableDestination(check: DestinationCheck): void {
  if (check.isUsable) return

  throw new AppError(
    check.problem === 'same-device' ? ErrorCode.SecurityViolation : ErrorCode.Validation,
    describeProblem(check.problem),
    { details: check.path, retryable: false },
  )
}

/** Operator-facing explanation for each refusal. */
export function describeProblem(problem: DestinationProblem | null): string {
  switch (problem) {
    case 'same-device':
      return 'The destination is on the same device you are recovering from. Writing there would overwrite the files still waiting to be recovered.'
    case 'does-not-exist':
      return 'The destination folder does not exist.'
    case 'not-a-directory':
      return 'The destination is a file, not a folder.'
    case 'not-writable':
      return 'The destination folder cannot be written to.'
    case 'insufficient-space':
      return 'There is not enough free space at the destination.'
    case 'unresolvable-volume':
      return 'RecoverX could not determine which device the destination is on, so it cannot confirm the destination is safe.'
    case 'not-absolute':
      return 'The destination must be a full path.'
    case null:
      return 'The destination is usable.'
  }
}

// --- internals -------------------------------------------------------------

/** Create and remove a probe file to establish real write access. */
async function canActuallyWrite(directory: string): Promise<boolean> {
  const probe = join(directory, `.recoverx-write-test-${process.pid}`)

  try {
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

async function measureFreeSpace(path: string): Promise<{ freeBytes: number; totalBytes: number }> {
  try {
    const info = await statfs(path)

    return {
      // `bavail` is space available to an unprivileged process, which is the
      // figure that matters; `bfree` includes reserved blocks.
      freeBytes: Number(info.bavail) * Number(info.bsize),
      totalBytes: Number(info.blocks) * Number(info.bsize),
    }
  } catch {
    // Unknown rather than zero: reporting zero would fail the space check on a
    // destination that is actually fine.
    return { freeBytes: 0, totalBytes: 0 }
  }
}

/**
 * Create the destination folder tree for a recovery run.
 *
 * Separate from validation so the check can run against a folder that already
 * exists, without side effects, while the UI is still showing a preview.
 */
export async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    throw new AppError(ErrorCode.Io, 'The destination folder could not be created', {
      details: path,
      cause: error,
      retryable: false,
    })
  }
}

/** `true` when a path already exists. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import type { PathValidation } from '@shared/types/system'

/**
 * Filesystem safety checks for recovery destinations.
 *
 * The cardinal rule of data recovery: never write to the device you are reading
 * from. Recovered files are reconstructed from sectors that the filesystem has
 * marked free, so writing output back to the source can overwrite the very data
 * that has not been recovered yet — turning a partial recovery into a permanent
 * loss. These helpers are the primitives the recovery pipeline uses to enforce
 * that, and they are already applied to the destination folder in Settings.
 */

/**
 * Inspect a path for use as a recovery destination.
 *
 * Never throws: an unreadable or non-existent path is a normal state that the
 * UI renders as a validation message.
 */
export async function inspectPath(target: string): Promise<PathValidation> {
  const path = resolve(target)

  const result = {
    path,
    exists: false,
    isDirectory: false,
    isWritable: false,
    freeBytes: 0,
    totalBytes: 0,
  }

  try {
    const stats = await stat(path)
    result.exists = true
    result.isDirectory = stats.isDirectory()
  } catch {
    return result
  }

  if (!result.isDirectory) return result

  result.isWritable = await probeWritable(path)

  const space = await measureFreeSpace(path)
  result.freeBytes = space.freeBytes
  result.totalBytes = space.totalBytes

  return result
}

/**
 * Determine whether a directory can actually be written to.
 *
 * `fs.access(W_OK)` is unreliable on Windows — it reports only the read-only
 * attribute and ignores ACLs, so a directory the user cannot write to still
 * passes. The only trustworthy answer is to create a file and delete it.
 */
export async function probeWritable(directory: string): Promise<boolean> {
  const probePath = join(directory, `.recoverx-write-probe-${randomBytes(6).toString('hex')}`)

  try {
    await writeFile(probePath, '', { flag: 'wx' })
    return true
  } catch {
    return false
  } finally {
    await rm(probePath, { force: true }).catch(() => undefined)
  }
}

/** Free and total bytes on the volume containing `path`. Zeroes if unavailable. */
export async function measureFreeSpace(
  path: string,
): Promise<{ freeBytes: number; totalBytes: number }> {
  try {
    const stats = await statfs(path)
    const blockSize = Number(stats.bsize)

    return {
      // `bavail` is the space available to an unprivileged process, which is the
      // number that matters for "will this recovery fit".
      freeBytes: Number(stats.bavail) * blockSize,
      totalBytes: Number(stats.blocks) * blockSize,
    }
  } catch {
    return { freeBytes: 0, totalBytes: 0 }
  }
}

/**
 * Identify the volume a path belongs to.
 *
 * On Windows this is the drive designator (`C:`). Comparing volumes is how the
 * recovery pipeline rejects a destination that sits on the source device.
 */
export function volumeOf(path: string): string {
  const { root } = parse(resolve(path))
  return root.replace(/[\\/]+$/, '').toUpperCase()
}

/**
 * `true` when two paths live on different volumes.
 * The precondition for any recovery job writing output.
 */
export function isOnDifferentVolume(source: string, destination: string): boolean {
  return volumeOf(source) !== volumeOf(destination)
}

/** Create a directory (and parents) if it does not already exist. */
export async function ensureDirectory(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** `true` when the path exists and is readable. */
export async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

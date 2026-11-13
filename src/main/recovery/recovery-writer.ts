import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RecoveredFile } from '@shared/types/scan'
import { describeUnknown } from '@shared/utils/errors'
import type { BlockReader } from '../disk/block-device'
import { verifyContent } from '../preview/signatures'

/**
 * Writing a recovered file to disk.
 *
 * Streamed in chunks rather than assembled in memory: a recovery run can
 * include multi-gigabyte video, and buffering even one of those would put the
 * main process into swap. The source is read through the same read-only
 * `BlockReader` the scanner used, so this module cannot modify the device it is
 * recovering from even by accident.
 *
 * A short read does not fail the file. A partially recovered video often still
 * plays, and a partially recovered document often still opens — the outcome is
 * recorded as `partial` so the user knows, and the bytes that *were* readable
 * are kept.
 */

/** Bytes moved per read/write cycle. */
const CHUNK_BYTES = 1024 * 1024

/** Bytes retained from the start of the file for the signature check. */
const VERIFY_BYTES = 4096

export type RecoveryStatus = 'recovered' | 'partial' | 'skipped' | 'failed'

export interface RecoveryOutcome {
  readonly fileId: string
  readonly name: string
  readonly targetPath: string
  readonly bytesWritten: number
  readonly expectedBytes: number
  readonly status: RecoveryStatus
  /** Signature check on the bytes actually written. */
  readonly verification: ReturnType<typeof verifyContent>['verdict']
  readonly detectedLabel: string | null
  readonly error: string | null
}

export interface RecoveryControl {
  /** Polled between chunks; set by the manager to stop a run. */
  cancelled: boolean
  /** Awaited between chunks while a run is paused. */
  waitWhilePaused: () => Promise<void>
}

/**
 * Recover one file.
 *
 * Never throws for a per-file problem: a run over ten thousand files must not
 * stop because one of them sits on a bad sector. Failures are returned as an
 * outcome so the caller can record them and continue.
 */
export async function recoverFile(
  reader: BlockReader,
  file: RecoveredFile,
  targetPath: string,
  control: RecoveryControl,
  onBytes: (delta: number) => void,
): Promise<RecoveryOutcome> {
  const base = {
    fileId: file.id,
    name: file.name,
    targetPath,
    expectedBytes: file.sizeBytes,
    detectedLabel: null,
  }

  // A directory carries no data of its own; creating it is the whole job.
  if (file.isDirectory) {
    try {
      await mkdir(targetPath, { recursive: true })
      return {
        ...base,
        bytesWritten: 0,
        status: 'recovered',
        verification: 'unknown',
        error: null,
      }
    } catch (error) {
      return {
        ...base,
        bytesWritten: 0,
        status: 'failed',
        verification: 'empty',
        error: describeUnknown(error),
      }
    }
  }

  if (file.extents.length === 0) {
    // The metadata survived but the pointer to the contents did not. Writing a
    // zero-byte file would look like a success and mislead the user.
    return {
      ...base,
      bytesWritten: 0,
      status: 'skipped',
      verification: 'empty',
      error: 'The location of this file’s contents was not recoverable',
    }
  }

  try {
    await mkdir(dirname(targetPath), { recursive: true })
  } catch (error) {
    return {
      ...base,
      bytesWritten: 0,
      status: 'failed',
      verification: 'empty',
      error: describeUnknown(error),
    }
  }

  let handle
  try {
    // 'wx' fails if the path already exists, which turns a name-collision bug
    // into an error rather than into silently overwriting a recovered file.
    handle = await open(targetPath, 'wx')
  } catch (error) {
    return {
      ...base,
      bytesWritten: 0,
      status: 'failed',
      verification: 'empty',
      error: describeUnknown(error),
    }
  }

  let written = 0
  let head: Buffer | null = null
  let readError: string | null = null

  try {
    let remaining = file.sizeBytes

    for (const extent of file.extents) {
      if (remaining <= 0 || control.cancelled) break

      let offset = extent.offsetBytes
      let extentRemaining = Math.min(extent.lengthBytes, remaining)

      while (extentRemaining > 0) {
        if (control.cancelled) break
        await control.waitWhilePaused()
        if (control.cancelled) break

        const length = Math.min(CHUNK_BYTES, extentRemaining)

        let chunk: Buffer
        try {
          chunk = await reader.read(offset, length)
        } catch (error) {
          // A bad sector ends this file, keeping what was readable.
          readError = describeUnknown(error)
          extentRemaining = 0
          remaining = 0
          break
        }

        if (chunk.length === 0) {
          extentRemaining = 0
          remaining = 0
          break
        }

        await handle.write(chunk)

        // Retained once, from the first chunk, for the signature check below.
        head ??= Buffer.from(chunk.subarray(0, VERIFY_BYTES))

        written += chunk.length
        offset += chunk.length
        extentRemaining -= chunk.length
        remaining -= chunk.length

        onBytes(chunk.length)
      }
    }
  } catch (error) {
    readError = describeUnknown(error)
  } finally {
    await handle.close()
  }

  // A cancelled file is incomplete and misleading on disk; remove it so the
  // destination only ever holds files the user can trust.
  if (control.cancelled) {
    await rm(targetPath, { force: true })

    return {
      ...base,
      bytesWritten: 0,
      status: 'skipped',
      verification: 'empty',
      error: 'Cancelled',
    }
  }

  const verification =
    head === null
      ? { verdict: 'empty' as const, detectedLabel: null }
      : verifyContent(head, file.extension)

  const status: RecoveryStatus =
    written === 0 ? 'failed' : written < file.sizeBytes ? 'partial' : 'recovered'

  return {
    fileId: file.id,
    name: file.name,
    targetPath,
    bytesWritten: written,
    expectedBytes: file.sizeBytes,
    status,
    verification: verification.verdict,
    detectedLabel: verification.detectedLabel,
    error: readError,
  }
}

/**
 * Confirm a recovered file is on disk at the size that was written.
 *
 * Cheap, and it catches the class of failure where a write appears to succeed
 * but the filesystem discarded it — a full destination, a disconnected USB
 * drive, an antivirus scanner removing the file behind us.
 */
export async function confirmWritten(targetPath: string, expectedBytes: number): Promise<boolean> {
  try {
    const stats = await stat(targetPath)
    return stats.isFile() && stats.size === expectedBytes
  } catch {
    return false
  }
}

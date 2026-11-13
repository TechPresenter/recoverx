import { closeSync, openSync, readSync } from 'node:fs'
import { DEFAULT_SECTOR_SIZE } from '@shared/types/disk'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'

/**
 * Read-only block access.
 *
 * **The single most important invariant in this application: nothing here ever
 * writes.** Every handle is opened `'r'`, and no method in this module or any
 * of its callers can produce a write. Recovered files are reconstructed from
 * sectors the filesystem has marked free; writing to the source device would
 * overwrite the very data that has not been recovered yet.
 *
 * Callers work in absolute byte offsets and arbitrary lengths. Sector alignment
 * — which Windows enforces on raw device handles — is handled here so no caller
 * has to think about it.
 */
export interface BlockReader {
  /** Total addressable size, in bytes. */
  readonly sizeBytes: number
  /** Logical sector size. Reads against the device must be a multiple of this. */
  readonly sectorSize: number
  /**
   * Read `length` bytes starting at `offset`.
   *
   * Returns a buffer of exactly `length` bytes unless the range runs past the
   * end of the device, in which case it is truncated. Never throws for a short
   * read; throws only on an I/O failure.
   */
  read(offset: number, length: number): Promise<Buffer>
  /** Release the underlying handle. Safe to call more than once. */
  close(): void
}

/**
 * Raw device reader backed by a Windows device path
 * (`\\.\PhysicalDrive0`, `\\.\C:`).
 *
 * Requires an elevated process. Without it, `open` fails with `EPERM` — which
 * is surfaced as a `PermissionDenied` error so the UI can tell the user to
 * relaunch as Administrator rather than reporting a mysterious failure.
 */
export class RawBlockDevice implements BlockReader {
  readonly sizeBytes: number
  readonly sectorSize: number

  private readonly path: string
  private fd: number | null

  private constructor(path: string, fd: number, sizeBytes: number, sectorSize: number) {
    this.path = path
    this.fd = fd
    this.sizeBytes = sizeBytes
    this.sectorSize = sectorSize
  }

  /**
   * Open a device for reading.
   *
   * @param sizeBytes  Device size, from the OS enumeration — a raw handle
   *                   cannot be `stat`ed for a length on Windows.
   */
  static open(path: string, sizeBytes: number, sectorSize = DEFAULT_SECTOR_SIZE): RawBlockDevice {
    let fd: number

    try {
      // 'r' is not merely a default here: it is the guarantee that this process
      // cannot modify the device it is recovering from.
      fd = openSync(path, 'r')
    } catch (error) {
      throw translateOpenError(path, error)
    }

    return new RawBlockDevice(path, fd, sizeBytes, normaliseSectorSize(sectorSize))
  }

  // The OS read is synchronous by design: scans run in worker threads, where
  // a sync read is faster and simpler than a thread-pool round trip. The
  // interface stays async so a future network-backed reader can implement it.
  // eslint-disable-next-line @typescript-eslint/require-await
  async read(offset: number, length: number): Promise<Buffer> {
    if (this.fd === null) {
      throw new AppError(ErrorCode.Io, 'The device handle is already closed', {
        details: this.path,
        retryable: false,
      })
    }

    if (length <= 0) return Buffer.alloc(0)
    if (offset < 0) {
      throw new AppError(ErrorCode.Io, 'Read offset cannot be negative', { retryable: false })
    }
    if (offset >= this.sizeBytes) return Buffer.alloc(0)

    const available = Math.min(length, this.sizeBytes - offset)

    // Windows rejects a read on a raw device handle unless both the file
    // position and the byte count are multiples of the sector size. Widen the
    // request to sector boundaries, then slice the caller's window back out.
    const alignedStart = Math.floor(offset / this.sectorSize) * this.sectorSize
    const skew = offset - alignedStart
    const alignedLength = ceilToSector(skew + available, this.sectorSize)

    const buffer = Buffer.allocUnsafe(alignedLength)

    let bytesRead: number
    try {
      bytesRead = readSync(this.fd, buffer, 0, alignedLength, alignedStart)
    } catch (error) {
      throw new AppError(ErrorCode.Io, 'Failed to read from the device', {
        details: `${this.path} @ ${alignedStart} +${alignedLength}: ${describeUnknown(error)}`,
        cause: error,
        retryable: true,
      })
    }

    if (bytesRead <= skew) return Buffer.alloc(0)

    return buffer.subarray(skew, Math.min(skew + available, bytesRead))
  }

  close(): void {
    if (this.fd === null) return

    try {
      closeSync(this.fd)
    } catch {
      // A handle that will not close is not something the caller can act on.
    } finally {
      this.fd = null
    }
  }
}

/**
 * In-memory reader over a buffer.
 *
 * Backs the parser test suites: partition tables, boot sectors and MFT records
 * are exercised against synthetic images, which is both reproducible and able
 * to cover damage patterns a healthy disk will never exhibit.
 */
export class BufferBlockReader implements BlockReader {
  readonly sizeBytes: number
  readonly sectorSize: number

  private readonly buffer: Buffer

  constructor(buffer: Buffer, sectorSize = DEFAULT_SECTOR_SIZE) {
    this.buffer = buffer
    this.sizeBytes = buffer.length
    this.sectorSize = normaliseSectorSize(sectorSize)
  }

  read(offset: number, length: number): Promise<Buffer> {
    if (length <= 0 || offset < 0 || offset >= this.sizeBytes) {
      return Promise.resolve(Buffer.alloc(0))
    }

    const end = Math.min(offset + length, this.sizeBytes)
    // Copy rather than subarray: a caller must not be able to mutate the
    // backing image through a returned view.
    return Promise.resolve(Buffer.from(this.buffer.subarray(offset, end)))
  }

  close(): void {
    // Nothing to release.
  }
}

/**
 * Reader restricted to a window of another reader.
 *
 * A partition scanner is written against offsets relative to the partition; this
 * adapter removes the whole class of bug where a device-absolute offset is used
 * by mistake.
 */
export class SlicedBlockReader implements BlockReader {
  readonly sizeBytes: number
  readonly sectorSize: number

  private readonly parent: BlockReader
  private readonly baseOffset: number

  constructor(parent: BlockReader, offsetBytes: number, sizeBytes: number) {
    this.parent = parent
    this.baseOffset = offsetBytes
    this.sizeBytes = Math.max(0, Math.min(sizeBytes, parent.sizeBytes - offsetBytes))
    this.sectorSize = parent.sectorSize
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (length <= 0 || offset < 0 || offset >= this.sizeBytes) return Buffer.alloc(0)

    const clamped = Math.min(length, this.sizeBytes - offset)
    return this.parent.read(this.baseOffset + offset, clamped)
  }

  close(): void {
    // The parent owns the handle; a slice must not close it out from under a
    // sibling slice.
  }
}

/** Round up to the next sector boundary. */
export function ceilToSector(value: number, sectorSize: number): number {
  return Math.ceil(value / sectorSize) * sectorSize
}

/**
 * Reject nonsensical sector sizes.
 *
 * Sector size must be a power of two — the alignment arithmetic assumes it, and
 * a bogus value reported by a USB bridge chip would otherwise produce silently
 * misaligned reads rather than an error.
 */
function normaliseSectorSize(sectorSize: number): number {
  const isPowerOfTwo = sectorSize > 0 && (sectorSize & (sectorSize - 1)) === 0

  if (!Number.isInteger(sectorSize) || !isPowerOfTwo || sectorSize < 512 || sectorSize > 65_536) {
    return DEFAULT_SECTOR_SIZE
  }

  return sectorSize
}

function translateOpenError(path: string, error: unknown): AppError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code

  if (code === 'EPERM' || code === 'EACCES') {
    return new AppError(
      ErrorCode.PermissionDenied,
      'RecoverX needs Administrator rights to read this device',
      {
        details: `${path}: ${code}`,
        cause: error,
        retryable: false,
      },
    )
  }

  if (code === 'ENOENT') {
    return new AppError(ErrorCode.NotFound, 'The device is no longer present', {
      details: path,
      cause: error,
      retryable: false,
    })
  }

  if (code === 'EBUSY') {
    return new AppError(ErrorCode.Conflict, 'The device is locked by another program', {
      details: path,
      cause: error,
      retryable: true,
    })
  }

  return new AppError(ErrorCode.Io, 'The device could not be opened', {
    details: `${path}: ${describeUnknown(error)}`,
    cause: error,
    retryable: true,
  })
}

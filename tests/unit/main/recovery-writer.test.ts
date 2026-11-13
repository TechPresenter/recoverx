import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BufferBlockReader, type BlockReader } from '@main/disk/block-device'
import { confirmWritten, recoverFile, type RecoveryControl } from '@main/recovery/recovery-writer'
import type { RecoveredFile } from '@shared/types/scan'

const RUNNING: RecoveryControl = {
  cancelled: false,
  waitWhilePaused: () => Promise.resolve(),
}

function file(overrides: Partial<RecoveredFile> = {}): RecoveredFile {
  return {
    id: 'f1',
    sessionId: 's1',
    name: 'photo.jpg',
    path: '',
    extension: 'jpg',
    category: 'image',
    sizeBytes: 12,
    isDeleted: true,
    isDirectory: false,
    createdAt: null,
    modifiedAt: null,
    accessedAt: null,
    quality: 'excellent',
    source: 'ntfs-mft',
    extents: [{ offsetBytes: 0, lengthBytes: 12 }],
    hasResidentData: false,
    isFragmented: false,
    isCompressed: false,
    isEncrypted: false,
    ...overrides,
  }
}

/** A device holding a valid 12-byte JPEG at offset 0. */
function jpegDevice(): BlockReader {
  const image = Buffer.alloc(64)
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0xff, 0xd9]).copy(image)
  return new BufferBlockReader(image)
}

describe('recoverFile', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-write-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('writes the file and reports it verified', async () => {
    const target = join(directory, 'photo.jpg')
    const outcome = await recoverFile(jpegDevice(), file(), target, RUNNING, () => undefined)

    expect(outcome.status).toBe('recovered')
    expect(outcome.bytesWritten).toBe(12)
    expect(outcome.verification).toBe('match')
    expect(outcome.detectedLabel).toBe('JPEG image')
    expect(readFileSync(target)).toHaveLength(12)
  })

  it('reassembles a fragmented file in logical order', async () => {
    const image = Buffer.from('CCCCAAAABBBB', 'latin1')
    const target = join(directory, 'frag.bin')

    const outcome = await recoverFile(
      new BufferBlockReader(image),
      file({
        name: 'frag.bin',
        extension: 'bin',
        sizeBytes: 12,
        extents: [
          { offsetBytes: 4, lengthBytes: 4 },
          { offsetBytes: 8, lengthBytes: 4 },
          { offsetBytes: 0, lengthBytes: 4 },
        ],
      }),
      target,
      RUNNING,
      () => undefined,
    )

    expect(outcome.status).toBe('recovered')
    expect(readFileSync(target).toString()).toBe('AAAABBBBCCCC')
  })

  it('creates the parent folders it needs', async () => {
    const target = join(directory, 'Pictures', '2025', 'photo.jpg')
    const outcome = await recoverFile(jpegDevice(), file(), target, RUNNING, () => undefined)

    expect(outcome.status).toBe('recovered')
    expect(readFileSync(target)).toHaveLength(12)
  })

  it('reports progress as bytes are written', async () => {
    let total = 0
    await recoverFile(jpegDevice(), file(), join(directory, 'p.jpg'), RUNNING, (delta) => {
      total += delta
    })

    expect(total).toBe(12)
  })

  it('flags a mismatch when the recovered bytes are not what the name claims', async () => {
    // A deleted record whose clusters now hold something else. The file is
    // written, because the user may still want it — but it is not verified.
    const outcome = await recoverFile(
      new BufferBlockReader(Buffer.alloc(64)),
      file(),
      join(directory, 'photo.jpg'),
      RUNNING,
      () => undefined,
    )

    expect(outcome.status).toBe('recovered')
    expect(outcome.verification).toBe('mismatch')
  })

  it('keeps what was readable when the device ends early, and says so', async () => {
    // A partially recovered video often still plays.
    const outcome = await recoverFile(
      new BufferBlockReader(Buffer.alloc(8)),
      file({ sizeBytes: 100, extents: [{ offsetBytes: 0, lengthBytes: 100 }] }),
      join(directory, 'short.jpg'),
      RUNNING,
      () => undefined,
    )

    expect(outcome.status).toBe('partial')
    expect(outcome.bytesWritten).toBe(8)
    expect(outcome.expectedBytes).toBe(100)
  })

  it('skips a file whose contents could not be located', async () => {
    // Writing a zero-byte file would look like success and mislead the user.
    const target = join(directory, 'lost.jpg')
    const outcome = await recoverFile(
      jpegDevice(),
      file({ extents: [], sizeBytes: 5000 }),
      target,
      RUNNING,
      () => undefined,
    )

    expect(outcome.status).toBe('skipped')
    expect(outcome.bytesWritten).toBe(0)
    expect(() => readFileSync(target)).toThrow()
  })

  it('creates a directory entry without writing data', async () => {
    const target = join(directory, 'Photos')
    const outcome = await recoverFile(
      jpegDevice(),
      file({ name: 'Photos', isDirectory: true, extension: '', sizeBytes: 0, extents: [] }),
      target,
      RUNNING,
      () => undefined,
    )

    expect(outcome.status).toBe('recovered')
    expect(outcome.bytesWritten).toBe(0)
  })

  it('removes a cancelled file rather than leaving a truncated one', async () => {
    // The destination must only ever hold files the user can trust.
    const target = join(directory, 'cancelled.jpg')
    const control: RecoveryControl = { cancelled: true, waitWhilePaused: () => Promise.resolve() }

    const outcome = await recoverFile(jpegDevice(), file(), target, control, () => undefined)

    expect(outcome.status).toBe('skipped')
    expect(() => readFileSync(target)).toThrow()
  })

  it('refuses to overwrite an existing file', async () => {
    // A name-collision bug must surface as an error, never as a silently
    // destroyed earlier recovery.
    const target = join(directory, 'photo.jpg')
    writeFileSync(target, 'existing content')

    const outcome = await recoverFile(jpegDevice(), file(), target, RUNNING, () => undefined)

    expect(outcome.status).toBe('failed')
    expect(readFileSync(target).toString()).toBe('existing content')
  })

  it('does not throw when the OS rejects the target path', async () => {
    // One bad file must not stop a ten-thousand-file run. '?' is illegal in
    // a Windows file name, so the open fails before any byte is written.
    const outcome = await recoverFile(
      jpegDevice(),
      file(),
      join(directory, 'bad?.jpg'),
      RUNNING,
      () => undefined,
    )

    expect(outcome.status).toBe('failed')
    expect(outcome.error).not.toBeNull()
  })

  it('accepts a name containing spaces, which is perfectly legal', async () => {
    const target = join(directory, 'my holiday photo.jpg')
    const outcome = await recoverFile(jpegDevice(), file(), target, RUNNING, () => undefined)

    expect(outcome.status).toBe('recovered')
    expect(readFileSync(target)).toHaveLength(12)
  })

  it('stops at the recorded size even when the extent is larger', async () => {
    // The last cluster is almost never full; copying the slack would append
    // garbage to every recovered file.
    const target = join(directory, 'exact.bin')

    await recoverFile(
      new BufferBlockReader(Buffer.alloc(4096, 0x41)),
      file({
        name: 'exact.bin',
        extension: 'bin',
        sizeBytes: 10,
        extents: [{ offsetBytes: 0, lengthBytes: 4096 }],
      }),
      target,
      RUNNING,
      () => undefined,
    )

    expect(readFileSync(target)).toHaveLength(10)
  })
})

describe('confirmWritten', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-confirm-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('confirms a file written at the expected size', async () => {
    const target = join(directory, 'a.bin')
    writeFileSync(target, Buffer.alloc(64))

    expect(await confirmWritten(target, 64)).toBe(true)
  })

  it('rejects a size mismatch or a missing file', async () => {
    const target = join(directory, 'b.bin')
    writeFileSync(target, Buffer.alloc(10))

    expect(await confirmWritten(target, 64)).toBe(false)
    expect(await confirmWritten(join(directory, 'nope.bin'), 10)).toBe(false)
  })

  it('rejects a directory', async () => {
    expect(await confirmWritten(directory, 0)).toBe(false)
  })
})

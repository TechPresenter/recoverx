import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RawBlockDevice } from '@main/disk/block-device'
import { carveVolume } from '@main/scan/carve/carve-scanner'
import type { RecoveredFile } from '@shared/types/scan'

/**
 * End-to-end deep scan against a real image file.
 *
 * `RawBlockDevice` addresses any path, not only `\\.\PhysicalDriveN`, so a file
 * on disk exercises the same read path a physical device would — sector
 * alignment, handle lifetime, short reads at the end. That makes this a genuine
 * integration test of the carving pipeline rather than a buffer exercise, and it
 * needs no elevation to run.
 */

const SECTOR = 512

function jpeg(payload: number, fill = 0x41): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(payload, fill),
    Buffer.from([0xff, 0xd9]),
  ])
}

function png(payload: number): Buffer {
  const head = Buffer.alloc(16)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')

  return Buffer.concat([
    head,
    Buffer.alloc(payload, 0x42),
    Buffer.from([...Buffer.from('IEND', 'latin1'), 0xae, 0x42, 0x60, 0x82]),
  ])
}

function bmp(size: number): Buffer {
  const buffer = Buffer.alloc(size, 0x43)
  buffer.write('BM', 0, 'latin1')
  buffer.writeUInt32LE(size, 2)
  buffer.writeUInt32LE(40, 14)
  return buffer
}

describe('carveVolume against a real image file', () => {
  let directory: string
  let imagePath: string

  /** Write a device image and return the offsets the files were placed at. */
  function buildImage(
    files: ReadonlyArray<{ at: number; bytes: Buffer }>,
    totalBytes: number,
  ): void {
    const image = Buffer.alloc(totalBytes, 0x00)
    for (const file of files) file.bytes.copy(image, file.at)
    writeFileSync(imagePath, image)
  }

  async function carve(totalBytes: number): Promise<RecoveredFile[]> {
    const device = RawBlockDevice.open(imagePath, totalBytes, SECTOR)

    try {
      const found: RecoveredFile[] = []
      for await (const batch of carveVolume(device, 'session-1', 0, { includeExisting: true })) {
        found.push(...batch.files)
      }
      return found
    } finally {
      device.close()
    }
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-carve-'))
    imagePath = join(directory, 'device.img')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('finds several file types scattered through a formatted-looking image', async () => {
    const total = 1024 * 1024

    buildImage(
      [
        { at: 4096, bytes: jpeg(8192) },
        { at: 65_536, bytes: png(4096) },
        { at: 262_144, bytes: bmp(16_384) },
      ],
      total,
    )

    const found = await carve(total)
    const byOffset = new Map(found.map((file) => [file.extents[0]?.offsetBytes, file]))

    expect(byOffset.get(4096)?.extension).toBe('jpg')
    expect(byOffset.get(65_536)?.extension).toBe('png')
    expect(byOffset.get(262_144)?.extension).toBe('bmp')
  })

  it('recovers exact sizes where the format allows it', async () => {
    const total = 512 * 1024

    buildImage(
      [
        { at: 8192, bytes: jpeg(4096) },
        { at: 131_072, bytes: bmp(2048) },
      ],
      total,
    )

    const found = await carve(total)

    const carvedJpeg = found.find((file) => file.extension === 'jpg')
    // Header (4) + payload + terminator (2), located by its footer.
    expect(carvedJpeg?.sizeBytes).toBe(4 + 4096 + 2)
    expect(carvedJpeg?.quality).toBe('good')

    const carvedBmp = found.find((file) => file.extension === 'bmp')
    // BMP declares its own length, so the size is exact.
    expect(carvedBmp?.sizeBytes).toBe(2048)
  })

  it('finds a file that straddles a read-chunk boundary', async () => {
    // The chunk size is 8 MiB, so a header placed a few bytes before it would be
    // invisible to both chunks without the overlap.
    const chunk = 8 * 1024 * 1024
    const total = chunk + 512 * 1024

    buildImage([{ at: chunk - 6, bytes: jpeg(2048) }], total)

    const found = await carve(total)

    expect(found).toHaveLength(1)
    expect(found[0]?.extents[0]?.offsetBytes).toBe(chunk - 6)
  })

  it('reports nothing for an image with no recognisable content', async () => {
    const total = 512 * 1024
    buildImage([], total)

    expect(await carve(total)).toEqual([])
  })

  it('marks every carved file deleted, unnamed and undated', async () => {
    // None of that information lives in a file's own bytes, so a deep scan
    // cannot know it — and must not imply otherwise.
    const total = 256 * 1024
    buildImage([{ at: 4096, bytes: jpeg(2048) }], total)

    const [file] = await carve(total)

    expect(file?.isDeleted).toBe(true)
    expect(file?.createdAt).toBeNull()
    expect(file?.modifiedAt).toBeNull()
    expect(file?.source).toBe('carved')
    // The synthesised name encodes where it was found.
    expect(file?.name).toMatch(/^jpeg-[0-9a-f]{12}\.jpg$/u)
  })

  it('never grades a carved file excellent', async () => {
    // That grade means metadata survived and clusters were untouched. A carved
    // file has no metadata, so claiming it would overstate the evidence.
    const total = 512 * 1024
    buildImage(
      [
        { at: 4096, bytes: jpeg(2048) },
        { at: 131_072, bytes: bmp(4096) },
      ],
      total,
    )

    const found = await carve(total)

    expect(found.length).toBeGreaterThan(0)
    expect(found.every((file) => file.quality !== 'excellent')).toBe(true)
  })

  it('produces stable ids so a rescan updates rather than duplicates', async () => {
    const total = 256 * 1024
    buildImage([{ at: 4096, bytes: jpeg(2048) }], total)

    const first = await carve(total)
    const second = await carve(total)

    expect(first[0]?.id).toBe(second[0]?.id)
  })

  it('reports progress that reaches the device size', async () => {
    const total = 512 * 1024
    buildImage([{ at: 4096, bytes: jpeg(2048) }], total)

    const device = RawBlockDevice.open(imagePath, total, SECTOR)

    try {
      let last = { processed: 0, total: 0 }
      for await (const batch of carveVolume(device, 's', 0, { includeExisting: true })) {
        last = { processed: batch.processed, total: batch.total }
      }

      expect(last.total).toBe(total)
      expect(last.processed).toBe(total)
    } finally {
      device.close()
    }
  })

  it('offsets extents by the volume start, so they are device-absolute', async () => {
    const total = 256 * 1024
    const volumeOffset = 1024 * 1024 * 100

    buildImage([{ at: 4096, bytes: jpeg(2048) }], total)

    const device = RawBlockDevice.open(imagePath, total, SECTOR)

    try {
      const found: RecoveredFile[] = []
      for await (const batch of carveVolume(device, 's', volumeOffset, {
        includeExisting: true,
      })) {
        found.push(...batch.files)
      }

      expect(found[0]?.extents[0]?.offsetBytes).toBe(volumeOffset + 4096)
    } finally {
      device.close()
    }
  })

  it('stops early when a unit limit is given', async () => {
    const total = 512 * 1024
    // The only file sits beyond the limit, so it must not be reported.
    buildImage([{ at: 300_000, bytes: jpeg(2048) }], total)

    const device = RawBlockDevice.open(imagePath, total, SECTOR)

    try {
      const found: RecoveredFile[] = []
      for await (const batch of carveVolume(device, 's', 0, {
        includeExisting: true,
        maxUnits: 8192,
      })) {
        found.push(...batch.files)
      }

      expect(found).toEqual([])
    } finally {
      device.close()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { BufferBlockReader } from '@main/disk/block-device'
import { scanExfatVolume } from '@main/scan/fat/exfat-scanner'
import { scanFatVolume } from '@main/scan/fat/fat-scanner'
import { clustersToExtents, truncateExtents, type ScanBatch } from '@main/scan/scan-types'
import type { RecoveredFile } from '@shared/types/scan'

const SECTOR = 512

// --- FAT16 volume builder --------------------------------------------------

const FAT16_CLUSTER_SECTORS = 4
const FAT16_CLUSTER = FAT16_CLUSTER_SECTORS * SECTOR // 2048
const FAT16_RESERVED = 1
const FAT16_FAT_SECTORS = 64
const FAT16_FATS = 2
const FAT16_ROOT_ENTRIES = 512
const FAT16_ROOT_SECTORS = (FAT16_ROOT_ENTRIES * 32) / SECTOR // 32
const FAT16_FIRST_ROOT_SECTOR = FAT16_RESERVED + FAT16_FATS * FAT16_FAT_SECTORS
const FAT16_FIRST_DATA_SECTOR = FAT16_FIRST_ROOT_SECTOR + FAT16_ROOT_SECTORS
const FAT16_TOTAL_SECTORS = 100_000

interface FatFileSpec {
  readonly name: string
  readonly extension?: string
  readonly firstCluster?: number
  readonly sizeBytes?: number
  readonly deleted?: boolean
  readonly isDirectory?: boolean
}

interface Fat16Spec {
  readonly root: readonly FatFileSpec[]
  /** Directory contents, keyed by the directory's first cluster. */
  readonly directories?: Readonly<Record<number, readonly FatFileSpec[]>>
  /** FAT links to write, as cluster -> next value. */
  readonly fatLinks?: Readonly<Record<number, number>>
}

function shortEntry(spec: FatFileSpec): Buffer {
  const entry = Buffer.alloc(32)

  entry.write(spec.name.padEnd(8, ' ').slice(0, 8), 0, 'latin1')
  entry.write((spec.extension ?? '').padEnd(3, ' ').slice(0, 3), 8, 'latin1')
  if (spec.deleted === true) entry.writeUInt8(0xe5, 0)

  entry.writeUInt8(spec.isDirectory === true ? 0x10 : 0x20, 0x0b)
  entry.writeUInt16LE(((spec.firstCluster ?? 0) >>> 16) & 0xffff, 0x14)
  entry.writeUInt16LE((spec.firstCluster ?? 0) & 0xffff, 0x1a)
  entry.writeUInt32LE(spec.sizeBytes ?? 0, 0x1c)

  return entry
}

function directoryBuffer(entries: readonly FatFileSpec[], sizeBytes: number): Buffer {
  const buffer = Buffer.alloc(sizeBytes)
  entries.forEach((entry, index) => {
    shortEntry(entry).copy(buffer, index * 32)
  })
  return buffer
}

function buildFat16Volume(spec: Fat16Spec): Buffer {
  const image = Buffer.alloc(FAT16_TOTAL_SECTORS * SECTOR)

  // Boot sector
  image.write('MSDOS5.0', 3, 'latin1')
  image.writeUInt16LE(SECTOR, 0x0b)
  image.writeUInt8(FAT16_CLUSTER_SECTORS, 0x0d)
  image.writeUInt16LE(FAT16_RESERVED, 0x0e)
  image.writeUInt8(FAT16_FATS, 0x10)
  image.writeUInt16LE(FAT16_ROOT_ENTRIES, 0x11)
  image.writeUInt32LE(FAT16_TOTAL_SECTORS, 0x20)
  image.writeUInt16LE(FAT16_FAT_SECTORS, 0x16)
  image.write('DISK       ', 0x2b, 'latin1')
  image.write('FAT16   ', 0x36, 'latin1')
  image.writeUInt8(0x55, 0x1fe)
  image.writeUInt8(0xaa, 0x1ff)

  // FAT
  const fatOffset = FAT16_RESERVED * SECTOR
  for (const [cluster, next] of Object.entries(spec.fatLinks ?? {})) {
    image.writeUInt16LE(next, fatOffset + Number(cluster) * 2)
  }

  // Fixed root directory
  directoryBuffer(spec.root, FAT16_ROOT_SECTORS * SECTOR).copy(
    image,
    FAT16_FIRST_ROOT_SECTOR * SECTOR,
  )

  // Sub-directories, each occupying one cluster
  for (const [cluster, entries] of Object.entries(spec.directories ?? {})) {
    const offset =
      (FAT16_FIRST_DATA_SECTOR + (Number(cluster) - 2) * FAT16_CLUSTER_SECTORS) * SECTOR
    directoryBuffer(entries, FAT16_CLUSTER).copy(image, offset)
  }

  return image
}

// --- exFAT volume builder --------------------------------------------------

const EXFAT_CLUSTER_SECTORS = 8
const EXFAT_FAT_SECTOR = 128
const EXFAT_FAT_SECTORS = 64
const EXFAT_HEAP_SECTOR = 256
const EXFAT_CLUSTER_COUNT = 2000
const EXFAT_ROOT_CLUSTER = 2
const EXFAT_BITMAP_CLUSTER = 3
const EXFAT_TOTAL_SECTORS = EXFAT_HEAP_SECTOR + EXFAT_CLUSTER_COUNT * EXFAT_CLUSTER_SECTORS

interface ExfatFileSpec {
  readonly name: string
  readonly sizeBytes?: number
  readonly firstCluster?: number
  readonly contiguous?: boolean
  readonly deleted?: boolean
  readonly isDirectory?: boolean
}

interface ExfatSpec {
  readonly root: readonly ExfatFileSpec[]
  readonly allocatedClusters?: readonly number[]
  readonly omitBitmap?: boolean
}

function exfatEntrySet(spec: ExfatFileSpec): Buffer {
  const nameEntries = Math.max(1, Math.ceil(spec.name.length / 15))
  const secondaryCount = 1 + nameEntries
  const buffer = Buffer.alloc((secondaryCount + 1) * 32)
  const inUse = spec.deleted === true ? 0x00 : 0x80

  buffer.writeUInt8(0x05 | inUse, 0)
  buffer.writeUInt8(secondaryCount, 1)
  buffer.writeUInt16LE(spec.isDirectory === true ? 0x10 : 0x20, 4)

  buffer.writeUInt8(0x40 | inUse, 32)
  buffer.writeUInt8(0x01 | (spec.contiguous === true ? 0x02 : 0x00), 33)
  buffer.writeUInt8(spec.name.length, 35)
  buffer.writeBigUInt64LE(BigInt(spec.sizeBytes ?? 0), 32 + 8)
  buffer.writeUInt32LE(spec.firstCluster ?? 0, 32 + 0x14)
  buffer.writeBigUInt64LE(BigInt(spec.sizeBytes ?? 0), 32 + 0x18)

  const encoded = Buffer.from(spec.name, 'utf16le')
  for (let index = 0; index < nameEntries; index += 1) {
    const at = 64 + index * 32
    buffer.writeUInt8(0x41 | inUse, at)
    encoded.copy(buffer, at + 2, index * 30, Math.min((index + 1) * 30, encoded.length))
  }

  return buffer
}

function buildExfatVolume(spec: ExfatSpec): Buffer {
  const image = Buffer.alloc(EXFAT_TOTAL_SECTORS * SECTOR)

  image.write('EXFAT   ', 3, 'latin1')
  image.writeBigUInt64LE(0n, 0x40)
  image.writeBigUInt64LE(BigInt(EXFAT_TOTAL_SECTORS), 0x48)
  image.writeUInt32LE(EXFAT_FAT_SECTOR, 0x50)
  image.writeUInt32LE(EXFAT_FAT_SECTORS, 0x54)
  image.writeUInt32LE(EXFAT_HEAP_SECTOR, 0x58)
  image.writeUInt32LE(EXFAT_CLUSTER_COUNT, 0x5c)
  image.writeUInt32LE(EXFAT_ROOT_CLUSTER, 0x60)
  image.writeUInt8(9, 0x6c)
  image.writeUInt8(3, 0x6d)
  image.writeUInt8(1, 0x6e)

  const clusterOffset = (cluster: number): number =>
    (EXFAT_HEAP_SECTOR + (cluster - 2) * EXFAT_CLUSTER_SECTORS) * SECTOR

  // Root directory: the allocation bitmap entry first, then the files.
  const parts: Buffer[] = []

  if (spec.omitBitmap !== true) {
    const bitmapEntry = Buffer.alloc(32)
    bitmapEntry.writeUInt8(0x81, 0)
    bitmapEntry.writeUInt32LE(EXFAT_BITMAP_CLUSTER, 0x14)
    bitmapEntry.writeBigUInt64LE(BigInt(Math.ceil(EXFAT_CLUSTER_COUNT / 8)), 0x18)
    parts.push(bitmapEntry)
  }

  for (const file of spec.root) parts.push(exfatEntrySet(file))

  Buffer.concat(parts).copy(image, clusterOffset(EXFAT_ROOT_CLUSTER))

  // Allocation bitmap: bit 0 corresponds to cluster 2.
  if (spec.omitBitmap !== true) {
    const bitmapOffset = clusterOffset(EXFAT_BITMAP_CLUSTER)
    for (const cluster of spec.allocatedClusters ?? []) {
      const index = cluster - 2
      const byte = bitmapOffset + (index >> 3)
      image.writeUInt8(image.readUInt8(byte) | (1 << (index & 7)), byte)
    }
  }

  return image
}

// --- Helpers ---------------------------------------------------------------

async function drain(generator: AsyncGenerator<ScanBatch>): Promise<RecoveredFile[]> {
  const files: RecoveredFile[] = []
  for await (const batch of generator) files.push(...batch.files)
  return files
}

// --- Extent helpers --------------------------------------------------------

describe('clustersToExtents', () => {
  const offsetOf = (cluster: number): number => cluster * 1000

  it('merges consecutive clusters into one extent', () => {
    // A million-cluster video must not become a million rows.
    const extents = clustersToExtents([5, 6, 7, 8], 1000, offsetOf, 4000, 0)

    expect(extents).toEqual([{ offsetBytes: 5000, lengthBytes: 4000 }])
  })

  it('splits at a discontinuity', () => {
    const extents = clustersToExtents([5, 6, 20, 21], 1000, offsetOf, 4000, 0)

    expect(extents).toEqual([
      { offsetBytes: 5000, lengthBytes: 2000 },
      { offsetBytes: 20_000, lengthBytes: 2000 },
    ])
  })

  it('trims the final cluster to the real file size', () => {
    // The last cluster is almost never full; copying the slack would append
    // garbage to every recovered file.
    const extents = clustersToExtents([5, 6], 1000, offsetOf, 1500, 0)

    expect(extents).toEqual([{ offsetBytes: 5000, lengthBytes: 1500 }])
  })

  it('applies the volume offset so extents are device-absolute', () => {
    const extents = clustersToExtents([5], 1000, offsetOf, 1000, 1_000_000)

    expect(extents[0]?.offsetBytes).toBe(1_005_000)
  })

  it('returns nothing for an empty cluster list or a zero-length file', () => {
    expect(clustersToExtents([], 1000, offsetOf, 1000, 0)).toEqual([])
    expect(clustersToExtents([5], 1000, offsetOf, 0, 0)).toEqual([])
  })
})

describe('truncateExtents', () => {
  it('drops extents past the size limit', () => {
    const extents = truncateExtents(
      [
        { offsetBytes: 0, lengthBytes: 100 },
        { offsetBytes: 500, lengthBytes: 100 },
      ],
      150,
    )

    expect(extents).toEqual([
      { offsetBytes: 0, lengthBytes: 100 },
      { offsetBytes: 500, lengthBytes: 50 },
    ])
  })
})

// --- FAT scanner -----------------------------------------------------------

describe('scanFatVolume', () => {
  const scan = (image: Buffer, includeExisting = true): Promise<RecoveredFile[]> =>
    drain(scanFatVolume(new BufferBlockReader(image, SECTOR), 's', 0, { includeExisting }))

  it('reads the fixed root directory of a FAT16 volume', async () => {
    const files = await scan(
      buildFat16Volume({
        root: [
          { name: 'REPORT', extension: 'PDF', firstCluster: 10, sizeBytes: 5000 },
          { name: 'PHOTO', extension: 'JPG', firstCluster: 20, sizeBytes: 3000 },
        ],
        fatLinks: { 10: 0xffff, 20: 0xffff },
      }),
    )

    expect(files.map((file) => file.name).sort()).toEqual(['PHOTO.JPG', 'REPORT.PDF'])
    expect(files.find((file) => file.name === 'PHOTO.JPG')?.category).toBe('image')
  })

  it('descends into sub-directories and builds paths', async () => {
    const files = await scan(
      buildFat16Volume({
        root: [{ name: 'DCIM', firstCluster: 5, isDirectory: true }],
        directories: {
          5: [
            { name: '.', isDirectory: true, firstCluster: 5 },
            { name: '..', isDirectory: true, firstCluster: 0 },
            { name: 'IMG_0001', extension: 'JPG', firstCluster: 30, sizeBytes: 2000 },
          ],
        },
        fatLinks: { 5: 0xffff, 30: 0xffff },
      }),
    )

    const photo = files.find((file) => file.name === 'IMG_0001.JPG')
    expect(photo?.path).toBe('DCIM')
    // "." and ".." are self and parent links, not files.
    expect(files.some((file) => file.name === '.')).toBe(false)
    expect(files.some((file) => file.name === '..')).toBe(false)
  })

  it('follows a live file chain and reports fragmentation', async () => {
    const files = await scan(
      buildFat16Volume({
        root: [{ name: 'FRAG', extension: 'BIN', firstCluster: 10, sizeBytes: 6000 }],
        fatLinks: { 10: 11, 11: 50, 50: 0xffff },
      }),
    )

    const file = files[0]
    expect(file?.isFragmented).toBe(true)
    // Clusters 10-11 are adjacent, 50 is not: two extents.
    expect(file?.extents).toHaveLength(2)
    expect(file?.extents.reduce((sum, extent) => sum + extent.lengthBytes, 0)).toBe(6000)
  })

  it('recovers a deleted file by assuming contiguity', async () => {
    const files = await scan(
      buildFat16Volume({
        // Deletion zeroes the chain; only the first cluster survives.
        root: [
          { name: 'GONE', extension: 'DOC', firstCluster: 40, sizeBytes: 5000, deleted: true },
        ],
        fatLinks: {},
      }),
    )

    const file = files[0]
    expect(file?.isDeleted).toBe(true)
    expect(file?.name).toBe('_ONE.DOC')
    // 2048-byte clusters: 5000 bytes spans three, assumed consecutive.
    expect(file?.extents).toHaveLength(1)
    expect(file?.extents[0]?.lengthBytes).toBe(5000)
    // Assumed contiguity must not be reported as verified non-fragmentation.
    expect(file?.isFragmented).toBe(false)
  })

  it('rates a deleted file poor when its clusters were reallocated', async () => {
    const intact = await scan(
      buildFat16Volume({
        root: [
          { name: 'FREE', extension: 'JPG', firstCluster: 40, sizeBytes: 2000, deleted: true },
        ],
        fatLinks: {},
      }),
    )

    const overwritten = await scan(
      buildFat16Volume({
        root: [
          { name: 'TAKEN', extension: 'JPG', firstCluster: 40, sizeBytes: 2000, deleted: true },
        ],
        // A non-zero FAT entry means another file now owns the cluster.
        fatLinks: { 40: 0xffff },
      }),
    )

    expect(intact[0]?.quality).toBe('excellent')
    expect(overwritten[0]?.quality).toBe('poor')
  })

  it('can return deleted files only', async () => {
    const files = await scan(
      buildFat16Volume({
        root: [
          { name: 'LIVE', extension: 'TXT', firstCluster: 10, sizeBytes: 100 },
          { name: 'DEAD', extension: 'TXT', firstCluster: 20, sizeBytes: 100, deleted: true },
        ],
        fatLinks: { 10: 0xffff },
      }),
      false,
    )

    expect(files).toHaveLength(1)
    expect(files[0]?.isDeleted).toBe(true)
  })

  it('does not loop on a directory that points at itself', async () => {
    const files = await scan(
      buildFat16Volume({
        root: [{ name: 'LOOP', firstCluster: 5, isDirectory: true }],
        directories: { 5: [{ name: 'SELF', firstCluster: 5, isDirectory: true }] },
        fatLinks: { 5: 0xffff },
      }),
    )

    expect(files.length).toBeLessThan(10)
  })

  it('rejects a volume that is not FAT', async () => {
    await expect(scan(Buffer.alloc(1024 * 1024))).rejects.toThrow(/not readable as FAT/)
  })
})

// --- exFAT scanner ---------------------------------------------------------

describe('scanExfatVolume', () => {
  const scan = (image: Buffer, includeExisting = true): Promise<RecoveredFile[]> =>
    drain(scanExfatVolume(new BufferBlockReader(image, SECTOR), 's', 0, { includeExisting }))

  it('reads the root directory and skips the bitmap entry', async () => {
    const files = await scan(
      buildExfatVolume({
        root: [
          { name: 'IMG_0001.CR3', sizeBytes: 20_000, firstCluster: 100, contiguous: true },
          { name: 'clip.mp4', sizeBytes: 8000, firstCluster: 200, contiguous: true },
        ],
        allocatedClusters: [100, 101, 102, 103, 104, 200, 201],
      }),
    )

    expect(files.map((file) => file.name).sort()).toEqual(['IMG_0001.CR3', 'clip.mp4'])
  })

  it('computes extents for a contiguous file without touching the FAT', async () => {
    const files = await scan(
      buildExfatVolume({
        root: [{ name: 'video.mov', sizeBytes: 10_000, firstCluster: 100, contiguous: true }],
      }),
    )

    // 4096-byte clusters: 10000 bytes spans three, merged into one extent.
    expect(files[0]?.extents).toHaveLength(1)
    expect(files[0]?.extents[0]?.lengthBytes).toBe(10_000)
    expect(files[0]?.isFragmented).toBe(false)
  })

  it('rates a deleted contiguous file excellent when its clusters are free', async () => {
    // The contiguity flag survives deletion, so the extents are known exactly
    // rather than assumed — the reason exFAT recovers better than FAT.
    const files = await scan(
      buildExfatVolume({
        root: [
          {
            name: 'deleted.jpg',
            sizeBytes: 4000,
            firstCluster: 500,
            contiguous: true,
            deleted: true,
          },
        ],
        allocatedClusters: [],
      }),
    )

    expect(files[0]?.isDeleted).toBe(true)
    expect(files[0]?.quality).toBe('excellent')
  })

  it('rates a deleted file poor when its clusters were reallocated', async () => {
    const files = await scan(
      buildExfatVolume({
        root: [
          { name: 'lost.jpg', sizeBytes: 4000, firstCluster: 500, contiguous: true, deleted: true },
        ],
        allocatedClusters: [500],
      }),
    )

    expect(files[0]?.quality).toBe('poor')
  })

  it('falls back to fair when no allocation bitmap is present', async () => {
    const files = await scan(
      buildExfatVolume({
        omitBitmap: true,
        root: [
          {
            name: 'unsure.jpg',
            sizeBytes: 4000,
            firstCluster: 500,
            contiguous: true,
            deleted: true,
          },
        ],
      }),
    )

    expect(files[0]?.quality).toBe('fair')
  })

  it('rates a deleted non-contiguous file good rather than excellent', async () => {
    // Its extents had to be assumed, so it cannot claim the same confidence.
    const files = await scan(
      buildExfatVolume({
        root: [
          {
            name: 'frag.bin',
            sizeBytes: 9000,
            firstCluster: 600,
            contiguous: false,
            deleted: true,
          },
        ],
        allocatedClusters: [],
      }),
    )

    expect(files[0]?.quality).toBe('good')
  })

  it('rejects a volume that is not exFAT', async () => {
    await expect(scan(Buffer.alloc(1024 * 1024))).rejects.toThrow(/not readable as exFAT/)
  })
})

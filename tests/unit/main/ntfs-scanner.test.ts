import { describe, expect, it } from 'vitest'
import { BufferBlockReader } from '@main/disk/block-device'
import { AttributeType } from '@main/scan/ntfs/ntfs'
import { assessQuality, scanNtfsVolume } from '@main/scan/ntfs/ntfs-scanner'
import type { RecoveredFile } from '@shared/types/scan'
import {
  buildFileNameAttributeValue,
  buildFileRecord,
  buildNonResidentAttribute,
  buildNtfsBootSector,
  buildResidentAttribute,
  buildStandardInformation,
  type RunSpec,
  type TimestampSpec,
} from './ntfs-fixtures'

const SECTOR = 512
const CLUSTER = 4096
const RECORD = 1024
const SECTORS_PER_CLUSTER = CLUSTER / SECTOR

// --- Synthetic volume ------------------------------------------------------

interface VolumeFileSpec {
  readonly recordNumber: number
  readonly name: string
  readonly parentRecordNumber?: number
  readonly isDirectory?: boolean
  readonly deleted?: boolean
  readonly sizeBytes?: number
  readonly runs?: readonly RunSpec[]
  readonly residentData?: Buffer
  readonly times?: TimestampSpec
  readonly dataFlags?: number
}

interface VolumeSpec {
  readonly totalClusters?: number
  readonly mftCluster?: number
  readonly mftClusters?: number
  readonly bitmapCluster?: number
  readonly files: readonly VolumeFileSpec[]
  /** Clusters to mark as in use in $Bitmap. */
  readonly allocatedClusters?: readonly number[]
  /** Split $MFT across two extents, as a full volume does. */
  readonly fragmentMft?: boolean
  readonly omitBitmap?: boolean
}

/**
 * Build a complete, byte-accurate NTFS volume image.
 *
 * Includes the structures the scanner actually depends on: a boot sector, an
 * $MFT whose own record describes the table's extents, and a $Bitmap whose bits
 * decide the recovery-quality score.
 */
function buildNtfsVolume(spec: VolumeSpec): Buffer {
  const totalClusters = spec.totalClusters ?? 512
  const mftCluster = spec.mftCluster ?? 4
  const mftClusters = spec.mftClusters ?? 16
  const bitmapCluster = spec.bitmapCluster ?? 20

  const image = Buffer.alloc(totalClusters * CLUSTER)

  buildNtfsBootSector({
    bytesPerSector: SECTOR,
    sectorsPerCluster: SECTORS_PER_CLUSTER,
    totalSectors: totalClusters * SECTORS_PER_CLUSTER,
    mftCluster,
    recordSizeFactor: -10,
  }).copy(image, 0)

  const mftOffset = mftCluster * CLUSTER
  const writeRecord = (recordNumber: number, record: Buffer): void => {
    record.copy(image, mftOffset + recordNumber * RECORD)
  }

  // Record 0 — $MFT. Its runlist is what the scanner trusts for the table's
  // real extents, so a fragmented table is described here.
  const mftRuns: RunSpec[] =
    spec.fragmentMft === true
      ? [
          { clusterCount: mftClusters / 2, startLcn: mftCluster },
          { clusterCount: mftClusters / 2, startLcn: mftCluster + 200 },
        ]
      : [{ clusterCount: mftClusters, startLcn: mftCluster }]

  writeRecord(
    0,
    buildFileRecord({
      recordNumber: 0,
      attributes: [
        buildResidentAttribute(
          AttributeType.FileName,
          buildFileNameAttributeValue({ name: '$MFT', parentRecordNumber: 5 }),
        ),
        buildNonResidentAttribute(AttributeType.Data, mftRuns, {
          realSize: mftClusters * CLUSTER,
        }),
      ],
    }),
  )

  // Record 6 — $Bitmap, one bit per cluster.
  if (spec.omitBitmap !== true) {
    const bitmapBytes = Math.ceil(totalClusters / 8)

    writeRecord(
      6,
      buildFileRecord({
        recordNumber: 6,
        attributes: [
          buildResidentAttribute(
            AttributeType.FileName,
            buildFileNameAttributeValue({ name: '$Bitmap', parentRecordNumber: 5 }),
          ),
          buildNonResidentAttribute(
            AttributeType.Data,
            [{ clusterCount: 1, startLcn: bitmapCluster }],
            {
              realSize: bitmapBytes,
            },
          ),
        ],
      }),
    )

    const bitmapOffset = bitmapCluster * CLUSTER
    for (const cluster of spec.allocatedClusters ?? []) {
      const byte = bitmapOffset + (cluster >> 3)
      image.writeUInt8(image.readUInt8(byte) | (1 << (cluster & 7)), byte)
    }
  }

  for (const file of spec.files) {
    const attributes: Buffer[] = [
      buildResidentAttribute(
        AttributeType.StandardInformation,
        buildStandardInformation(file.times),
      ),
      buildResidentAttribute(
        AttributeType.FileName,
        buildFileNameAttributeValue({
          name: file.name,
          parentRecordNumber: file.parentRecordNumber ?? 5,
          realSize: file.sizeBytes ?? 0,
        }),
      ),
    ]

    if (file.residentData !== undefined) {
      attributes.push(buildResidentAttribute(AttributeType.Data, file.residentData))
    } else if (file.runs !== undefined) {
      attributes.push(
        buildNonResidentAttribute(AttributeType.Data, file.runs, {
          realSize: file.sizeBytes ?? 0,
          ...(file.dataFlags === undefined ? {} : { flags: file.dataFlags }),
        }),
      )
    }

    writeRecord(
      file.recordNumber,
      buildFileRecord({
        recordNumber: file.recordNumber,
        inUse: file.deleted !== true,
        isDirectory: file.isDirectory === true,
        attributes,
      }),
    )
  }

  // The fragmented case needs the second half of the table physically present.
  if (spec.fragmentMft === true) {
    image.copy(
      image,
      (mftCluster + 200) * CLUSTER,
      mftOffset + (mftClusters / 2) * CLUSTER,
      mftOffset + mftClusters * CLUSTER,
    )
  }

  return image
}

async function collect(
  image: Buffer,
  options: { includeExisting?: boolean; volumeOffset?: number } = {},
): Promise<RecoveredFile[]> {
  const files: RecoveredFile[] = []

  for await (const batch of scanNtfsVolume(
    new BufferBlockReader(image, SECTOR),
    'session-1',
    options.volumeOffset ?? 0,
    { includeExisting: options.includeExisting ?? true },
  )) {
    files.push(...batch.files)
  }

  return files
}

// --- Tests -----------------------------------------------------------------

describe('scanNtfsVolume', () => {
  it('finds user files and skips NTFS metadata records', async () => {
    const files = await collect(
      buildNtfsVolume({
        files: [
          {
            recordNumber: 16,
            name: 'report.pdf',
            sizeBytes: 40_000,
            runs: [{ clusterCount: 10, startLcn: 100 }],
          },
          { recordNumber: 17, name: 'notes.txt', residentData: Buffer.from('hello'), sizeBytes: 5 },
        ],
      }),
    )

    // $MFT and $Bitmap live below record 16 and are not user data.
    expect(files.map((file) => file.name).sort()).toEqual(['notes.txt', 'report.pdf'])
  })

  it('classifies files and extracts their metadata', async () => {
    const created = Date.UTC(2025, 3, 10)
    const files = await collect(
      buildNtfsVolume({
        files: [
          {
            recordNumber: 16,
            name: 'IMG_1234.CR3',
            sizeBytes: 28_000_000,
            runs: [{ clusterCount: 7000, startLcn: 100 }],
            times: { createdAt: created, modifiedAt: created },
          },
        ],
      }),
    )

    const file = files[0]
    expect(file?.extension).toBe('cr3')
    expect(file?.category).toBe('image')
    expect(file?.sizeBytes).toBe(28_000_000)
    expect(file?.createdAt).toBe(created)
    expect(file?.isDeleted).toBe(false)
  })

  it('reconstructs the path through parent directories', async () => {
    const files = await collect(
      buildNtfsVolume({
        files: [
          { recordNumber: 16, name: 'Pictures', isDirectory: true, parentRecordNumber: 5 },
          { recordNumber: 17, name: '2025', isDirectory: true, parentRecordNumber: 16 },
          {
            recordNumber: 18,
            name: 'beach.jpg',
            parentRecordNumber: 17,
            sizeBytes: 2000,
            runs: [{ clusterCount: 1, startLcn: 300 }],
          },
        ],
      }),
    )

    const photo = files.find((file) => file.name === 'beach.jpg')
    expect(photo?.path).toBe('Pictures\\2025')
  })

  it('marks a path segment as unknown when the parent record was reused', async () => {
    const files = await collect(
      buildNtfsVolume({
        files: [
          // Parent 99 has no record; its slot was taken by something else.
          {
            recordNumber: 16,
            name: 'orphan.txt',
            parentRecordNumber: 99,
            runs: [{ clusterCount: 1, startLcn: 300 }],
          },
        ],
      }),
    )

    // The file is still recoverable; only its location is unknown.
    expect(files[0]?.path).toBe('?')
    expect(files[0]?.name).toBe('orphan.txt')
  })

  it('reports deleted files and can exclude live ones', async () => {
    const image = buildNtfsVolume({
      files: [
        { recordNumber: 16, name: 'live.txt', runs: [{ clusterCount: 1, startLcn: 100 }] },
        {
          recordNumber: 17,
          name: 'gone.txt',
          deleted: true,
          runs: [{ clusterCount: 1, startLcn: 110 }],
        },
      ],
    })

    const all = await collect(image)
    expect(all).toHaveLength(2)

    const deletedOnly = await collect(image, { includeExisting: false })
    expect(deletedOnly.map((file) => file.name)).toEqual(['gone.txt'])
    expect(deletedOnly[0]?.isDeleted).toBe(true)
  })

  it('emits device-absolute extents, so recovery never has to rebase them', async () => {
    const volumeOffset = 1024 * 1024 * 100

    const files = await collect(
      buildNtfsVolume({
        files: [
          {
            recordNumber: 16,
            name: 'data.bin',
            sizeBytes: 8192,
            runs: [{ clusterCount: 2, startLcn: 300 }],
          },
        ],
      }),
      { volumeOffset },
    )

    expect(files[0]?.extents).toEqual([
      { offsetBytes: volumeOffset + 300 * CLUSTER, lengthBytes: 2 * CLUSTER },
    ])
  })

  it('reports resident data separately from cluster-backed data', async () => {
    const files = await collect(
      buildNtfsVolume({
        files: [
          {
            recordNumber: 16,
            name: 'small.txt',
            residentData: Buffer.from('inside the MFT'),
            sizeBytes: 14,
          },
        ],
      }),
    )

    expect(files[0]?.hasResidentData).toBe(true)
    expect(files[0]?.source).toBe('ntfs-resident')
    expect(files[0]?.extents).toEqual([])
  })

  it('flags a fragmented file', async () => {
    const files = await collect(
      buildNtfsVolume({
        files: [
          {
            recordNumber: 16,
            name: 'frag.bin',
            sizeBytes: 12_288,
            runs: [
              { clusterCount: 1, startLcn: 100 },
              { clusterCount: 2, startLcn: 400 },
            ],
          },
        ],
      }),
    )

    expect(files[0]?.isFragmented).toBe(true)
    expect(files[0]?.extents).toHaveLength(2)
  })

  it('follows a fragmented $MFT rather than stopping at the first extent', async () => {
    // Assuming the table is contiguous would silently lose every file past the
    // fragment boundary — the worst kind of bug this product can have.
    const files = await collect(
      buildNtfsVolume({
        fragmentMft: true,
        mftClusters: 16,
        files: [
          { recordNumber: 16, name: 'early.txt', runs: [{ clusterCount: 1, startLcn: 100 }] },
          // Record 40 lives in the second extent (records 32+ at 1 KiB each).
          { recordNumber: 40, name: 'late.txt', runs: [{ clusterCount: 1, startLcn: 110 }] },
        ],
      }),
    )

    expect(files.map((file) => file.name).sort()).toEqual(['early.txt', 'late.txt'])
  })

  it('rejects a volume that is not NTFS', async () => {
    await expect(async () => {
      for await (const _batch of scanNtfsVolume(
        new BufferBlockReader(Buffer.alloc(1024 * 1024), SECTOR),
        'session-1',
        0,
        { includeExisting: true },
      )) {
        // The generator must throw before yielding anything.
      }
    }).rejects.toThrow(/not readable as NTFS/)
  })

  it('reports progress against the record total', async () => {
    const image = buildNtfsVolume({
      files: [{ recordNumber: 16, name: 'a.txt', runs: [{ clusterCount: 1, startLcn: 100 }] }],
    })

    const batches = []
    for await (const batch of scanNtfsVolume(new BufferBlockReader(image, SECTOR), 's', 0, {
      includeExisting: true,
    })) {
      batches.push(batch)
    }

    const last = batches.at(-1)
    expect(last?.total).toBe(64) // 16 clusters of 1 KiB records
    expect(last?.processed).toBeGreaterThan(0)
  })
})

describe('recovery quality', () => {
  const scanQuality = async (
    spec: Parameters<typeof buildNtfsVolume>[0],
  ): Promise<string | undefined> => {
    const files = await collect(buildNtfsVolume(spec))
    return files[0]?.quality
  }

  it('rates a deleted file whose clusters are still free as excellent', async () => {
    const quality = await scanQuality({
      files: [
        {
          recordNumber: 16,
          name: 'intact.jpg',
          deleted: true,
          sizeBytes: 4096,
          runs: [{ clusterCount: 1, startLcn: 100 }],
        },
      ],
      allocatedClusters: [],
    })

    expect(quality).toBe('excellent')
  })

  it('rates a deleted file whose clusters were reallocated as poor', async () => {
    // Something else now owns those clusters, so the contents are gone. Saying
    // so before the user spends an hour restoring is the whole point.
    const quality = await scanQuality({
      files: [
        {
          recordNumber: 16,
          name: 'overwritten.doc',
          deleted: true,
          sizeBytes: 4096,
          runs: [{ clusterCount: 1, startLcn: 100 }],
        },
      ],
      allocatedClusters: [100],
    })

    expect(quality).toBe('poor')
  })

  it('falls back to fair when no bitmap is available', async () => {
    const quality = await scanQuality({
      omitBitmap: true,
      files: [
        {
          recordNumber: 16,
          name: 'unknown.bin',
          deleted: true,
          sizeBytes: 4096,
          runs: [{ clusterCount: 1, startLcn: 100 }],
        },
      ],
    })

    expect(quality).toBe('fair')
  })

  it('rates a live file as excellent and a resident file as excellent', async () => {
    expect(
      await scanQuality({
        files: [
          {
            recordNumber: 16,
            name: 'live.txt',
            sizeBytes: 4096,
            runs: [{ clusterCount: 1, startLcn: 100 }],
          },
        ],
      }),
    ).toBe('excellent')

    expect(
      await scanQuality({
        files: [
          { recordNumber: 16, name: 'tiny.txt', residentData: Buffer.from('x'), sizeBytes: 1 },
        ],
      }),
    ).toBe('excellent')
  })

  it('rates a file with a size but no runs as poor', async () => {
    // The metadata survived; the pointer to the contents did not.
    const quality = await scanQuality({
      files: [{ recordNumber: 16, name: 'lost.bin', deleted: true, sizeBytes: 50_000 }],
    })

    expect(quality).toBe('poor')
  })
})

describe('assessQuality', () => {
  const record = (overrides: Record<string, unknown> = {}) =>
    ({
      recordNumber: 20,
      sequenceNumber: 1,
      inUse: false,
      isDirectory: false,
      baseRecordNumber: 0,
      names: [],
      timestamps: { createdAt: null, modifiedAt: null, accessedAt: null, changedAt: null },
      dataSizeBytes: 4096,
      dataRuns: [{ startLcn: 100, clusterCount: 1, isSparse: false }],
      residentData: null,
      isCompressed: false,
      isEncrypted: false,
      isSparse: false,
      isDamaged: false,
      ...overrides,
    }) as Parameters<typeof assessQuality>[0]

  it('rates encrypted content poor regardless of cluster state', () => {
    // Without the user's key the bytes are unreadable even if perfectly intact.
    expect(assessQuality(record({ isEncrypted: true }), true, 4096)).toBe('poor')
  })

  it('downgrades a compressed deleted file, which is harder to reassemble', () => {
    expect(assessQuality(record({ isCompressed: true }), true, 4096)).toBe('good')
    expect(assessQuality(record({ isCompressed: false }), true, 4096)).toBe('excellent')
  })

  it('downgrades a record whose fixups failed', () => {
    expect(assessQuality(record({ isDamaged: true }), true, 4096)).toBe('fair')
  })

  it('rates an empty file as good rather than poor', () => {
    expect(assessQuality(record({ dataRuns: [], dataSizeBytes: 0 }), null, 0)).toBe('good')
  })
})

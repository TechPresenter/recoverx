import { describe, expect, it } from 'vitest'
import { BufferBlockReader } from '@main/disk/block-device'
import {
  evaluateCandidate,
  findAnchorHits,
  resolveCandidates,
  toRecoveredPartitions,
} from '@main/disk/partition-finder'
import type { Partition } from '@shared/types/disk'
import type { PartitionCandidate } from '@shared/types/partition-search'
import {
  SECTOR,
  blankDisk,
  writeExfatVolume,
  writeExtSuperblock,
  writeFat32Volume,
  writeNtfsBootSector,
  writeNtfsVolume,
} from './disk-fixtures'

/**
 * Lost-partition recovery, against volumes built byte by byte.
 *
 * Synthetic images are used rather than real disks because the states that
 * matter here — a wiped table, a volume claiming more space than the disk has,
 * a header with no surviving backup — are exactly the states a healthy disk
 * will never present. They can be constructed deterministically; they cannot be
 * waited for.
 */

/** Volumes must clear the 8 MiB floor, so tests work in whole mebibytes. */
const MIB = 1024 * 1024
const SECTORS_PER_MIB = MIB / SECTOR

function mib(count: number): number {
  return count * MIB
}

describe('findAnchorHits', () => {
  it('finds a boot sector and reports the volume that starts there', () => {
    const image = blankDisk(64)
    writeNtfsBootSector(image, 16 * SECTOR)

    const hits = findAnchorHits(image, 0)

    expect(hits).toEqual([{ volumeOffsetBytes: 16 * SECTOR, fileSystem: 'ntfs' }])
  })

  it('reports offsets relative to the whole device, not the chunk', () => {
    // Chunks are read at increasing offsets; a hit at chunk-relative 0x200
    // inside the fourth chunk is nowhere near device offset 0x200.
    const image = blankDisk(64)
    writeNtfsBootSector(image, 4 * SECTOR)

    const chunkOffset = 512 * MIB
    const hits = findAnchorHits(image, chunkOffset)

    expect(hits[0]?.volumeOffsetBytes).toBe(chunkOffset + 4 * SECTOR)
  })

  it('ignores a matching signature that is not on a sector boundary', () => {
    // The decisive false-positive filter. These same bytes appear inside disk
    // images, installers and virtual machine files all the time; a partition
    // never starts mid-sector, so alignment separates the two cheaply.
    const image = blankDisk(64)
    image.write('NTFS    ', 10 * SECTOR + 3 + 7, 'latin1')

    expect(findAnchorHits(image, 0)).toEqual([])
  })

  it('works backwards from an ext superblock to the start of the volume', () => {
    // The ext magic is 1024 bytes into the volume, so the volume begins before
    // the sector the signature was found in.
    const image = blankDisk(64)
    writeExtSuperblock(image, 8 * SECTOR)

    const hits = findAnchorHits(image, 0)

    expect(hits).toEqual([{ volumeOffsetBytes: 8 * SECTOR, fileSystem: 'ext4' }])
  })

  it('never reports a volume that would start before the device', () => {
    // An ext-shaped signature in the first two sectors implies a negative
    // start. Reporting it would send a read to a nonsense offset.
    const image = blankDisk(8)
    image.writeUInt16LE(0xef53, 0x38)

    expect(findAnchorHits(image, 0)).toEqual([])
  })

  it('reports one hit when two signatures imply the same volume', () => {
    const image = blankDisk(64)
    writeNtfsBootSector(image, 4 * SECTOR)
    writeExtSuperblock(image, 4 * SECTOR)

    const hits = findAnchorHits(image, 0)

    expect(hits).toHaveLength(1)
    expect(hits[0]?.volumeOffsetBytes).toBe(4 * SECTOR)
  })

  it('returns hits in device order regardless of signature order', () => {
    // Anchors are checked one signature at a time across the whole chunk, so
    // without the final sort the results come out grouped by filesystem.
    const image = blankDisk(128)
    writeExtSuperblock(image, 64 * SECTOR)
    writeNtfsBootSector(image, 8 * SECTOR)

    const offsets = findAnchorHits(image, 0).map((hit) => hit.volumeOffsetBytes)

    expect(offsets).toEqual([8 * SECTOR, 64 * SECTOR])
  })

  it('finds nothing in empty space', () => {
    expect(findAnchorHits(blankDisk(256), 0)).toEqual([])
  })
})

describe('evaluateCandidate', () => {
  const DEVICE = 'disk9'

  async function evaluate(
    image: Buffer,
    volumeOffsetBytes: number,
    regionEnd = image.length,
  ): Promise<PartitionCandidate | null> {
    const reader = new BufferBlockReader(image)

    return evaluateCandidate(
      reader,
      { volumeOffsetBytes, fileSystem: 'ntfs' },
      DEVICE,
      1,
      regionEnd,
    )
  }

  it('reconstructs a partition from the volume it found', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)
    const start = mib(4)
    writeNtfsVolume(image, start, 16 * SECTORS_PER_MIB, { backup: false })

    const candidate = await evaluate(image, start)

    expect(candidate).not.toBeNull()
    expect(candidate?.offsetBytes).toBe(start)
    expect(candidate?.fileSystem).toBe('ntfs')
    // The size comes from the volume's own header, not from the free space
    // around it — which is the whole reason a reconstructed partition is usable.
    expect(candidate?.sizeBytes).toBe(mib(16))
    expect(candidate?.evidence).toContain('self-reported-size')
  })

  it('is only likely when the header stands alone', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)
    writeNtfsVolume(image, mib(4), 16 * SECTORS_PER_MIB, { backup: false })

    const candidate = await evaluate(image, mib(4))

    expect(candidate?.confidence).toBe('likely')
    expect(candidate?.evidence).not.toContain('backup-boot-sector')
  })

  it('is confirmed when the NTFS backup boot sector agrees', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)
    writeNtfsVolume(image, mib(4), 16 * SECTORS_PER_MIB)

    const candidate = await evaluate(image, mib(4))

    expect(candidate?.confidence).toBe('confirmed')
    expect(candidate?.evidence).toContain('backup-boot-sector')
  })

  it('extends an NTFS volume to include its backup sector', async () => {
    // The BPB counts every sector except the backup, so the partition is one
    // sector longer than the header claims. A recovery that stops short would
    // truncate the volume's own last structures.
    const image = blankDisk(40 * SECTORS_PER_MIB)
    const totalSectors = 16 * SECTORS_PER_MIB
    writeNtfsVolume(image, mib(4), totalSectors)

    const candidate = await evaluate(image, mib(4))

    expect(candidate?.sizeBytes).toBe((totalSectors + 1) * SECTOR)
  })

  it('is confirmed when the exFAT backup VBR agrees', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)
    writeExfatVolume(image, mib(4), 16 * SECTORS_PER_MIB)

    const reader = new BufferBlockReader(image)
    const candidate = await evaluateCandidate(
      reader,
      { volumeOffsetBytes: mib(4), fileSystem: 'exfat' },
      DEVICE,
      1,
      image.length,
    )

    expect(candidate?.fileSystem).toBe('exfat')
    expect(candidate?.confidence).toBe('confirmed')
  })

  it('is confirmed when the FAT32 backup boot sector agrees', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)
    writeFat32Volume(image, mib(4), 16 * SECTORS_PER_MIB, { label: 'PHOTOS' })

    const reader = new BufferBlockReader(image)
    const candidate = await evaluateCandidate(
      reader,
      { volumeOffsetBytes: mib(4), fileSystem: 'fat32' },
      DEVICE,
      1,
      image.length,
    )

    expect(candidate?.fileSystem).toBe('fat32')
    expect(candidate?.confidence).toBe('confirmed')
    expect(candidate?.label).toBe('PHOTOS')
  })

  it('does not confirm a FAT32 volume whose backup was overwritten', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)
    writeFat32Volume(image, mib(4), 16 * SECTORS_PER_MIB, { backup: false })

    const reader = new BufferBlockReader(image)
    const candidate = await evaluateCandidate(
      reader,
      { volumeOffsetBytes: mib(4), fileSystem: 'fat32' },
      DEVICE,
      1,
      image.length,
    )

    expect(candidate?.confidence).toBe('likely')
  })

  it('clips a volume that claims more space than the device has', async () => {
    // A header cloned from a larger disk says so. The tail is genuinely gone,
    // and reporting the declared size would hand the scanner an extent that
    // runs off the end of the device.
    const image = blankDisk(24 * SECTORS_PER_MIB)
    const start = mib(4)
    writeNtfsVolume(image, start, 64 * SECTORS_PER_MIB, { backup: false })

    const candidate = await evaluate(image, start)

    expect(candidate?.sizeBytes).toBe(image.length - start)
    expect(candidate?.confidence).toBe('possible')
    expect(candidate?.evidence).toContain('size-clipped')
  })

  it('rejects a volume too small to hold anything worth recovering', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)
    writeNtfsVolume(image, mib(4), 2 * SECTORS_PER_MIB, { backup: false })

    expect(await evaluate(image, mib(4))).toBeNull()
  })

  it('rejects a position with no filesystem at it', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)

    expect(await evaluate(image, mib(4))).toBeNull()
  })

  it('rejects a position past the end of the device', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)

    expect(await evaluate(image, image.length + SECTOR)).toBeNull()
  })

  it('reports whether a metadata scan can read the volume', async () => {
    const image = blankDisk(40 * SECTORS_PER_MIB)
    writeNtfsVolume(image, mib(4), 16 * SECTORS_PER_MIB)

    expect((await evaluate(image, mib(4)))?.supportsQuickScan).toBe(true)
  })
})

describe('resolveCandidates', () => {
  function candidate(overrides: Partial<PartitionCandidate>): PartitionCandidate {
    return {
      id: 'disk0:found1',
      deviceId: 'disk0',
      offsetBytes: 0,
      sizeBytes: mib(16),
      fileSystem: 'ntfs',
      label: null,
      clusterSizeBytes: 4096,
      confidence: 'likely',
      evidence: ['boot-sector'],
      supportsQuickScan: true,
      ...overrides,
    }
  }

  it('keeps partitions that do not overlap', () => {
    const resolved = resolveCandidates([
      candidate({ offsetBytes: 0, sizeBytes: mib(16) }),
      candidate({ offsetBytes: mib(16), sizeBytes: mib(16) }),
    ])

    expect(resolved).toHaveLength(2)
  })

  it('drops a volume found inside another one', () => {
    // This is what an NTFS backup boot sector produces: a second header near the
    // end of a volume, implying a partition that begins inside the first.
    const resolved = resolveCandidates([
      candidate({ offsetBytes: 0, sizeBytes: mib(16), confidence: 'confirmed' }),
      candidate({ offsetBytes: mib(15), sizeBytes: mib(16) }),
    ])

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.offsetBytes).toBe(0)
  })

  it('lets a confirmed volume displace a weaker one claiming the same space', () => {
    // Order of discovery must not decide the outcome: the speculative candidate
    // is found first here, and still loses.
    const resolved = resolveCandidates([
      candidate({ offsetBytes: mib(4), sizeBytes: mib(64), confidence: 'possible' }),
      candidate({ offsetBytes: mib(8), sizeBytes: mib(16), confidence: 'confirmed' }),
    ])

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.confidence).toBe('confirmed')
    expect(resolved[0]?.offsetBytes).toBe(mib(8))
  })

  it('prefers the larger explanation at equal confidence', () => {
    const resolved = resolveCandidates([
      candidate({ offsetBytes: mib(8), sizeBytes: mib(16) }),
      candidate({ offsetBytes: mib(4), sizeBytes: mib(64) }),
    ])

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.sizeBytes).toBe(mib(64))
  })

  it('numbers the survivors in device order', () => {
    const resolved = resolveCandidates([
      candidate({ id: 'disk0:found7', offsetBytes: mib(64), sizeBytes: mib(16) }),
      candidate({ id: 'disk0:found2', offsetBytes: mib(16), sizeBytes: mib(16) }),
    ])

    expect(resolved.map((item) => item.id)).toEqual(['disk0:found1', 'disk0:found2'])
  })

  it('returns nothing for nothing', () => {
    expect(resolveCandidates([])).toEqual([])
  })
})

/**
 * The scenario the module exists for: a disk whose partition table is gone.
 *
 * Nothing below writes a table. The volumes are laid out as a real disk would
 * have them, sector zero is left blank, and the search has to find them from
 * their own contents alone.
 */
describe('a disk with no partition table', () => {
  const DEVICE = 'disk3'

  interface Placed {
    readonly offsetBytes: number
    readonly sizeBytes: number
  }

  async function search(image: Buffer): Promise<PartitionCandidate[]> {
    const reader = new BufferBlockReader(image)
    const found: PartitionCandidate[] = []
    let index = 1

    for (const hit of findAnchorHits(image, 0)) {
      const candidate = await evaluateCandidate(reader, hit, DEVICE, index, image.length)
      if (candidate === null) continue

      index += 1
      found.push(candidate)
    }

    return resolveCandidates(found)
  }

  it('recovers every volume, and invents none', async () => {
    const image = blankDisk(80 * SECTORS_PER_MIB)

    const windows: Placed = { offsetBytes: mib(1), sizeBytes: 16 * SECTORS_PER_MIB * SECTOR }
    const data: Placed = { offsetBytes: mib(20), sizeBytes: 24 * SECTORS_PER_MIB * SECTOR }
    const photos: Placed = { offsetBytes: mib(48), sizeBytes: 16 * SECTORS_PER_MIB * SECTOR }

    writeNtfsVolume(image, windows.offsetBytes, windows.sizeBytes / SECTOR)
    writeExfatVolume(image, data.offsetBytes, data.sizeBytes / SECTOR)
    writeFat32Volume(image, photos.offsetBytes, photos.sizeBytes / SECTOR, { label: 'PHOTOS' })

    const found = await search(image)

    expect(found.map((item) => item.fileSystem)).toEqual(['ntfs', 'exfat', 'fat32'])
    expect(found.map((item) => item.offsetBytes)).toEqual([
      windows.offsetBytes,
      data.offsetBytes,
      photos.offsetBytes,
    ])

    // Every one of these keeps a backup header, so every one is corroborated.
    expect(found.every((item) => item.confidence === 'confirmed')).toBe(true)
  })

  it('does not report a volume twice because of its own backup header', async () => {
    // The regression this guards: an NTFS backup boot sector is a byte-perfect
    // copy, so the search finds it and derives a second partition beginning one
    // sector before the first one ends. A user shown two overlapping copies of
    // their drive cannot tell which to recover.
    const image = blankDisk(80 * SECTORS_PER_MIB)
    writeNtfsVolume(image, mib(1), 32 * SECTORS_PER_MIB)

    const hits = findAnchorHits(image, 0)
    const found = await search(image)

    // Both copies are seen...
    expect(hits.length).toBeGreaterThan(1)
    // ...and exactly one partition comes out.
    expect(found).toHaveLength(1)
    expect(found[0]?.offsetBytes).toBe(mib(1))
  })

  it('finds a volume that survived a table wipe but lost its backup', async () => {
    // Recovery is still possible with a single header; it is simply reported
    // with less certainty rather than withheld.
    const image = blankDisk(80 * SECTORS_PER_MIB)
    writeNtfsVolume(image, mib(1), 32 * SECTORS_PER_MIB, { backup: false })

    const found = await search(image)

    expect(found).toHaveLength(1)
    expect(found[0]?.confidence).toBe('likely')
  })

  it('finds nothing on a genuinely blank disk', async () => {
    expect(await search(blankDisk(80 * SECTORS_PER_MIB))).toEqual([])
  })
})

describe('toRecoveredPartitions', () => {
  function tableEntry(index: number, offsetBytes: number): Partition {
    return {
      id: `disk0:p${index}`,
      deviceId: 'disk0',
      index,
      offsetBytes,
      sizeBytes: mib(16),
      fileSystem: 'ntfs',
      label: null,
      driveLetter: 'C',
      typeCode: '0x07',
      typeName: 'NTFS',
      isBootable: false,
      isHidden: false,
      isRecovered: false,
      freeBytes: null,
    }
  }

  function found(id: string, offsetBytes: number): PartitionCandidate {
    return {
      id,
      deviceId: 'disk0',
      offsetBytes,
      sizeBytes: mib(16),
      fileSystem: 'ntfs',
      label: 'Recovered',
      clusterSizeBytes: 4096,
      confidence: 'confirmed',
      evidence: ['boot-sector', 'backup-boot-sector'],
      supportsQuickScan: true,
    }
  }

  it('marks every reconstructed partition as recovered', () => {
    const partitions = toRecoveredPartitions('disk0', [], [found('disk0:found1', mib(4))])

    expect(partitions).toHaveLength(1)
    expect(partitions[0]?.isRecovered).toBe(true)
    // Nothing mounted it, so it cannot have a letter — showing one would imply
    // the user could simply open it in Explorer.
    expect(partitions[0]?.driveLetter).toBeNull()
  })

  it('numbers found partitions after the ones the table already lists', () => {
    const partitions = toRecoveredPartitions(
      'disk0',
      [tableEntry(1, 0), tableEntry(2, mib(64))],
      [found('disk0:found1', mib(20))],
    )

    expect(partitions.find((item) => item.isRecovered)?.index).toBe(3)
  })

  it('keeps the partitions the table still describes', () => {
    const partitions = toRecoveredPartitions(
      'disk0',
      [tableEntry(1, 0)],
      [found('disk0:found1', mib(20))],
    )

    expect(partitions).toHaveLength(2)
    expect(partitions.filter((item) => !item.isRecovered)).toHaveLength(1)
  })

  it('replaces the results of an earlier search rather than adding to them', () => {
    // Running a second search must not leave the user looking at two copies of
    // every volume, one from each run.
    const first = toRecoveredPartitions(
      'disk0',
      [tableEntry(1, 0)],
      [found('disk0:found1', mib(20))],
    )
    const second = toRecoveredPartitions('disk0', first, [found('disk0:found1', mib(20))])

    expect(second.filter((item) => item.isRecovered)).toHaveLength(1)
    expect(second).toHaveLength(2)
  })

  it('orders partitions by their position on the device', () => {
    const partitions = toRecoveredPartitions(
      'disk0',
      [tableEntry(1, mib(64))],
      [found('disk0:found1', mib(4))],
    )

    expect(partitions.map((item) => item.offsetBytes)).toEqual([mib(4), mib(64)])
  })

  it('drops every adopted partition when the search found nothing', () => {
    const adopted = toRecoveredPartitions(
      'disk0',
      [tableEntry(1, 0)],
      [found('disk0:found1', mib(20))],
    )
    const cleared = toRecoveredPartitions('disk0', adopted, [])

    expect(cleared).toHaveLength(1)
    expect(cleared[0]?.isRecovered).toBe(false)
  })
})

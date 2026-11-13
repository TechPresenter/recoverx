import { describe, expect, it } from 'vitest'
import { BufferBlockReader, SlicedBlockReader, ceilToSector } from '@main/disk/block-device'
import { crc32 } from '@main/disk/crc32'
import {
  classifyDevice,
  mapBusType,
  mapHealthStatus,
  mapMediaType,
  mapPartitionStyle,
  physicalDrivePath,
} from '@main/disk/device-enumerator'
import { identifyFilesystem } from '@main/disk/filesystem-signature'
import { decodeGuid, describeGptType, readGptTable } from '@main/disk/gpt'
import { describeMbrType, hasMbrSignature, isExtendedType, readMbrTable } from '@main/disk/mbr'
import { computeUnallocated, readPartitionTable } from '@main/disk/partition-table'
import {
  GPT_BASIC_DATA,
  GPT_EFI_SYSTEM,
  SECTOR,
  blankDisk,
  encodeGuid,
  writeExfatBootSector,
  writeExtSuperblock,
  writeFat16BootSector,
  writeFat32BootSector,
  writeGpt,
  writeMbr,
  writeNtfsBootSector,
} from './disk-fixtures'

const MIB = 1024 * 1024

describe('crc32', () => {
  it('matches the published IEEE test vector', () => {
    expect(crc32(Buffer.from('123456789', 'latin1'))).toBe(0xcbf43926)
  })

  it('returns 0 for empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})

describe('BufferBlockReader', () => {
  const reader = new BufferBlockReader(Buffer.from('0123456789abcdef'.repeat(64), 'latin1'))

  it('reads a window', async () => {
    expect((await reader.read(0, 4)).toString('latin1')).toBe('0123')
    expect((await reader.read(4, 4)).toString('latin1')).toBe('4567')
  })

  it('truncates a read that runs past the end', async () => {
    const tail = await reader.read(reader.sizeBytes - 2, 100)
    expect(tail).toHaveLength(2)
  })

  it('returns empty for out-of-range or non-positive reads', async () => {
    expect(await reader.read(reader.sizeBytes, 10)).toHaveLength(0)
    expect(await reader.read(0, 0)).toHaveLength(0)
    expect(await reader.read(-5, 10)).toHaveLength(0)
  })

  it('returns a copy, so a caller cannot mutate the backing image', async () => {
    const first = await reader.read(0, 4)
    first.write('XXXX')

    expect((await reader.read(0, 4)).toString('latin1')).toBe('0123')
  })
})

describe('SlicedBlockReader', () => {
  const parent = new BufferBlockReader(Buffer.from('AAAABBBBCCCCDDDD', 'latin1'))
  const slice = new SlicedBlockReader(parent, 4, 8)

  it('rebases offsets onto the window', async () => {
    expect((await slice.read(0, 4)).toString('latin1')).toBe('BBBB')
    expect((await slice.read(4, 4)).toString('latin1')).toBe('CCCC')
  })

  it('cannot read past its own window', async () => {
    // Without the clamp this would return 'DDDD' from outside the partition.
    expect(await slice.read(8, 4)).toHaveLength(0)
    expect(await slice.read(6, 10)).toHaveLength(2)
  })

  it('clamps a window that extends past the parent', () => {
    expect(new SlicedBlockReader(parent, 12, 999).sizeBytes).toBe(4)
  })
})

describe('ceilToSector', () => {
  it('rounds up to the next boundary', () => {
    expect(ceilToSector(1, 512)).toBe(512)
    expect(ceilToSector(512, 512)).toBe(512)
    expect(ceilToSector(513, 512)).toBe(1024)
    expect(ceilToSector(0, 512)).toBe(0)
  })
})

describe('MBR', () => {
  it('rejects a sector with no boot signature', async () => {
    const image = blankDisk(64)
    expect(hasMbrSignature(image.subarray(0, SECTOR))).toBe(false)
    expect(await readMbrTable(new BufferBlockReader(image))).toBeNull()
  })

  it('reads primary partitions', async () => {
    const image = blankDisk(2048)
    writeMbr(image, [
      { type: 0x07, startLba: 2048 / 8, sectorCount: 512, bootable: true },
      { type: 0x0c, startLba: 1024, sectorCount: 512 },
    ])

    const table = await readMbrTable(new BufferBlockReader(image))

    expect(table).not.toBeNull()
    expect(table?.entries).toHaveLength(2)
    expect(table?.entries[0]?.typeName).toBe('NTFS / exFAT')
    expect(table?.entries[0]?.bootable).toBe(true)
    expect(table?.entries[1]?.typeName).toBe('FAT32 (LBA)')
    expect(table?.diskSignature).toBe(0x12345678)
  })

  it('ignores empty and zero-length slots', async () => {
    const image = blankDisk(512)
    writeMbr(image, [
      { type: 0x07, startLba: 64, sectorCount: 0 },
      { type: 0x00, startLba: 128, sectorCount: 64 },
      { type: 0x83, startLba: 256, sectorCount: 64 },
    ])

    const table = await readMbrTable(new BufferBlockReader(image))

    expect(table?.entries).toHaveLength(1)
    expect(table?.entries[0]?.type).toBe(0x83)
  })

  it('walks the extended partition chain', async () => {
    const image = blankDisk(4096)

    // One primary, then an extended container holding two logical partitions.
    const extendedStart = 1024
    writeMbr(image, [
      { type: 0x07, startLba: 64, sectorCount: 512 },
      { type: 0x05, startLba: extendedStart, sectorCount: 2048 },
    ])

    // First EBR: logical partition +64, next EBR at +512 (relative to extended).
    writeMbr(
      image,
      [
        { type: 0x83, startLba: 64, sectorCount: 256 },
        { type: 0x05, startLba: 512, sectorCount: 512 },
      ],
      extendedStart,
    )

    // Second EBR: one logical partition, no further link.
    writeMbr(image, [{ type: 0x82, startLba: 64, sectorCount: 128 }], extendedStart + 512)

    const table = await readMbrTable(new BufferBlockReader(image))

    expect(table?.entries).toHaveLength(3)

    const logical = table?.entries.filter((entry) => entry.isLogical) ?? []
    expect(logical).toHaveLength(2)
    // Logical offsets are relative to their own EBR, not to the disk.
    expect(logical[0]?.startLba).toBe(extendedStart + 64)
    expect(logical[1]?.startLba).toBe(extendedStart + 512 + 64)
  })

  it('does not loop forever on a self-referential chain', async () => {
    const image = blankDisk(4096)
    const extendedStart = 1024

    writeMbr(image, [{ type: 0x05, startLba: extendedStart, sectorCount: 2048 }])
    // The EBR's "next" pointer refers back to itself.
    writeMbr(
      image,
      [
        { type: 0x83, startLba: 64, sectorCount: 128 },
        { type: 0x05, startLba: 0, sectorCount: 512 },
      ],
      extendedStart,
    )

    const table = await readMbrTable(new BufferBlockReader(image))

    expect(table?.warnings.some((warning) => warning.includes('loops'))).toBe(true)
    expect(table?.entries.length).toBeLessThan(5)
  })

  it('identifies a protective MBR', async () => {
    const image = blankDisk(2048)
    writeMbr(image, [{ type: 0xee, startLba: 1, sectorCount: 2047 }])

    const table = await readMbrTable(new BufferBlockReader(image))
    expect(table?.isProtective).toBe(true)
  })

  it('names known types and falls back for unknown ones', () => {
    expect(describeMbrType(0x07)).toBe('NTFS / exFAT')
    expect(describeMbrType(0x83)).toBe('Linux')
    expect(describeMbrType(0x9a)).toBe('Unknown (0x9a)')
    expect(isExtendedType(0x05)).toBe(true)
    expect(isExtendedType(0x07)).toBe(false)
  })
})

describe('GPT', () => {
  const buildDisk = (): Buffer => {
    const image = blankDisk(4096)
    writeGpt(image, [
      { typeGuid: GPT_EFI_SYSTEM, startLba: 34, endLba: 1057, name: 'EFI' },
      { typeGuid: GPT_BASIC_DATA, startLba: 1058, endLba: 3000, name: 'Windows' },
    ])
    return image
  }

  it('decodes GUIDs in GPT mixed-endian order', () => {
    expect(decodeGuid(encodeGuid(GPT_BASIC_DATA))).toBe(GPT_BASIC_DATA)
    expect(decodeGuid(encodeGuid(GPT_EFI_SYSTEM))).toBe(GPT_EFI_SYSTEM)
  })

  it('reads the primary table when it is intact', async () => {
    const table = await readGptTable(new BufferBlockReader(buildDisk()))

    expect(table).not.toBeNull()
    expect(table?.source).toBe('primary')
    expect(table?.usedBackup).toBe(false)
    expect(table?.header.headerCrcValid).toBe(true)
    expect(table?.header.entriesCrcValid).toBe(true)
    expect(table?.entries).toHaveLength(2)
    expect(table?.entries[0]?.name).toBe('EFI')
    expect(table?.entries[1]?.typeName).toBe('Basic data')
  })

  it('computes partition byte ranges inclusively of the end LBA', async () => {
    const table = await readGptTable(new BufferBlockReader(buildDisk()))
    const efi = table?.entries[0]

    expect(efi?.offsetBytes).toBe(34 * SECTOR)
    // 34..1057 inclusive is 1024 sectors.
    expect(efi?.sizeBytes).toBe(1024 * SECTOR)
  })

  it('falls back to the backup header when the primary is damaged', async () => {
    const image = blankDisk(4096)
    writeGpt(image, [{ typeGuid: GPT_BASIC_DATA, startLba: 34, endLba: 2000, name: 'Data' }], {
      damagePrimaryHeader: true,
    })

    const table = await readGptTable(new BufferBlockReader(image))

    expect(table?.usedBackup).toBe(true)
    expect(table?.source).toBe('backup')
    expect(table?.entries).toHaveLength(1)
    expect(table?.warnings.some((warning) => warning.includes('primary'))).toBe(true)
  })

  it('reports an entry-array checksum failure', async () => {
    const image = blankDisk(4096)
    writeGpt(image, [{ typeGuid: GPT_BASIC_DATA, startLba: 34, endLba: 2000 }], {
      damageEntries: true,
    })

    const table = await readGptTable(new BufferBlockReader(image))

    // The primary header is intact but its entry array no longer matches.
    expect(table?.header.entriesCrcValid).toBe(false)
    expect(table?.warnings.some((warning) => warning.includes('checksum'))).toBe(true)
  })

  it('returns null when neither header carries a signature', async () => {
    expect(await readGptTable(new BufferBlockReader(blankDisk(1024)))).toBeNull()
  })

  it('skips unused entry slots', async () => {
    const table = await readGptTable(new BufferBlockReader(buildDisk()))

    // 128 slots exist; only two are populated.
    expect(table?.header.partitionEntryCount).toBe(128)
    expect(table?.entries).toHaveLength(2)
  })

  it('names known partition types', () => {
    expect(describeGptType(GPT_EFI_SYSTEM)).toBe('EFI System')
    expect(describeGptType('00000000-1111-2222-3333-444444444444')).toBe('Unknown partition type')
  })
})

describe('filesystem identification', () => {
  const withBootSector = (writer: (image: Buffer) => void): Buffer => {
    const image = blankDisk(256)
    writer(image)
    return image
  }

  it('identifies NTFS and reads its geometry', () => {
    const image = withBootSector((buffer) =>
      writeNtfsBootSector(buffer, 0, { sectorsPerCluster: 8, totalSectors: 4096 }),
    )
    const probe = identifyFilesystem(image)

    expect(probe.fileSystem).toBe('ntfs')
    expect(probe.clusterSizeBytes).toBe(4096)
    expect(probe.volumeSizeBytes).toBe(4096 * SECTOR)
    expect(probe.confidence).toBe('strong')
  })

  it('identifies exFAT from its shift-encoded geometry', () => {
    const probe = identifyFilesystem(
      withBootSector((buffer) => writeExfatBootSector(buffer, 0, 8192)),
    )

    expect(probe.fileSystem).toBe('exfat')
    expect(probe.clusterSizeBytes).toBe(4096)
  })

  it('identifies FAT32 and reads its label', () => {
    const probe = identifyFilesystem(
      withBootSector((buffer) => writeFat32BootSector(buffer, 0, { label: 'PHOTOS' })),
    )

    expect(probe.fileSystem).toBe('fat32')
    expect(probe.label).toBe('PHOTOS')
  })

  it('treats the NO NAME placeholder as no label', () => {
    const probe = identifyFilesystem(
      withBootSector((buffer) => writeFat32BootSector(buffer, 0, { label: 'NO NAME' })),
    )

    expect(probe.label).toBeNull()
  })

  it('preserves internal spaces in a label', () => {
    const probe = identifyFilesystem(
      withBootSector((buffer) => writeFat32BootSector(buffer, 0, { label: 'MY DISK' })),
    )

    expect(probe.label).toBe('MY DISK')
  })

  it('identifies FAT16', () => {
    const probe = identifyFilesystem(
      withBootSector((buffer) => writeFat16BootSector(buffer, 0, { label: 'BACKUP' })),
    )

    expect(probe.fileSystem).toBe('fat16')
    expect(probe.label).toBe('BACKUP')
  })

  it('distinguishes ext2, ext3 and ext4 by feature flags', () => {
    const build = (options: Parameters<typeof writeExtSuperblock>[2]): Buffer => {
      const image = blankDisk(256)
      writeExtSuperblock(image, 0, options)
      return image
    }

    expect(identifyFilesystem(build({})).fileSystem).toBe('ext2')
    expect(identifyFilesystem(build({ hasJournal: true })).fileSystem).toBe('ext3')
    expect(identifyFilesystem(build({ hasJournal: true, hasExtents: true })).fileSystem).toBe(
      'ext4',
    )
  })

  it('reads an ext label', () => {
    const image = blankDisk(256)
    writeExtSuperblock(image, 0, { label: 'rootfs' })

    expect(identifyFilesystem(image).label).toBe('rootfs')
  })

  it('reports unknown for unrecognised data rather than guessing', () => {
    expect(identifyFilesystem(Buffer.alloc(4096)).fileSystem).toBe('unknown')
    expect(identifyFilesystem(Buffer.alloc(16)).fileSystem).toBe('unknown')
  })

  it('does not mistake NTFS for FAT', () => {
    // Both use the same BPB layout, so ordering in the detector matters.
    const probe = identifyFilesystem(withBootSector((buffer) => writeNtfsBootSector(buffer, 0)))
    expect(probe.fileSystem).toBe('ntfs')
  })
})

describe('readPartitionTable', () => {
  it('reads an MBR disk and probes each partition filesystem', async () => {
    const image = blankDisk(8192)
    const firstStart = 2048
    const secondStart = 5120

    writeMbr(image, [
      { type: 0x07, startLba: firstStart, sectorCount: 2048, bootable: true },
      { type: 0x0c, startLba: secondStart, sectorCount: 2048 },
    ])
    writeNtfsBootSector(image, firstStart * SECTOR)
    writeFat32BootSector(image, secondStart * SECTOR, { label: 'MEDIA' })

    const result = await readPartitionTable(new BufferBlockReader(image), 'disk0')

    expect(result.style).toBe('mbr')
    expect(result.partitions).toHaveLength(2)
    expect(result.partitions[0]?.fileSystem).toBe('ntfs')
    expect(result.partitions[0]?.id).toBe('disk0:p1')
    expect(result.partitions[1]?.fileSystem).toBe('fat32')
    expect(result.partitions[1]?.label).toBe('MEDIA')
  })

  it('reads a GPT disk and prefers the filesystem label over the GPT name', async () => {
    const image = blankDisk(8192)
    const start = 2048

    writeGpt(image, [
      { typeGuid: GPT_BASIC_DATA, startLba: start, endLba: start + 2047, name: 'GPT name' },
    ])
    writeFat32BootSector(image, start * SECTOR, { label: 'REAL' })

    const result = await readPartitionTable(new BufferBlockReader(image), 'disk1')

    expect(result.style).toBe('gpt')
    // The GPT name is set by the partitioning tool; the label by the user.
    expect(result.partitions[0]?.label).toBe('REAL')
  })

  it('marks a disk read from the backup GPT as damaged', async () => {
    const image = blankDisk(8192)
    writeGpt(image, [{ typeGuid: GPT_BASIC_DATA, startLba: 2048, endLba: 4095 }], {
      damagePrimaryHeader: true,
    })

    const result = await readPartitionTable(new BufferBlockReader(image), 'disk0')

    expect(result.isDamaged).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('backup'))).toBe(true)
  })

  it('detects a filesystem written directly to sector 0, with no table', async () => {
    // The "superfloppy" layout used by cameras, phones and USB sticks.
    const image = blankDisk(4096)
    writeFat32BootSector(image, 0, { label: 'CAMERA' })

    const result = await readPartitionTable(new BufferBlockReader(image), 'disk2')

    expect(result.style).toBe('raw')
    expect(result.partitions).toHaveLength(1)
    expect(result.partitions[0]?.fileSystem).toBe('fat32')
    expect(result.partitions[0]?.offsetBytes).toBe(0)
  })

  it('reports a blank device as unknown, with the whole span unallocated', async () => {
    const result = await readPartitionTable(new BufferBlockReader(blankDisk(4096)), 'disk3')

    expect(result.style).toBe('unknown')
    expect(result.partitions).toHaveLength(0)
    expect(result.isDamaged).toBe(true)
    expect(result.unallocated[0]?.sizeBytes).toBe(4096 * SECTOR)
  })

  it('still reports a partition whose filesystem cannot be identified', async () => {
    // This is exactly the partition a user is trying to recover; hiding it
    // would remove the only route to its data.
    const image = blankDisk(8192)
    writeMbr(image, [{ type: 0x07, startLba: 2048, sectorCount: 2048 }])

    const result = await readPartitionTable(new BufferBlockReader(image), 'disk0')

    expect(result.partitions).toHaveLength(1)
    expect(result.partitions[0]?.fileSystem).toBe('unknown')
  })
})

describe('computeUnallocated', () => {
  const partition = (offsetBytes: number, sizeBytes: number) => ({
    id: 'x',
    deviceId: 'disk0',
    index: 1,
    offsetBytes,
    sizeBytes,
    fileSystem: 'ntfs' as const,
    label: null,
    driveLetter: null,
    typeCode: '0x07',
    typeName: 'NTFS',
    isBootable: false,
    isHidden: false,
    isRecovered: false,
    freeBytes: null,
  })

  it('finds a gap between two partitions', () => {
    const gaps = computeUnallocated(
      [partition(0, 100 * MIB), partition(300 * MIB, 100 * MIB)],
      1000 * MIB,
    )

    expect(gaps[0]).toEqual({ offsetBytes: 100 * MIB, sizeBytes: 200 * MIB })
  })

  it('reports the tail of the device', () => {
    const gaps = computeUnallocated([partition(0, 100 * MIB)], 500 * MIB)

    expect(gaps.at(-1)?.offsetBytes).toBe(100 * MIB)
  })

  it('ignores alignment padding smaller than a megabyte', () => {
    // The few sectors between aligned partitions are not recoverable space.
    const gaps = computeUnallocated(
      [partition(0, 100 * MIB), partition(100 * MIB + 4096, 100 * MIB)],
      201 * MIB,
    )

    expect(gaps.some((gap) => gap.sizeBytes === 4096)).toBe(false)
  })

  it('handles overlapping entries from a damaged table without producing negatives', () => {
    const gaps = computeUnallocated(
      [partition(0, 200 * MIB), partition(100 * MIB, 200 * MIB)],
      400 * MIB,
    )

    expect(gaps.every((gap) => gap.sizeBytes > 0)).toBe(true)
  })

  it('returns nothing for a fully allocated device', () => {
    expect(computeUnallocated([partition(0, 100 * MIB)], 100 * MIB)).toEqual([])
  })
})

describe('device classification', () => {
  it('maps CIM enumerations', () => {
    expect(mapBusType(7)).toBe('usb')
    expect(mapBusType(17)).toBe('nvme')
    expect(mapBusType(999)).toBe('unknown')
    expect(mapMediaType(4)).toBe('ssd')
    expect(mapPartitionStyle(2)).toBe('gpt')
    expect(mapHealthStatus(1)).toBe('warning')
  })

  it('distinguishes a USB flash drive from a USB SSD', () => {
    // A USB SSD reports its media type honestly; a flash stick does not.
    expect(classifyDevice('usb', 'unspecified', true)).toBe('usb-flash')
    expect(classifyDevice('usb', 'ssd', true)).toBe('external-ssd')
    expect(classifyDevice('usb', 'hdd', true)).toBe('external-hdd')
  })

  it('classifies card readers and internal drives', () => {
    expect(classifyDevice('sd', 'unspecified', true)).toBe('sd-card')
    expect(classifyDevice('mmc', 'unspecified', true)).toBe('micro-sd')
    expect(classifyDevice('nvme', 'ssd', false)).toBe('nvme')
    expect(classifyDevice('sata', 'hdd', false)).toBe('hard-disk')
    expect(classifyDevice('sata', 'ssd', false)).toBe('ssd')
    expect(classifyDevice('virtual', 'unspecified', false)).toBe('virtual-disk')
  })

  it('builds the Windows raw device path', () => {
    expect(physicalDrivePath(0)).toBe('\\\\.\\PhysicalDrive0')
    expect(physicalDrivePath(3)).toBe('\\\\.\\PhysicalDrive3')
  })
})

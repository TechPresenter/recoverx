import { crc32 } from '@main/disk/crc32'

/**
 * Synthetic disk-image builders for the parser suites.
 *
 * Real disks are a poor test substrate: they cannot be checked into a repo, the
 * interesting states (a wiped GPT header, a looping EBR chain, a truncated
 * entry array) are exactly the ones nobody has lying around, and any test using
 * them needs elevation. Constructing images byte by byte gives deterministic
 * coverage of both the healthy and the damaged paths.
 */

export const SECTOR = 512

/** Allocate a zeroed disk image of `sectors` sectors. */
export function blankDisk(sectors: number): Buffer {
  return Buffer.alloc(sectors * SECTOR)
}

// --- MBR -------------------------------------------------------------------

export interface MbrPartitionSpec {
  readonly type: number
  readonly startLba: number
  readonly sectorCount: number
  readonly bootable?: boolean
}

/** Write an MBR (or an EBR) into `image` at `atLba`. */
export function writeMbr(
  image: Buffer,
  partitions: readonly MbrPartitionSpec[],
  atLba = 0,
  diskSignature = 0x12345678,
): void {
  const base = atLba * SECTOR

  image.writeUInt32LE(diskSignature, base + 0x1b8)

  partitions.slice(0, 4).forEach((partition, slot) => {
    const offset = base + 0x1be + slot * 16

    image.writeUInt8(partition.bootable === true ? 0x80 : 0x00, offset)
    // CHS fields are left zero: every parser in use has been LBA-only for two
    // decades, and a wrong CHS value is what a real disk often carries anyway.
    image.writeUInt8(partition.type, offset + 4)
    image.writeUInt32LE(partition.startLba, offset + 8)
    image.writeUInt32LE(partition.sectorCount, offset + 12)
  })

  image.writeUInt8(0x55, base + 0x1fe)
  image.writeUInt8(0xaa, base + 0x1ff)
}

// --- GPT -------------------------------------------------------------------

export interface GptPartitionSpec {
  readonly typeGuid: string
  readonly startLba: number
  readonly endLba: number
  readonly name?: string
  readonly attributes?: bigint
}

export const GPT_BASIC_DATA = 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7'
export const GPT_EFI_SYSTEM = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'

/**
 * Encode a GUID into GPT's mixed-endian layout.
 *
 * The first three fields are little-endian and the last two big-endian. This
 * mirrors `decodeGuid`, so a round-trip through both is a real test of the
 * encoding rather than of a shared mistake.
 */
export function encodeGuid(guid: string): Buffer {
  const clean = guid.replace(/-/gu, '')
  const bytes = Buffer.from(clean, 'hex')

  const out = Buffer.alloc(16)
  Buffer.from(bytes.subarray(0, 4)).reverse().copy(out, 0)
  Buffer.from(bytes.subarray(4, 6)).reverse().copy(out, 4)
  Buffer.from(bytes.subarray(6, 8)).reverse().copy(out, 6)
  bytes.subarray(8, 16).copy(out, 8)

  return out
}

export interface GptOptions {
  /** Corrupt the primary header's CRC, forcing a fallback to the backup. */
  readonly damagePrimaryHeader?: boolean
  /** Corrupt the entry array after computing the CRC. */
  readonly damageEntries?: boolean
  /** Omit the backup header entirely. */
  readonly omitBackup?: boolean
}

/**
 * Write a complete GPT — protective MBR, primary header, entry array and
 * backup header — into `image`.
 */
export function writeGpt(
  image: Buffer,
  partitions: readonly GptPartitionSpec[],
  options: GptOptions = {},
): void {
  const totalSectors = Math.floor(image.length / SECTOR)
  const lastLba = totalSectors - 1

  const entryCount = 128
  const entrySize = 128
  const entryArrayLba = 2
  const entryArraySectors = (entryCount * entrySize) / SECTOR

  // Protective MBR — one 0xEE entry spanning the disk.
  writeMbr(image, [
    { type: 0xee, startLba: 1, sectorCount: Math.min(totalSectors - 1, 0xffffffff) },
  ])

  const entries = Buffer.alloc(entryCount * entrySize)

  partitions.forEach((partition, index) => {
    const offset = index * entrySize

    encodeGuid(partition.typeGuid).copy(entries, offset)
    encodeGuid(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`).copy(
      entries,
      offset + 16,
    )
    entries.writeBigUInt64LE(BigInt(partition.startLba), offset + 32)
    entries.writeBigUInt64LE(BigInt(partition.endLba), offset + 40)
    entries.writeBigUInt64LE(partition.attributes ?? 0n, offset + 48)

    if (partition.name !== undefined) {
      const encoded = Buffer.from(partition.name, 'utf16le')
      encoded.copy(entries, offset + 56, 0, Math.min(encoded.length, 72))
    }
  })

  entries.copy(image, entryArrayLba * SECTOR)

  const entriesCrc = crc32(entries)

  const writeHeader = (
    atLba: number,
    currentLba: number,
    backupLba: number,
    arrayLba: number,
  ): void => {
    const header = Buffer.alloc(SECTOR)

    header.write('EFI PART', 0, 'latin1')
    header.writeUInt32LE(0x00010000, 8)
    header.writeUInt32LE(92, 12)
    header.writeUInt32LE(0, 16) // CRC placeholder
    header.writeUInt32LE(0, 20)
    header.writeBigUInt64LE(BigInt(currentLba), 24)
    header.writeBigUInt64LE(BigInt(backupLba), 32)
    header.writeBigUInt64LE(BigInt(entryArrayLba + entryArraySectors), 40)
    header.writeBigUInt64LE(BigInt(lastLba - entryArraySectors - 1), 48)
    encodeGuid('0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e').copy(header, 56)
    header.writeBigUInt64LE(BigInt(arrayLba), 72)
    header.writeUInt32LE(entryCount, 80)
    header.writeUInt32LE(entrySize, 84)
    header.writeUInt32LE(entriesCrc, 88)

    header.writeUInt32LE(crc32(header.subarray(0, 92)), 16)
    header.copy(image, atLba * SECTOR)
  }

  writeHeader(1, 1, lastLba, entryArrayLba)

  if (options.omitBackup !== true) {
    // The backup's entry array conventionally sits just below the header.
    const backupArrayLba = lastLba - entryArraySectors
    entries.copy(image, backupArrayLba * SECTOR)
    writeHeader(lastLba, lastLba, 1, backupArrayLba)
  }

  if (options.damagePrimaryHeader === true) {
    // Flip a byte the CRC covers, without destroying the signature — this is
    // what a partially-overwritten header looks like.
    image.writeUInt32LE(0xdeadbeef, SECTOR + 24)
  }

  if (options.damageEntries === true) {
    image.writeUInt32LE(0xdeadbeef, entryArrayLba * SECTOR + 8)
  }
}

// --- Boot sectors ----------------------------------------------------------

export function writeNtfsBootSector(
  image: Buffer,
  atByte: number,
  options: { sectorsPerCluster?: number; totalSectors?: number } = {},
): void {
  const sector = Buffer.alloc(SECTOR)

  sector.writeUInt8(0xeb, 0)
  sector.writeUInt8(0x52, 1)
  sector.writeUInt8(0x90, 2)
  sector.write('NTFS    ', 3, 'latin1')
  sector.writeUInt16LE(SECTOR, 0x0b)
  sector.writeUInt8(options.sectorsPerCluster ?? 8, 0x0d)
  sector.writeBigUInt64LE(BigInt(options.totalSectors ?? 2048), 0x28)
  sector.writeBigUInt64LE(4n, 0x30) // $MFT cluster
  sector.writeUInt8(0x55, 0x1fe)
  sector.writeUInt8(0xaa, 0x1ff)

  sector.copy(image, atByte)
}

export function writeFat32BootSector(
  image: Buffer,
  atByte: number,
  options: { label?: string; totalSectors?: number; sectorsPerCluster?: number } = {},
): void {
  const sector = Buffer.alloc(SECTOR)

  sector.write('MSDOS5.0', 3, 'latin1')
  sector.writeUInt16LE(SECTOR, 0x0b)
  sector.writeUInt8(options.sectorsPerCluster ?? 8, 0x0d)
  sector.writeUInt16LE(32, 0x0e)
  sector.writeUInt8(2, 0x10)
  sector.writeUInt32LE(options.totalSectors ?? 4096, 0x20)
  sector.write((options.label ?? 'NO NAME').padEnd(11, ' '), 0x47, 'latin1')
  sector.write('FAT32   ', 0x52, 'latin1')
  sector.writeUInt8(0x55, 0x1fe)
  sector.writeUInt8(0xaa, 0x1ff)

  sector.copy(image, atByte)
}

export function writeFat16BootSector(
  image: Buffer,
  atByte: number,
  options: { label?: string; totalSectors?: number } = {},
): void {
  const sector = Buffer.alloc(SECTOR)

  sector.write('MSDOS5.0', 3, 'latin1')
  sector.writeUInt16LE(SECTOR, 0x0b)
  sector.writeUInt8(4, 0x0d)
  sector.writeUInt16LE(1, 0x0e)
  sector.writeUInt8(2, 0x10)
  sector.writeUInt16LE(512, 0x11)
  sector.writeUInt16LE(options.totalSectors ?? 2048, 0x13)
  sector.writeUInt16LE(20, 0x16)
  sector.write((options.label ?? 'DATA').padEnd(11, ' '), 0x2b, 'latin1')
  sector.write('FAT16   ', 0x36, 'latin1')
  sector.writeUInt8(0x55, 0x1fe)
  sector.writeUInt8(0xaa, 0x1ff)

  sector.copy(image, atByte)
}

export function writeExfatBootSector(image: Buffer, atByte: number, volumeSectors = 8192): void {
  const sector = Buffer.alloc(SECTOR)

  sector.write('EXFAT   ', 3, 'latin1')
  sector.writeBigUInt64LE(BigInt(volumeSectors), 0x48)
  sector.writeUInt8(9, 0x6c) // 2^9 = 512-byte sectors
  sector.writeUInt8(3, 0x6d) // 2^3 = 8 sectors per cluster
  sector.writeUInt8(0x55, 0x1fe)
  sector.writeUInt8(0xaa, 0x1ff)

  sector.copy(image, atByte)
}

export interface ExtOptions {
  readonly label?: string
  readonly blockCount?: number
  readonly hasJournal?: boolean
  readonly hasExtents?: boolean
}

export function writeExtSuperblock(image: Buffer, atByte: number, options: ExtOptions = {}): void {
  const base = atByte + 1024

  image.writeUInt32LE(options.blockCount ?? 4096, base + 0x04)
  image.writeUInt32LE(0, base + 0x18) // 1024 << 0 = 1 KiB blocks
  image.writeUInt16LE(0xef53, base + 0x38)
  image.writeUInt32LE(options.hasJournal === true ? 0x4 : 0, base + 0x5c)
  image.writeUInt32LE(options.hasExtents === true ? 0x40 : 0, base + 0x60)
  image.writeUInt32LE(0, base + 0x64)
  image.write((options.label ?? '').padEnd(16, '\0'), base + 0x78, 'latin1')
}

// --- Whole volumes, including their backup headers -------------------------

/*
 * The helpers above write a single boot sector, which is all the partition
 * table tests need. Lost-partition recovery instead depends on the *second*
 * copy each of these filesystems keeps, because two agreeing copies are what
 * separate a real volume from a run of bytes that merely looks like one. These
 * builders lay down both.
 */

/**
 * An NTFS volume with its backup boot sector.
 *
 * The BPB's sector count excludes the backup, which lives in the sector
 * immediately after the counted ones — so a volume of `totalSectors` occupies
 * `totalSectors + 1` sectors on the disk.
 */
export function writeNtfsVolume(
  image: Buffer,
  atByte: number,
  totalSectors: number,
  options: { sectorsPerCluster?: number; backup?: boolean } = {},
): void {
  writeNtfsBootSector(image, atByte, {
    totalSectors,
    ...(options.sectorsPerCluster === undefined
      ? {}
      : { sectorsPerCluster: options.sectorsPerCluster }),
  })

  if (options.backup === false) return

  const backupAt = atByte + totalSectors * SECTOR
  image.copy(image, backupAt, atByte, atByte + SECTOR)
}

/** A FAT32 volume whose reserved region holds the backup at sector 6. */
export function writeFat32Volume(
  image: Buffer,
  atByte: number,
  totalSectors: number,
  options: { label?: string; backup?: boolean } = {},
): void {
  writeFat32BootSector(image, atByte, {
    totalSectors,
    ...(options.label === undefined ? {} : { label: options.label }),
  })

  // BPB_BkBootSec. The base fixture leaves it zero, which means "no backup".
  image.writeUInt16LE(6, atByte + 0x32)

  if (options.backup === false) return

  image.copy(image, atByte + 6 * SECTOR, atByte, atByte + SECTOR)
}

/** An exFAT volume with the backup VBR the specification fixes at sector 12. */
export function writeExfatVolume(
  image: Buffer,
  atByte: number,
  volumeSectors: number,
  options: { backup?: boolean } = {},
): void {
  writeExfatBootSector(image, atByte, volumeSectors)

  if (options.backup === false) return

  image.copy(image, atByte + 12 * SECTOR, atByte, atByte + SECTOR)
}

import type { FileSystem } from '@shared/types/disk'
import type { BlockReader } from './block-device'

/**
 * Filesystem identification from on-disk structures.
 *
 * Identification is done by reading the filesystem's own boot sector or
 * superblock, never by trusting the partition table's type code. Those two
 * disagree constantly in practice — a partition formatted NTFS may still carry
 * the FAT32 type byte from a previous life — and after the kind of damage this
 * product exists to repair, the partition table is often the *less* reliable of
 * the two.
 *
 * The same detector is later run across unallocated space to find the boot
 * sectors of partitions that no longer appear in any table.
 */

export interface FilesystemProbe {
  readonly fileSystem: FileSystem
  /** Volume label, when the filesystem stores one somewhere cheap to read. */
  readonly label: string | null
  /** Bytes per cluster / block, when determinable from the header. */
  readonly clusterSizeBytes: number | null
  /** Total size the filesystem believes it occupies, in bytes. */
  readonly volumeSizeBytes: number | null
  /**
   * Confidence in the identification.
   *
   * `strong` means a magic value matched at a defined offset. `weak` means the
   * structure is plausible but unverified — used when reconstructing partitions
   * from carved boot sectors.
   */
  readonly confidence: 'strong' | 'weak'
}

const UNKNOWN: FilesystemProbe = {
  fileSystem: 'unknown',
  label: null,
  clusterSizeBytes: null,
  volumeSizeBytes: null,
  confidence: 'weak',
}

/** Bytes to read from the start of a volume to cover every checked signature. */
const PROBE_LENGTH = 0x10100

/**
 * Identify the filesystem at the start of `reader`.
 *
 * Never throws: an unreadable or unrecognised region is reported as `unknown`,
 * which the scanner treats as "carve it anyway".
 */
export async function probeFilesystem(reader: BlockReader): Promise<FilesystemProbe> {
  let header: Buffer
  try {
    header = await reader.read(0, Math.min(PROBE_LENGTH, reader.sizeBytes))
  } catch {
    return UNKNOWN
  }

  return identifyFilesystem(header)
}

/**
 * Identify a filesystem from a buffer holding the first ~64 KiB of a volume.
 *
 * Split out from `probeFilesystem` so it can be exercised directly against
 * synthetic images.
 */
export function identifyFilesystem(header: Buffer): FilesystemProbe {
  if (header.length < 512) return UNKNOWN

  // Order matters. NTFS and exFAT both live in the FAT-style BPB layout, so
  // their explicit OEM strings must be checked before the FAT heuristics.
  return (
    detectNtfs(header) ??
    detectExfat(header) ??
    detectRefs(header) ??
    detectFat(header) ??
    detectExt(header) ??
    detectXfs(header) ??
    detectBtrfs(header) ??
    detectApfs(header) ??
    detectHfsPlus(header) ??
    detectIso9660(header) ??
    detectSwap(header) ??
    UNKNOWN
  )
}

// --- Windows filesystems ---------------------------------------------------

function detectNtfs(header: Buffer): FilesystemProbe | null {
  if (ascii(header, 3, 8) !== 'NTFS    ') return null

  const bytesPerSector = header.readUInt16LE(0x0b)
  const sectorsPerCluster = header.readUInt8(0x0d)
  const totalSectors = Number(header.readBigUInt64LE(0x28))

  return {
    fileSystem: 'ntfs',
    // The NTFS label lives in the $Volume MFT record, not the boot sector.
    label: null,
    clusterSizeBytes: validCluster(bytesPerSector, sectorsPerCluster),
    volumeSizeBytes: totalSectors > 0 ? totalSectors * bytesPerSector : null,
    confidence: 'strong',
  }
}

function detectExfat(header: Buffer): FilesystemProbe | null {
  if (ascii(header, 3, 8) !== 'EXFAT   ') return null

  const bytesPerSectorShift = header.readUInt8(0x6c)
  const sectorsPerClusterShift = header.readUInt8(0x6d)
  const volumeLength = Number(header.readBigUInt64LE(0x48))

  const bytesPerSector = bytesPerSectorShift <= 12 ? 1 << bytesPerSectorShift : 0
  const sectorsPerCluster = sectorsPerClusterShift <= 25 ? 1 << sectorsPerClusterShift : 0

  return {
    fileSystem: 'exfat',
    // The exFAT label is a directory entry in the root, not a header field.
    label: null,
    clusterSizeBytes: validCluster(bytesPerSector, sectorsPerCluster),
    volumeSizeBytes: volumeLength > 0 && bytesPerSector > 0 ? volumeLength * bytesPerSector : null,
    confidence: 'strong',
  }
}

function detectRefs(header: Buffer): FilesystemProbe | null {
  if (ascii(header, 3, 4) !== 'ReFS') return null

  return {
    fileSystem: 'refs',
    label: null,
    // ReFS geometry is not in the boot sector; it lives in the object table.
    clusterSizeBytes: null,
    volumeSizeBytes: null,
    confidence: 'strong',
  }
}

/**
 * FAT12 / FAT16 / FAT32.
 *
 * The version string sits at a different offset for FAT32 than for FAT12/16,
 * because FAT32 extended its BPB and pushed the extended boot record down.
 */
function detectFat(header: Buffer): FilesystemProbe | null {
  const fat32Type = ascii(header, 0x52, 8)
  const fat16Type = ascii(header, 0x36, 8)

  const bytesPerSector = header.readUInt16LE(0x0b)
  const sectorsPerCluster = header.readUInt8(0x0d)

  if (fat32Type === 'FAT32   ') {
    const totalSectors = header.readUInt32LE(0x20)
    return {
      fileSystem: 'fat32',
      label: trimLabel(ascii(header, 0x47, 11)),
      clusterSizeBytes: validCluster(bytesPerSector, sectorsPerCluster),
      volumeSizeBytes: totalSectors > 0 ? totalSectors * bytesPerSector : null,
      confidence: 'strong',
    }
  }

  if (fat16Type === 'FAT16   ' || fat16Type === 'FAT12   ' || fat16Type === 'FAT     ') {
    const totalSectors16 = header.readUInt16LE(0x13)
    const totalSectors32 = header.readUInt32LE(0x20)
    const totalSectors = totalSectors16 > 0 ? totalSectors16 : totalSectors32

    // A "FAT     " label is ambiguous by design; cluster count is what actually
    // separates FAT12 from FAT16, and 4085 is the boundary in the spec.
    const fileSystem: FileSystem =
      fat16Type === 'FAT12   '
        ? 'fat12'
        : fat16Type === 'FAT16   '
          ? 'fat16'
          : estimateFatWidth(header, totalSectors, bytesPerSector, sectorsPerCluster)

    return {
      fileSystem,
      label: trimLabel(ascii(header, 0x2b, 11)),
      clusterSizeBytes: validCluster(bytesPerSector, sectorsPerCluster),
      volumeSizeBytes: totalSectors > 0 ? totalSectors * bytesPerSector : null,
      confidence: 'strong',
    }
  }

  return null
}

function estimateFatWidth(
  header: Buffer,
  totalSectors: number,
  bytesPerSector: number,
  sectorsPerCluster: number,
): FileSystem {
  if (bytesPerSector === 0 || sectorsPerCluster === 0) return 'fat16'

  const reservedSectors = header.readUInt16LE(0x0e)
  const fatCount = header.readUInt8(0x10)
  const rootEntries = header.readUInt16LE(0x11)
  const sectorsPerFat = header.readUInt16LE(0x16)

  const rootDirSectors = Math.ceil((rootEntries * 32) / bytesPerSector)
  const dataSectors = totalSectors - (reservedSectors + fatCount * sectorsPerFat + rootDirSectors)
  const clusterCount = Math.floor(dataSectors / sectorsPerCluster)

  return clusterCount < 4085 ? 'fat12' : 'fat16'
}

// --- Linux filesystems -----------------------------------------------------

/** The ext superblock sits 1024 bytes into the volume, regardless of block size. */
const EXT_SUPERBLOCK_OFFSET = 1024

function detectExt(header: Buffer): FilesystemProbe | null {
  const base = EXT_SUPERBLOCK_OFFSET
  if (header.length < base + 0x100) return null
  if (header.readUInt16LE(base + 0x38) !== 0xef53) return null

  const logBlockSize = header.readUInt32LE(base + 0x18)
  const blockSize = 1024 << logBlockSize
  const blockCount = header.readUInt32LE(base + 0x04)

  const featureCompat = header.readUInt32LE(base + 0x5c)
  const featureIncompat = header.readUInt32LE(base + 0x60)
  const featureRoCompat = header.readUInt32LE(base + 0x64)

  // EXTENTS (0x40) or 64BIT (0x80) in incompat, or any of the ext4-only
  // ro_compat bits, mean ext4. A journal alone means ext3.
  const isExt4 =
    (featureIncompat & 0x40) !== 0 ||
    (featureIncompat & 0x80) !== 0 ||
    (featureRoCompat & 0x8) !== 0
  const hasJournal = (featureCompat & 0x4) !== 0

  return {
    fileSystem: isExt4 ? 'ext4' : hasJournal ? 'ext3' : 'ext2',
    label: trimLabel(ascii(header, base + 0x78, 16)),
    clusterSizeBytes: blockSize > 0 && blockSize <= 65_536 ? blockSize : null,
    volumeSizeBytes: blockCount > 0 ? blockCount * blockSize : null,
    confidence: 'strong',
  }
}

function detectXfs(header: Buffer): FilesystemProbe | null {
  if (ascii(header, 0, 4) !== 'XFSB') return null

  const blockSize = header.readUInt32BE(0x04)
  const blockCount = Number(header.readBigUInt64BE(0x08))

  return {
    fileSystem: 'xfs',
    label: trimLabel(ascii(header, 0x6c, 12)),
    clusterSizeBytes: blockSize > 0 && blockSize <= 65_536 ? blockSize : null,
    volumeSizeBytes: blockCount > 0 ? blockCount * blockSize : null,
    confidence: 'strong',
  }
}

/** The Btrfs superblock is at a 64 KiB offset, with its magic 0x40 further in. */
const BTRFS_MAGIC_OFFSET = 0x10040

function detectBtrfs(header: Buffer): FilesystemProbe | null {
  if (header.length < BTRFS_MAGIC_OFFSET + 8) return null
  if (ascii(header, BTRFS_MAGIC_OFFSET, 8) !== '_BHRfS_M') return null

  const superblockBase = 0x10000
  const totalBytes = Number(header.readBigUInt64LE(superblockBase + 0x70))
  const sectorSize = header.readUInt32LE(superblockBase + 0x90)

  return {
    fileSystem: 'btrfs',
    label: trimLabel(ascii(header, superblockBase + 0x12b, 32)),
    clusterSizeBytes: sectorSize > 0 && sectorSize <= 65_536 ? sectorSize : null,
    volumeSizeBytes: totalBytes > 0 ? totalBytes : null,
    confidence: 'strong',
  }
}

// --- Apple filesystems -----------------------------------------------------

function detectApfs(header: Buffer): FilesystemProbe | null {
  // The APFS container superblock carries 'NXSB' at offset 32.
  if (ascii(header, 0x20, 4) !== 'NXSB') return null

  const blockSize = header.readUInt32LE(0x24)
  const blockCount = Number(header.readBigUInt64LE(0x28))

  return {
    fileSystem: 'apfs',
    // Volume names live in per-volume superblocks inside the container.
    label: null,
    clusterSizeBytes: blockSize > 0 && blockSize <= 65_536 ? blockSize : null,
    volumeSizeBytes: blockCount > 0 && blockSize > 0 ? blockCount * blockSize : null,
    confidence: 'strong',
  }
}

function detectHfsPlus(header: Buffer): FilesystemProbe | null {
  const base = 1024
  if (header.length < base + 0x50) return null

  const signature = ascii(header, base, 2)
  // 'H+' is HFS+; 'HX' is HFSX, which differs only in case sensitivity.
  if (signature !== 'H+' && signature !== 'HX') return null

  const blockSize = header.readUInt32BE(base + 0x28)
  const totalBlocks = header.readUInt32BE(base + 0x2c)

  return {
    fileSystem: 'hfs+',
    label: null,
    clusterSizeBytes: blockSize > 0 && blockSize <= 65_536 ? blockSize : null,
    volumeSizeBytes: totalBlocks > 0 ? totalBlocks * blockSize : null,
    confidence: 'strong',
  }
}

// --- Optical and other -----------------------------------------------------

function detectIso9660(header: Buffer): FilesystemProbe | null {
  // The primary volume descriptor starts at sector 16 of a 2048-byte medium.
  const base = 0x8000
  if (header.length < base + 8) return null
  if (ascii(header, base + 1, 5) !== 'CD001') return null

  return {
    fileSystem: 'iso9660',
    label: trimLabel(ascii(header, base + 40, 32)),
    clusterSizeBytes: 2048,
    volumeSizeBytes: null,
    confidence: 'strong',
  }
}

function detectSwap(header: Buffer): FilesystemProbe | null {
  const base = 0xff6
  if (header.length < base + 10) return null

  const magic = ascii(header, base, 10)
  if (magic !== 'SWAPSPACE2' && magic !== 'SWAP-SPACE') return null

  return {
    fileSystem: 'swap',
    label: null,
    clusterSizeBytes: null,
    volumeSizeBytes: null,
    confidence: 'strong',
  }
}

// --- helpers ---------------------------------------------------------------

function ascii(buffer: Buffer, offset: number, length: number): string {
  if (offset < 0 || offset + length > buffer.length) return ''
  return buffer.subarray(offset, offset + length).toString('latin1')
}

/**
 * Clean a fixed-width label field.
 *
 * On-disk label fields are padded with NULs or spaces to a fixed width. Only
 * that padding is removed: a label that legitimately contains spaces
 * ("Backup Drive") must survive intact, so stripping every space here would be
 * a data-fidelity bug rather than a tidy-up.
 */
function trimLabel(raw: string): string | null {
  // Matching the NUL padding that fixed-width on-disk label fields use is the
  // entire purpose of this expression.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/\u0000+/gu, '').trim()

  if (cleaned.length === 0) return null
  // The conventional placeholder Windows writes when no label is set.
  if (cleaned === 'NO NAME') return null

  return cleaned
}

/** Reject implausible geometry rather than reporting a nonsense cluster size. */
function validCluster(bytesPerSector: number, sectorsPerCluster: number): number | null {
  if (bytesPerSector < 512 || bytesPerSector > 8192) return null
  if (sectorsPerCluster < 1 || sectorsPerCluster > 128) return null

  return bytesPerSector * sectorsPerCluster
}

/**
 * exFAT on-disk structures.
 *
 * exFAT is the format on virtually every SD card and large USB stick, so it is
 * the one a camera or phone recovery actually depends on.
 *
 * It differs from FAT in a way that matters enormously here: a file's directory
 * information is spread across an *entry set* — a File entry, a Stream Extension
 * entry and one or more File Name entries, stored consecutively. All of them
 * survive deletion with only their in-use bit cleared, and the Stream entry
 * carries a `NoFatChain` flag stating whether the file was contiguous.
 *
 * That flag is the difference between guessing and knowing: a deleted exFAT file
 * marked contiguous can be recovered exactly, where the equivalent FAT file can
 * only be assumed.
 */

// --- Geometry --------------------------------------------------------------

export interface ExfatGeometry {
  readonly bytesPerSector: number
  readonly sectorsPerCluster: number
  readonly clusterSizeBytes: number
  /** Volume start, in sectors, as recorded in the boot sector. */
  readonly partitionOffsetSectors: number
  readonly volumeLengthSectors: number
  readonly fatOffsetSectors: number
  readonly fatLengthSectors: number
  readonly clusterHeapOffsetSectors: number
  readonly clusterCount: number
  readonly rootDirectoryCluster: number
  readonly fatCount: number
  readonly volumeSizeBytes: number
}

export function parseExfatBootSector(sector: Buffer): ExfatGeometry | null {
  if (sector.length < 512) return null
  if (sector.subarray(3, 11).toString('latin1') !== 'EXFAT   ') return null

  const bytesPerSectorShift = sector.readUInt8(0x6c)
  const sectorsPerClusterShift = sector.readUInt8(0x6d)

  // The specification bounds these shifts; a value outside them means the
  // field is damaged, and computing 2^200 from it would be worse than useless.
  if (bytesPerSectorShift < 9 || bytesPerSectorShift > 12) return null
  if (sectorsPerClusterShift > 25 - bytesPerSectorShift) return null

  const bytesPerSector = 1 << bytesPerSectorShift
  const sectorsPerCluster = 1 << sectorsPerClusterShift

  const volumeLengthSectors = Number(sector.readBigUInt64LE(0x48))
  const fatOffsetSectors = sector.readUInt32LE(0x50)
  const fatLengthSectors = sector.readUInt32LE(0x54)
  const clusterHeapOffsetSectors = sector.readUInt32LE(0x58)
  const clusterCount = sector.readUInt32LE(0x5c)
  const rootDirectoryCluster = sector.readUInt32LE(0x60)
  const fatCount = sector.readUInt8(0x6e)

  if (volumeLengthSectors === 0 || clusterCount === 0) return null
  if (rootDirectoryCluster < 2) return null
  if (fatOffsetSectors === 0 || clusterHeapOffsetSectors === 0) return null

  return {
    bytesPerSector,
    sectorsPerCluster,
    clusterSizeBytes: bytesPerSector * sectorsPerCluster,
    partitionOffsetSectors: Number(sector.readBigUInt64LE(0x40)),
    volumeLengthSectors,
    fatOffsetSectors,
    fatLengthSectors,
    clusterHeapOffsetSectors,
    clusterCount,
    rootDirectoryCluster,
    fatCount: fatCount === 0 ? 1 : fatCount,
    volumeSizeBytes: volumeLengthSectors * bytesPerSector,
  }
}

/** Byte offset of a cluster, relative to the volume start. */
export function exfatClusterToOffset(geometry: ExfatGeometry, cluster: number): number {
  const sector = geometry.clusterHeapOffsetSectors + (cluster - 2) * geometry.sectorsPerCluster
  return sector * geometry.bytesPerSector
}

/** Read a FAT entry. exFAT uses a 32-bit FAT, like FAT32 but without masking. */
export function readExfatFatEntry(fat: Buffer, cluster: number): number {
  const offset = cluster * 4
  if (offset < 0 || offset + 3 >= fat.length) return 0
  return fat.readUInt32LE(offset)
}

const EXFAT_END_OF_CHAIN = 0xfffffff8
const EXFAT_BAD_CLUSTER = 0xfffffff7

/** Follow a cluster chain, cycle-guarded. */
export function followExfatChain(
  fat: Buffer,
  geometry: ExfatGeometry,
  firstCluster: number,
  maxClusters = 1 << 20,
): number[] {
  if (firstCluster < 2 || firstCluster >= geometry.clusterCount + 2) return []

  const chain: number[] = []
  const visited = new Set<number>()
  let cluster = firstCluster

  while (chain.length < maxClusters) {
    if (visited.has(cluster)) break
    visited.add(cluster)
    chain.push(cluster)

    const next = readExfatFatEntry(fat, cluster)

    if (next >= EXFAT_END_OF_CHAIN || next === EXFAT_BAD_CLUSTER) break
    if (next < 2 || next >= geometry.clusterCount + 2) break

    cluster = next
  }

  return chain
}

// --- Directory entries -----------------------------------------------------

export const ExfatEntryType = {
  EndOfDirectory: 0x00,
  AllocationBitmap: 0x01,
  UpcaseTable: 0x02,
  VolumeLabel: 0x03,
  File: 0x05,
  StreamExtension: 0x40,
  FileName: 0x41,
} as const

export const EXFAT_ENTRY_SIZE = 32

/** Bit 7 of the type byte. Cleared on deletion, leaving the rest intact. */
const IN_USE_FLAG = 0x80

export const ExfatFileAttributes = {
  ReadOnly: 0x01,
  Hidden: 0x02,
  System: 0x04,
  Directory: 0x10,
  Archive: 0x20,
} as const

export interface ExfatDirectoryEntry {
  readonly name: string
  readonly isDeleted: boolean
  readonly isDirectory: boolean
  readonly attributes: number
  readonly firstCluster: number
  readonly sizeBytes: number
  /** Bytes actually written; the tail up to `sizeBytes` reads as zeroes. */
  readonly validSizeBytes: number
  /**
   * `true` when the file occupies consecutive clusters and has no FAT chain.
   *
   * For a deleted file this is decisive: contiguous means the data can be read
   * back exactly, rather than assumed.
   */
  readonly isContiguous: boolean
  readonly createdAt: number | null
  readonly modifiedAt: number | null
  readonly accessedAt: number | null
}

export interface ParsedExfatDirectory {
  readonly entries: readonly ExfatDirectoryEntry[]
  readonly reachedEnd: boolean
  /** Entry sets that were incomplete — a truncated or overwritten directory. */
  readonly incompleteSets: number
}

/**
 * Parse a buffer of exFAT directory entries.
 *
 * An entry set must be File → Stream → Name…; anything else means the directory
 * was partially overwritten. Those are counted rather than silently skipped,
 * because a high count is itself a signal about how damaged the volume is.
 */
export function parseExfatDirectory(buffer: Buffer): ParsedExfatDirectory {
  const entries: ExfatDirectoryEntry[] = []
  let reachedEnd = false
  let incompleteSets = 0

  let offset = 0

  while (offset + EXFAT_ENTRY_SIZE <= buffer.length) {
    const typeByte = buffer.readUInt8(offset)

    if (typeByte === ExfatEntryType.EndOfDirectory) {
      reachedEnd = true
      break
    }

    const entryType = typeByte & 0x7f
    const inUse = (typeByte & IN_USE_FLAG) !== 0

    if (entryType !== ExfatEntryType.File) {
      offset += EXFAT_ENTRY_SIZE
      continue
    }

    const parsed = parseEntrySet(buffer, offset, !inUse)

    if (parsed === null) {
      incompleteSets += 1
      offset += EXFAT_ENTRY_SIZE
      continue
    }

    entries.push(parsed.entry)
    offset += parsed.consumedBytes
  }

  return { entries, reachedEnd, incompleteSets }
}

interface EntrySetResult {
  readonly entry: ExfatDirectoryEntry
  readonly consumedBytes: number
}

function parseEntrySet(buffer: Buffer, offset: number, isDeleted: boolean): EntrySetResult | null {
  const secondaryCount = buffer.readUInt8(offset + 0x01)

  // A set is the File entry plus its secondaries; the count is bounded by the
  // format (one Stream plus at most 17 Name entries).
  if (secondaryCount < 1 || secondaryCount > 18) return null

  const totalBytes = (secondaryCount + 1) * EXFAT_ENTRY_SIZE
  if (offset + totalBytes > buffer.length) return null

  const attributes = buffer.readUInt16LE(offset + 0x04)

  const streamOffset = offset + EXFAT_ENTRY_SIZE
  if ((buffer.readUInt8(streamOffset) & 0x7f) !== ExfatEntryType.StreamExtension) return null

  const secondaryFlags = buffer.readUInt8(streamOffset + 0x01)
  const nameLength = buffer.readUInt8(streamOffset + 0x03)
  const validSizeBytes = Number(buffer.readBigUInt64LE(streamOffset + 0x08))
  const firstCluster = buffer.readUInt32LE(streamOffset + 0x14)
  const sizeBytes = Number(buffer.readBigUInt64LE(streamOffset + 0x18))

  // Bit 1 of the secondary flags: no FAT chain, i.e. contiguous allocation.
  const isContiguous = (secondaryFlags & 0x02) !== 0

  const name = readNameEntries(
    buffer,
    streamOffset + EXFAT_ENTRY_SIZE,
    secondaryCount - 1,
    nameLength,
  )
  if (name.length === 0) return null

  return {
    consumedBytes: totalBytes,
    entry: {
      name,
      isDeleted,
      isDirectory: (attributes & ExfatFileAttributes.Directory) !== 0,
      attributes,
      firstCluster,
      sizeBytes,
      validSizeBytes,
      isContiguous,
      createdAt: decodeExfatTimestamp(buffer.readUInt32LE(offset + 0x08)),
      modifiedAt: decodeExfatTimestamp(buffer.readUInt32LE(offset + 0x0c)),
      accessedAt: decodeExfatTimestamp(buffer.readUInt32LE(offset + 0x10)),
    },
  }
}

/** Concatenate the 15-character runs each File Name entry carries. */
function readNameEntries(
  buffer: Buffer,
  offset: number,
  entryCount: number,
  nameLength: number,
): string {
  const parts: Buffer[] = []

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = offset + index * EXFAT_ENTRY_SIZE
    if (entryOffset + EXFAT_ENTRY_SIZE > buffer.length) break
    if ((buffer.readUInt8(entryOffset) & 0x7f) !== ExfatEntryType.FileName) break

    parts.push(buffer.subarray(entryOffset + 0x02, entryOffset + EXFAT_ENTRY_SIZE))
  }

  if (parts.length === 0) return ''

  // `nameLength` is authoritative: the final entry is padded, and trusting the
  // padding instead would append stray characters to every long name.
  return Buffer.concat(parts).toString('utf16le').slice(0, nameLength)
}

/**
 * Decode an exFAT packed timestamp.
 *
 * Same bit layout as the DOS date/time pair, folded into one 32-bit word.
 */
export function decodeExfatTimestamp(value: number): number | null {
  if (value === 0) return null

  const seconds = (value & 0x1f) * 2
  const minutes = (value >> 5) & 0x3f
  const hours = (value >> 11) & 0x1f
  const day = (value >> 16) & 0x1f
  const month = (value >> 21) & 0x0f
  const year = 1980 + ((value >> 25) & 0x7f)

  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hours > 23 || minutes > 59 || seconds > 59) return null

  return Date.UTC(year, month - 1, day, hours, minutes, seconds)
}

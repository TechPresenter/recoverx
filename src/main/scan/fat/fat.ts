/**
 * FAT12 / FAT16 / FAT32 on-disk structures.
 *
 * A note that shapes the whole design: **deleting a file on FAT destroys its
 * cluster chain.** The directory entry survives with its first byte replaced by
 * `0xE5`, keeping the name, the size and the *first* cluster — but the FAT
 * entries linking the remaining clusters are zeroed.
 *
 * So a deleted FAT file can only be reconstructed by assuming it occupied
 * contiguous clusters from its first one. That assumption holds for the large
 * majority of files on flash media, which is written mostly sequentially, and
 * fails for fragmented files on a well-used volume. The scanner therefore
 * reports contiguity as an assumption in the recovery-quality score rather than
 * pretending the chain is known.
 */

// --- Geometry --------------------------------------------------------------

export type FatVariant = 'fat12' | 'fat16' | 'fat32'

export interface FatGeometry {
  readonly variant: FatVariant
  readonly bytesPerSector: number
  readonly sectorsPerCluster: number
  readonly clusterSizeBytes: number
  readonly reservedSectors: number
  readonly fatCount: number
  readonly sectorsPerFat: number
  readonly rootEntryCount: number
  /** Sectors occupied by the fixed root directory. Zero on FAT32. */
  readonly rootDirectorySectors: number
  readonly firstFatSector: number
  /** First sector of the fixed root directory. Zero on FAT32. */
  readonly firstRootDirectorySector: number
  readonly firstDataSector: number
  readonly totalSectors: number
  readonly clusterCount: number
  /** First cluster of the root directory. FAT32 only; zero otherwise. */
  readonly rootCluster: number
  readonly volumeLabel: string | null
}

/**
 * Parse a FAT boot sector.
 *
 * The variant is decided by cluster count, not by the label string. The
 * "FAT16"/"FAT32" text in the boot sector is documentation, not specification —
 * formatting tools write it inconsistently, and the count is what every driver
 * actually uses.
 */
export function parseFatBootSector(sector: Buffer): FatGeometry | null {
  if (sector.length < 512) return null

  const bytesPerSector = sector.readUInt16LE(0x0b)
  if (
    bytesPerSector < 512 ||
    bytesPerSector > 4096 ||
    (bytesPerSector & (bytesPerSector - 1)) !== 0
  ) {
    return null
  }

  const sectorsPerCluster = sector.readUInt8(0x0d)
  if (sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0) return null

  const reservedSectors = sector.readUInt16LE(0x0e)
  const fatCount = sector.readUInt8(0x10)
  const rootEntryCount = sector.readUInt16LE(0x11)
  const totalSectors16 = sector.readUInt16LE(0x13)
  const sectorsPerFat16 = sector.readUInt16LE(0x16)
  const totalSectors32 = sector.readUInt32LE(0x20)
  const sectorsPerFat32 = sector.readUInt32LE(0x24)

  if (reservedSectors === 0 || fatCount === 0 || fatCount > 4) return null

  const sectorsPerFat = sectorsPerFat16 !== 0 ? sectorsPerFat16 : sectorsPerFat32
  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32

  if (sectorsPerFat === 0 || totalSectors === 0) return null

  const rootDirectorySectors = Math.ceil((rootEntryCount * 32) / bytesPerSector)
  const firstDataSector = reservedSectors + fatCount * sectorsPerFat + rootDirectorySectors

  if (firstDataSector >= totalSectors) return null

  const clusterCount = Math.floor((totalSectors - firstDataSector) / sectorsPerCluster)
  if (clusterCount === 0) return null

  // The thresholds are defined by the specification, and the off-by-one either
  // side of them is the classic FAT bug: a volume with exactly 4085 clusters is
  // FAT16, not FAT12.
  const variant: FatVariant =
    clusterCount < 4085 ? 'fat12' : clusterCount < 65_525 ? 'fat16' : 'fat32'

  return {
    variant,
    bytesPerSector,
    sectorsPerCluster,
    clusterSizeBytes: bytesPerSector * sectorsPerCluster,
    reservedSectors,
    fatCount,
    sectorsPerFat,
    rootEntryCount,
    rootDirectorySectors,
    firstFatSector: reservedSectors,
    firstRootDirectorySector: variant === 'fat32' ? 0 : reservedSectors + fatCount * sectorsPerFat,
    firstDataSector,
    totalSectors,
    clusterCount,
    rootCluster: variant === 'fat32' ? sector.readUInt32LE(0x2c) : 0,
    volumeLabel: readLabel(sector, variant),
  }
}

function readLabel(sector: Buffer, variant: FatVariant): string | null {
  const offset = variant === 'fat32' ? 0x47 : 0x2b
  if (offset + 11 > sector.length) return null

  const raw = sector
    .subarray(offset, offset + 11)
    .toString('latin1')
    .trimEnd()

  return raw.length > 0 && raw !== 'NO NAME' ? raw : null
}

/** Byte offset of a cluster's first sector, relative to the volume start. */
export function clusterToOffset(geometry: FatGeometry, cluster: number): number {
  // Clusters are numbered from 2; 0 and 1 are reserved markers in the FAT.
  const sector = geometry.firstDataSector + (cluster - 2) * geometry.sectorsPerCluster
  return sector * geometry.bytesPerSector
}

// --- FAT table -------------------------------------------------------------

/** End-of-chain thresholds, per variant. */
const END_OF_CHAIN: Readonly<Record<FatVariant, number>> = {
  fat12: 0xff8,
  fat16: 0xfff8,
  fat32: 0x0ffffff8,
}

const BAD_CLUSTER: Readonly<Record<FatVariant, number>> = {
  fat12: 0xff7,
  fat16: 0xfff7,
  fat32: 0x0ffffff7,
}

/**
 * Read one FAT entry.
 *
 * FAT12 packs entries into 12 bits, so two entries share three bytes and the
 * nibble to keep depends on whether the index is odd or even. Getting that
 * backwards produces a chain that looks plausible and is entirely wrong.
 */
export function readFatEntry(fat: Buffer, variant: FatVariant, cluster: number): number {
  if (cluster < 0) return 0

  if (variant === 'fat12') {
    const offset = cluster + (cluster >> 1)
    if (offset + 1 >= fat.length) return 0

    const value = fat.readUInt16LE(offset)
    return (cluster & 1) === 1 ? value >> 4 : value & 0x0fff
  }

  if (variant === 'fat16') {
    const offset = cluster * 2
    if (offset + 1 >= fat.length) return 0
    return fat.readUInt16LE(offset)
  }

  const offset = cluster * 4
  if (offset + 3 >= fat.length) return 0
  // The top four bits are reserved and must be masked off.
  return fat.readUInt32LE(offset) & 0x0fffffff
}

/**
 * Follow a cluster chain.
 *
 * Bounded and cycle-guarded: a damaged FAT routinely contains loops, and an
 * unguarded walk would hang the scanner on the first one.
 */
export function followClusterChain(
  fat: Buffer,
  geometry: FatGeometry,
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

    const next = readFatEntry(fat, geometry.variant, cluster)

    if (next >= END_OF_CHAIN[geometry.variant]) break
    if (next === BAD_CLUSTER[geometry.variant]) break
    // A free (0) or reserved (1) entry mid-chain means the chain was destroyed —
    // which is exactly what deletion does.
    if (next < 2 || next >= geometry.clusterCount + 2) break

    cluster = next
  }

  return chain
}

/**
 * Cluster run for a file whose chain no longer exists.
 *
 * Used for deleted entries. The assumption of contiguity is the only option the
 * format leaves, and the caller records it so the recovery-quality score can
 * reflect it.
 */
export function assumeContiguousChain(
  geometry: FatGeometry,
  firstCluster: number,
  sizeBytes: number,
): number[] {
  if (firstCluster < 2 || sizeBytes <= 0) return []

  const needed = Math.ceil(sizeBytes / geometry.clusterSizeBytes)
  const available = geometry.clusterCount + 2 - firstCluster
  const count = Math.max(0, Math.min(needed, available))

  return Array.from({ length: count }, (_, index) => firstCluster + index)
}

// --- Directory entries -----------------------------------------------------

export const FatAttributes = {
  ReadOnly: 0x01,
  Hidden: 0x02,
  System: 0x04,
  VolumeLabel: 0x08,
  Directory: 0x10,
  Archive: 0x20,
  /** The combination that marks a long-file-name fragment. */
  LongName: 0x0f,
} as const

export const DIRECTORY_ENTRY_SIZE = 32

/** Marker in byte 0 meaning the entry — and everything after it — is unused. */
const END_OF_DIRECTORY = 0x00
/** Marker in byte 0 meaning the entry was deleted. */
const DELETED_ENTRY = 0xe5

export interface FatDirectoryEntry {
  /** Long name when one was present, otherwise the 8.3 name. */
  readonly name: string
  readonly shortName: string
  readonly isDeleted: boolean
  readonly isDirectory: boolean
  readonly isVolumeLabel: boolean
  readonly attributes: number
  readonly firstCluster: number
  readonly sizeBytes: number
  readonly createdAt: number | null
  readonly modifiedAt: number | null
  readonly accessedAt: number | null
  /** `true` when the name was reassembled from long-name fragments. */
  readonly hasLongName: boolean
}

export interface ParsedDirectory {
  readonly entries: readonly FatDirectoryEntry[]
  /** `true` when an end-of-directory marker was reached. */
  readonly reachedEnd: boolean
}

/**
 * Parse a buffer of directory entries.
 *
 * Long-name fragments precede their 8.3 entry in reverse order, so each newly
 * encountered fragment is prepended to the accumulated name.
 *
 * Deleted entries keep their fragments, but deletion overwrites the first byte
 * of *every* entry in the set — including the sequence numbers that give the
 * fragments their order. Reassembling them positionally is the only option, and
 * it is correct as long as the set is intact.
 */
export function parseFatDirectory(buffer: Buffer): ParsedDirectory {
  const entries: FatDirectoryEntry[] = []

  let longNameParts = ''
  let sawLongName = false
  let reachedEnd = false

  for (
    let offset = 0;
    offset + DIRECTORY_ENTRY_SIZE <= buffer.length;
    offset += DIRECTORY_ENTRY_SIZE
  ) {
    const marker = buffer.readUInt8(offset)

    if (marker === END_OF_DIRECTORY) {
      reachedEnd = true
      break
    }

    const attributes = buffer.readUInt8(offset + 0x0b)

    if ((attributes & FatAttributes.LongName) === FatAttributes.LongName) {
      longNameParts = readLongNameFragment(buffer, offset) + longNameParts
      sawLongName = true
      continue
    }

    const entry = parseShortEntry(buffer, offset, marker === DELETED_ENTRY)

    if (entry !== null) {
      entries.push(
        sawLongName && longNameParts.length > 0
          ? { ...entry, name: longNameParts, hasLongName: true }
          : entry,
      )
    }

    longNameParts = ''
    sawLongName = false
  }

  return { entries, reachedEnd }
}

/** Read the 13 UTF-16 characters a long-name entry carries, in three runs. */
function readLongNameFragment(buffer: Buffer, offset: number): string {
  const chunks = [
    buffer.subarray(offset + 0x01, offset + 0x0b),
    buffer.subarray(offset + 0x0e, offset + 0x1a),
    buffer.subarray(offset + 0x1c, offset + 0x20),
  ]

  const text = Buffer.concat(chunks).toString('utf16le')

  // The fragment is padded with a NUL and then 0xFFFF units. Scanned by code
  // point rather than by regex: both terminators are control characters, and
  // embedding them in a pattern makes the source itself awkward to handle.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x0000 || code === 0xffff) return text.slice(0, index)
  }

  return text
}

function parseShortEntry(
  buffer: Buffer,
  offset: number,
  isDeleted: boolean,
): FatDirectoryEntry | null {
  const attributes = buffer.readUInt8(offset + 0x0b)

  const shortName = readShortName(buffer, offset, isDeleted)
  if (shortName.length === 0) return null

  const firstClusterHigh = buffer.readUInt16LE(offset + 0x14)
  const firstClusterLow = buffer.readUInt16LE(offset + 0x1a)

  return {
    name: shortName,
    shortName,
    isDeleted,
    isDirectory: (attributes & FatAttributes.Directory) !== 0,
    isVolumeLabel: (attributes & FatAttributes.VolumeLabel) !== 0,
    attributes,
    firstCluster: (firstClusterHigh << 16) | firstClusterLow,
    sizeBytes: buffer.readUInt32LE(offset + 0x1c),
    createdAt: decodeFatDateTime(
      buffer.readUInt16LE(offset + 0x10),
      buffer.readUInt16LE(offset + 0x0e),
    ),
    // The access field stores a date only.
    accessedAt: decodeFatDateTime(buffer.readUInt16LE(offset + 0x12), 0),
    modifiedAt: decodeFatDateTime(
      buffer.readUInt16LE(offset + 0x18),
      buffer.readUInt16LE(offset + 0x16),
    ),
    hasLongName: false,
  }
}

/**
 * Decode the 8.3 name.
 *
 * The first character of a deleted entry is destroyed by the `0xE5` marker, so
 * it is replaced with `_`. Silently dropping it would produce "ILE.TXT" — a
 * name that looks real and is wrong; the placeholder makes the loss visible.
 */
function readShortName(buffer: Buffer, offset: number, isDeleted: boolean): string {
  const raw = Buffer.from(buffer.subarray(offset, offset + 11))

  // 0x05 in byte 0 encodes a literal 0xE5 as the first character.
  if (raw[0] === 0x05) raw[0] = 0xe5
  if (isDeleted) raw[0] = 0x5f // '_'

  const base = raw.subarray(0, 8).toString('latin1').trimEnd()
  const extension = raw.subarray(8, 11).toString('latin1').trimEnd()

  if (base.length === 0) return ''

  // Byte 0x0C carries case flags written by Windows: bit 3 lowercases the base,
  // bit 4 the extension.
  const caseFlags = buffer.readUInt8(offset + 0x0c)
  const finalBase = (caseFlags & 0x08) !== 0 ? base.toLowerCase() : base
  const finalExtension = (caseFlags & 0x10) !== 0 ? extension.toLowerCase() : extension

  return finalExtension.length > 0 ? `${finalBase}.${finalExtension}` : finalBase
}

/**
 * Decode the packed DOS date/time pair into epoch milliseconds.
 *
 * Returns `null` for an unset or impossible value. FAT dates start at 1980 and
 * store seconds in two-second units, so the low bit of a second is not
 * recoverable.
 */
export function decodeFatDateTime(date: number, time: number): number | null {
  if (date === 0) return null

  const year = 1980 + ((date >> 9) & 0x7f)
  const month = (date >> 5) & 0x0f
  const day = date & 0x1f

  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const hours = (time >> 11) & 0x1f
  const minutes = (time >> 5) & 0x3f
  const seconds = (time & 0x1f) * 2

  if (hours > 23 || minutes > 59 || seconds > 59) return null

  const timestamp = Date.UTC(year, month - 1, day, hours, minutes, seconds)

  return Number.isFinite(timestamp) ? timestamp : null
}

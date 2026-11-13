import { DEFAULT_SECTOR_SIZE } from '@shared/types/disk'
import type { BlockReader } from './block-device'
import { crc32 } from './crc32'

/**
 * GUID Partition Table.
 *
 * GPT keeps a primary header at LBA 1 and a byte-identical backup in the last
 * sector of the device, each with its own CRC-protected entry array. That
 * redundancy is the reason GPT disks are so often recoverable: when the primary
 * table is destroyed by a bad partitioning operation, the backup usually
 * survives untouched at the far end of the disk.
 *
 * This parser therefore reports *which* header it used and whether the CRCs
 * matched, rather than silently succeeding — the Partition Recovery module
 * needs that distinction.
 */

export const GPT_SIGNATURE = 'EFI PART'
export const GPT_HEADER_SIZE = 92

/** Bound on the entry array, so a corrupt header cannot allocate wildly. */
const MAX_PARTITION_ENTRIES = 512

export interface GptEntry {
  readonly index: number
  readonly typeGuid: string
  readonly typeName: string
  readonly uniqueGuid: string
  readonly startLba: number
  readonly endLba: number
  readonly offsetBytes: number
  readonly sizeBytes: number
  readonly attributes: bigint
  readonly name: string
  /** Bit 60: the partition is marked read-only. */
  readonly isReadOnly: boolean
  /** Bit 62: hidden from the OS's automatic mounting. */
  readonly isHidden: boolean
}

export interface GptHeader {
  readonly revision: number
  readonly headerSize: number
  readonly currentLba: bigint
  readonly backupLba: bigint
  readonly firstUsableLba: bigint
  readonly lastUsableLba: bigint
  readonly diskGuid: string
  readonly partitionEntryLba: bigint
  readonly partitionEntryCount: number
  readonly partitionEntrySize: number
  /** CRC-32 of the entry array, as recorded in the header. */
  readonly entryArrayCrc: number
  /** `true` when the stored header CRC matches the computed one. */
  readonly headerCrcValid: boolean
  /**
   * `true` when the entry array matches the CRC in the header.
   *
   * `false` with a valid header means the table itself was damaged — the case
   * Partition Recovery exists to repair.
   */
  readonly entriesCrcValid: boolean
}

export interface GptTable {
  readonly kind: 'gpt'
  readonly header: GptHeader
  readonly entries: readonly GptEntry[]
  /** Which copy of the table this result came from. */
  readonly source: 'primary' | 'backup'
  /** `true` when the primary header was unusable and the backup was used. */
  readonly usedBackup: boolean
  readonly warnings: readonly string[]
}

/**
 * Read the GPT, preferring the primary header and falling back to the backup.
 *
 * Returns `null` only when neither copy carries a valid signature.
 */
export async function readGptTable(
  reader: BlockReader,
  sectorSize = DEFAULT_SECTOR_SIZE,
): Promise<GptTable | null> {
  const warnings: string[] = []

  const primary = await tryReadHeader(reader, sectorSize, sectorSize)

  if (primary?.headerCrcValid === true) {
    const entries = await readEntries(reader, primary, sectorSize, warnings)
    if (entries !== null) {
      return {
        kind: 'gpt',
        header: entries.header,
        entries: entries.list,
        source: 'primary',
        usedBackup: false,
        warnings,
      }
    }
  }

  if (primary !== null && !primary.headerCrcValid) {
    warnings.push('The primary GPT header failed its checksum')
  }

  // The backup lives in the very last sector. Its location is also recorded in
  // the primary header, but a damaged primary cannot be trusted for it.
  const backupOffset = Math.max(0, alignDown(reader.sizeBytes, sectorSize) - sectorSize)
  const backup = await tryReadHeader(reader, backupOffset, sectorSize)

  if (backup === null) {
    if (primary === null) return null

    warnings.push('The backup GPT header is missing; using the damaged primary')
    const entries = await readEntries(reader, primary, sectorSize, warnings)
    return {
      kind: 'gpt',
      header: primary,
      entries: entries?.list ?? [],
      source: 'primary',
      usedBackup: false,
      warnings,
    }
  }

  if (!backup.headerCrcValid) warnings.push('The backup GPT header also failed its checksum')

  const entries = await readEntries(reader, backup, sectorSize, warnings)

  return {
    kind: 'gpt',
    header: backup,
    entries: entries?.list ?? [],
    source: 'backup',
    usedBackup: true,
    warnings,
  }
}

/** Parse a GPT header at a byte offset. Returns `null` without the signature. */
async function tryReadHeader(
  reader: BlockReader,
  offset: number,
  sectorSize: number,
): Promise<GptHeader | null> {
  const sector = await reader.read(offset, Math.max(sectorSize, 512))
  if (sector.length < GPT_HEADER_SIZE) return null
  if (sector.subarray(0, 8).toString('latin1') !== GPT_SIGNATURE) return null

  const headerSize = sector.readUInt32LE(12)
  const storedCrc = sector.readUInt32LE(16)

  // The CRC is computed over the header with its own CRC field zeroed.
  const effectiveSize =
    headerSize >= GPT_HEADER_SIZE && headerSize <= sector.length ? headerSize : GPT_HEADER_SIZE
  const forCrc = Buffer.from(sector.subarray(0, effectiveSize))
  forCrc.writeUInt32LE(0, 16)

  const partitionEntryCount = sector.readUInt32LE(80)
  const partitionEntrySize = sector.readUInt32LE(84)

  return {
    revision: sector.readUInt32LE(8),
    headerSize,
    currentLba: sector.readBigUInt64LE(24),
    backupLba: sector.readBigUInt64LE(32),
    firstUsableLba: sector.readBigUInt64LE(40),
    lastUsableLba: sector.readBigUInt64LE(48),
    diskGuid: decodeGuid(sector.subarray(56, 72)),
    partitionEntryLba: sector.readBigUInt64LE(72),
    partitionEntryCount,
    partitionEntrySize,
    entryArrayCrc: sector.readUInt32LE(88),
    headerCrcValid: crc32(forCrc) === storedCrc,
    // Cannot be known until the array itself is read; set by `readEntries`.
    entriesCrcValid: false,
  }
}

interface EntryReadResult {
  header: GptHeader
  list: GptEntry[]
}

async function readEntries(
  reader: BlockReader,
  header: GptHeader,
  sectorSize: number,
  warnings: string[],
): Promise<EntryReadResult | null> {
  const entrySize = header.partitionEntrySize
  const entryCount = Math.min(header.partitionEntryCount, MAX_PARTITION_ENTRIES)

  // A GPT entry is 128 bytes in every revision published to date; a wildly
  // different value means the header is damaged, not that the spec changed.
  if (entrySize < 128 || entrySize > 4096 || entryCount === 0) {
    warnings.push('The GPT entry array description is not usable')
    return null
  }

  const arrayOffset = Number(header.partitionEntryLba) * sectorSize
  const arrayLength = entrySize * entryCount

  if (arrayOffset <= 0 || arrayOffset >= reader.sizeBytes) {
    warnings.push('The GPT entry array points outside the device')
    return null
  }

  const raw = await reader.read(arrayOffset, arrayLength)
  if (raw.length < entrySize) {
    warnings.push('The GPT entry array could not be read')
    return null
  }

  const entries: GptEntry[] = []

  for (let index = 0; index < entryCount; index += 1) {
    const start = index * entrySize
    if (start + entrySize > raw.length) break

    const entry = parseEntry(raw.subarray(start, start + entrySize), index + 1, sectorSize)
    if (entry !== null) entries.push(entry)
  }

  // The CRC covers the declared array length exactly. A short read means the
  // array is truncated, which is itself a mismatch.
  const entriesCrcValid =
    raw.length >= arrayLength && crc32(raw.subarray(0, arrayLength)) === header.entryArrayCrc

  if (!entriesCrcValid) {
    warnings.push('The GPT partition entries failed their checksum')
  }

  return { header: { ...header, entriesCrcValid }, list: entries }
}

/** Decode one entry. Returns `null` for the all-zero "unused" pattern. */
function parseEntry(raw: Buffer, index: number, sectorSize: number): GptEntry | null {
  const typeGuid = decodeGuid(raw.subarray(0, 16))

  // An all-zero type GUID is the defined marker for an unused slot.
  if (typeGuid === '00000000-0000-0000-0000-000000000000') return null

  const startLba = raw.readBigUInt64LE(32)
  const endLba = raw.readBigUInt64LE(40)
  if (endLba < startLba) return null

  const attributes = raw.readBigUInt64LE(48)

  // The name is 72 bytes of UTF-16LE, NUL-padded.
  const name = raw.subarray(56, 128).toString('utf16le').replace(/\0+$/u, '').trim()

  const sectorCount = Number(endLba - startLba + 1n)

  return {
    index,
    typeGuid,
    typeName: describeGptType(typeGuid),
    uniqueGuid: decodeGuid(raw.subarray(16, 32)),
    startLba: Number(startLba),
    endLba: Number(endLba),
    offsetBytes: Number(startLba) * sectorSize,
    sizeBytes: sectorCount * sectorSize,
    attributes,
    name,
    isReadOnly: (attributes & (1n << 60n)) !== 0n,
    isHidden: (attributes & (1n << 62n)) !== 0n,
  }
}

/**
 * Decode a GPT GUID.
 *
 * The encoding is mixed-endian: the first three fields are little-endian and
 * the last two are big-endian. Treating the whole thing as one byte order is
 * the single most common GPT parsing bug, and it produces GUIDs that look
 * plausible but match nothing.
 */
export function decodeGuid(raw: Buffer): string {
  if (raw.length < 16) return '00000000-0000-0000-0000-000000000000'

  const hex = (start: number, end: number, reverse: boolean): string => {
    const slice = Buffer.from(raw.subarray(start, end))
    if (reverse) slice.reverse()
    return slice.toString('hex')
  }

  return [
    hex(0, 4, true),
    hex(4, 6, true),
    hex(6, 8, true),
    hex(8, 10, false),
    hex(10, 16, false),
  ].join('-')
}

/** Human-readable name for a GPT partition type GUID. */
export function describeGptType(guid: string): string {
  const names: Readonly<Record<string, string>> = {
    'c12a7328-f81f-11d2-ba4b-00a0c93ec93b': 'EFI System',
    'e3c9e316-0b5c-4db8-817d-f92df00215ae': 'Microsoft Reserved',
    'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7': 'Basic data',
    'de94bba4-06d1-4d40-a16a-bfd50179d6ac': 'Windows Recovery',
    '5808c8aa-7e8f-42e0-85d2-e1e90434cfb3': 'Windows LDM metadata',
    'af9b60a0-1431-4f62-bc68-3311714a69ad': 'Windows LDM data',
    'e75caf8f-f680-4cee-afa3-b001e56efc2d': 'Storage Spaces',
    '0fc63daf-8483-4772-8e79-3d69d8477de4': 'Linux filesystem',
    '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f': 'Linux swap',
    'e6d6d379-f507-44c2-a23c-238f2a3df928': 'Linux LVM',
    'a19d880f-05fc-4d3b-a006-743f0f84911e': 'Linux RAID',
    '48465300-0000-11aa-aa11-00306543ecac': 'Apple HFS+',
    '7c3457ef-0000-11aa-aa11-00306543ecac': 'Apple APFS',
    '426f6f74-0000-11aa-aa11-00306543ecac': 'Apple Boot',
    '516e7cb6-6ecf-11d6-8ff8-00022d09712b': 'FreeBSD UFS',
    '21686148-6449-6e6f-744e-656564454649': 'BIOS Boot',
  }

  return names[guid.toLowerCase()] ?? 'Unknown partition type'
}

function alignDown(value: number, multiple: number): number {
  return Math.floor(value / multiple) * multiple
}

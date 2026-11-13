import { DEFAULT_SECTOR_SIZE } from '@shared/types/disk'
import type { BlockReader } from './block-device'

/**
 * Master Boot Record partition table.
 *
 * The MBR occupies the first sector: 446 bytes of boot code, four 16-byte
 * partition entries at 0x1BE, and the 0xAA55 signature at 0x1FE.
 *
 * Extended partitions form a linked list of Extended Boot Records, each holding
 * one logical partition and a pointer to the next. Walking that chain is what
 * exposes logical drives inside an extended partition, which older systems used
 * heavily and which is exactly where "my D: drive vanished" data tends to live.
 */

export const MBR_SIGNATURE_OFFSET = 0x1fe
export const MBR_PARTITION_TABLE_OFFSET = 0x1be
export const MBR_ENTRY_SIZE = 16
export const MBR_ENTRY_COUNT = 4

/** Partition type bytes that mean "this entry points at an EBR chain". */
const EXTENDED_TYPES = new Set([0x05, 0x0f, 0x85, 0xc5, 0xd5])

/** Guards against a malformed or hostile image producing an unbounded walk. */
const MAX_EBR_HOPS = 128

export interface MbrEntry {
  /** 1-based index. Primary entries are 1–4; logical partitions continue from 5. */
  readonly index: number
  readonly bootable: boolean
  /** Raw type byte. */
  readonly type: number
  readonly typeName: string
  readonly startLba: number
  readonly sectorCount: number
  readonly offsetBytes: number
  readonly sizeBytes: number
  /** `true` for a logical partition found by walking the extended chain. */
  readonly isLogical: boolean
}

export interface MbrTable {
  readonly kind: 'mbr'
  /** Disk signature at offset 0x1B8 — identifies the disk to Windows. */
  readonly diskSignature: number
  readonly entries: readonly MbrEntry[]
  /**
   * `true` when the only entry is the 0xEE protective partition, meaning the
   * real table is GPT and this MBR exists solely to stop legacy tools writing
   * to the disk.
   */
  readonly isProtective: boolean
  readonly warnings: readonly string[]
}

/** `true` when the sector ends with the 0xAA55 boot signature. */
export function hasMbrSignature(sector: Buffer): boolean {
  return (
    sector.length >= MBR_SIGNATURE_OFFSET + 2 &&
    sector[MBR_SIGNATURE_OFFSET] === 0x55 &&
    sector[MBR_SIGNATURE_OFFSET + 1] === 0xaa
  )
}

/**
 * Parse the MBR and walk any extended partition chain.
 *
 * Returns `null` when the first sector carries no boot signature, which means
 * the disk is either unpartitioned, GPT-only with a wiped protective MBR, or
 * damaged — all cases the caller handles differently.
 */
export async function readMbrTable(
  reader: BlockReader,
  sectorSize = DEFAULT_SECTOR_SIZE,
): Promise<MbrTable | null> {
  const sector = await reader.read(0, Math.max(sectorSize, 512))
  if (!hasMbrSignature(sector)) return null

  const warnings: string[] = []
  const entries: MbrEntry[] = []

  const diskSignature = sector.readUInt32LE(0x1b8)

  for (let slot = 0; slot < MBR_ENTRY_COUNT; slot += 1) {
    const raw = parseEntry(sector, MBR_PARTITION_TABLE_OFFSET + slot * MBR_ENTRY_SIZE)
    if (raw === null) continue

    if (EXTENDED_TYPES.has(raw.type)) {
      const logical = await walkExtendedChain(
        reader,
        raw.startLba,
        sectorSize,
        entries.length + 1,
        warnings,
      )
      entries.push(...logical)
      continue
    }

    entries.push({
      index: slot + 1,
      bootable: raw.bootable,
      type: raw.type,
      typeName: describeMbrType(raw.type),
      startLba: raw.startLba,
      sectorCount: raw.sectorCount,
      offsetBytes: raw.startLba * sectorSize,
      sizeBytes: raw.sectorCount * sectorSize,
      isLogical: false,
    })
  }

  const isProtective = entries.length === 1 && entries[0]?.type === 0xee

  return { kind: 'mbr', diskSignature, entries, isProtective, warnings }
}

interface RawEntry {
  bootable: boolean
  type: number
  startLba: number
  sectorCount: number
}

/** Decode one 16-byte entry. Returns `null` for an empty or absurd slot. */
function parseEntry(sector: Buffer, offset: number): RawEntry | null {
  if (offset + MBR_ENTRY_SIZE > sector.length) return null

  const type = sector[offset + 4] ?? 0
  // Type 0x00 is the canonical "unused" marker.
  if (type === 0x00) return null

  const startLba = sector.readUInt32LE(offset + 8)
  const sectorCount = sector.readUInt32LE(offset + 12)

  // A zero-length partition is a table artefact, not a partition.
  if (sectorCount === 0) return null

  return {
    bootable: (sector[offset] ?? 0) === 0x80,
    type,
    startLba,
    sectorCount,
  }
}

/**
 * Follow the Extended Boot Record chain.
 *
 * Each EBR holds two meaningful entries: the first describes a logical
 * partition at an offset relative to that EBR, the second points to the next
 * EBR at an offset relative to the *start of the extended partition*. Getting
 * those two bases the wrong way round is the classic bug here.
 */
async function walkExtendedChain(
  reader: BlockReader,
  extendedStartLba: number,
  sectorSize: number,
  startingIndex: number,
  warnings: string[],
): Promise<MbrEntry[]> {
  const logical: MbrEntry[] = []
  const visited = new Set<number>()

  let currentLba = extendedStartLba
  let index = startingIndex

  for (let hop = 0; hop < MAX_EBR_HOPS; hop += 1) {
    if (visited.has(currentLba)) {
      warnings.push(`Extended partition chain loops at LBA ${currentLba}`)
      break
    }
    visited.add(currentLba)

    const offset = currentLba * sectorSize
    if (offset >= reader.sizeBytes) {
      warnings.push(`Extended partition chain points past the end of the device`)
      break
    }

    const sector = await reader.read(offset, Math.max(sectorSize, 512))
    if (!hasMbrSignature(sector)) {
      warnings.push(`Extended boot record at LBA ${currentLba} has no signature`)
      break
    }

    const first = parseEntry(sector, MBR_PARTITION_TABLE_OFFSET)
    if (first !== null && !EXTENDED_TYPES.has(first.type)) {
      const startLba = currentLba + first.startLba

      logical.push({
        index,
        bootable: first.bootable,
        type: first.type,
        typeName: describeMbrType(first.type),
        startLba,
        sectorCount: first.sectorCount,
        offsetBytes: startLba * sectorSize,
        sizeBytes: first.sectorCount * sectorSize,
        isLogical: true,
      })
      index += 1
    }

    const next = parseEntry(sector, MBR_PARTITION_TABLE_OFFSET + MBR_ENTRY_SIZE)
    if (next === null || !EXTENDED_TYPES.has(next.type)) break

    // Relative to the extended partition, not to the current EBR.
    currentLba = extendedStartLba + next.startLba
  }

  return logical
}

/**
 * Human-readable name for an MBR partition type byte.
 *
 * Only types a recovery user is plausibly looking at are named individually;
 * the rest fall through to a hex label rather than being hidden.
 */
export function describeMbrType(type: number): string {
  const names: Readonly<Record<number, string>> = {
    0x01: 'FAT12',
    0x04: 'FAT16 (<32 MB)',
    0x05: 'Extended',
    0x06: 'FAT16',
    0x07: 'NTFS / exFAT',
    0x0b: 'FAT32 (CHS)',
    0x0c: 'FAT32 (LBA)',
    0x0e: 'FAT16 (LBA)',
    0x0f: 'Extended (LBA)',
    0x11: 'Hidden FAT12',
    0x12: 'OEM / recovery',
    0x14: 'Hidden FAT16 (<32 MB)',
    0x16: 'Hidden FAT16',
    0x17: 'Hidden NTFS',
    0x1b: 'Hidden FAT32',
    0x1c: 'Hidden FAT32 (LBA)',
    0x1e: 'Hidden FAT16 (LBA)',
    0x27: 'Windows Recovery',
    0x42: 'Windows dynamic',
    0x82: 'Linux swap',
    0x83: 'Linux',
    0x85: 'Linux extended',
    0x8e: 'Linux LVM',
    0xa5: 'FreeBSD',
    0xa8: 'macOS UFS',
    0xaf: 'macOS HFS+',
    0xee: 'GPT protective',
    0xef: 'EFI System',
    0xfd: 'Linux RAID',
  }

  return names[type] ?? `Unknown (0x${type.toString(16).padStart(2, '0')})`
}

/** `true` when the type byte denotes an extended partition container. */
export function isExtendedType(type: number): boolean {
  return EXTENDED_TYPES.has(type)
}

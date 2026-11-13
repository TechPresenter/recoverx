import {
  DEFAULT_SECTOR_SIZE,
  type Partition,
  type PartitionStyle,
  type UnallocatedRegion,
} from '@shared/types/disk'
import { type BlockReader, SlicedBlockReader } from './block-device'
import { probeFilesystem } from './filesystem-signature'
import { readGptTable } from './gpt'
import { readMbrTable } from './mbr'

/**
 * Partition table reading, independent of table format.
 *
 * Each partition's filesystem is identified by probing its own boot sector
 * rather than trusting the table's type code — see `filesystem-signature.ts`
 * for why those disagree so often.
 *
 * Unallocated regions are computed and returned alongside the partitions. They
 * are not filler: a deleted partition's data still lives there, and it is the
 * highest-value region to carve after a repartition or a bad format.
 */

export interface PartitionTableResult {
  readonly style: PartitionStyle
  readonly partitions: readonly Partition[]
  readonly unallocated: readonly UnallocatedRegion[]
  readonly warnings: readonly string[]
  /** `true` when a table was found but failed its own integrity checks. */
  readonly isDamaged: boolean
}

/** Regions smaller than this are alignment padding, not recoverable space. */
const MIN_REPORTABLE_GAP_BYTES = 1024 * 1024

export async function readPartitionTable(
  reader: BlockReader,
  deviceId: string,
  sectorSize = DEFAULT_SECTOR_SIZE,
): Promise<PartitionTableResult> {
  const warnings: string[] = []

  /*
   * Check for a filesystem at sector 0 *before* looking for a partition table.
   *
   * A FAT, NTFS or exFAT boot sector also ends with the 0xAA55 signature, so a
   * device formatted without a partition table — the "superfloppy" layout used
   * by cameras, phones and most USB sticks — is indistinguishable from an MBR
   * by signature alone. Reading it as an MBR yields four garbage entries parsed
   * out of the BPB, which is worse than useless: it would send the scanner to
   * random offsets on a device whose real filesystem starts at zero.
   */
  const rootProbe = await probeFilesystem(reader)

  if (rootProbe.fileSystem !== 'unknown' && rootProbe.confidence === 'strong') {
    return {
      style: 'raw',
      partitions: [
        {
          id: `${deviceId}:p1`,
          deviceId,
          index: 1,
          offsetBytes: 0,
          sizeBytes: rootProbe.volumeSizeBytes ?? reader.sizeBytes,
          fileSystem: rootProbe.fileSystem,
          label: rootProbe.label,
          driveLetter: null,
          typeCode: 'superfloppy',
          typeName: 'Unpartitioned volume',
          isBootable: false,
          isHidden: false,
          isRecovered: false,
          freeBytes: null,
        },
      ],
      unallocated: [],
      warnings: ['This device has no partition table; the filesystem starts at sector 0'],
      isDamaged: false,
    }
  }

  const mbr = await readMbrTable(reader, sectorSize)

  // A protective MBR means the authoritative table is GPT. An absent MBR still
  // warrants a GPT attempt: a wiped first sector does not destroy the GPT.
  if (mbr === null || mbr.isProtective) {
    const gpt = await readGptTable(reader, sectorSize)

    if (gpt !== null) {
      warnings.push(...gpt.warnings)
      if (gpt.usedBackup) {
        warnings.push('The primary GPT was unusable; partitions were read from the backup table')
      }

      const partitions = await describePartitions(
        reader,
        deviceId,
        gpt.entries.map((entry, position) => ({
          index: position + 1,
          offsetBytes: entry.offsetBytes,
          sizeBytes: entry.sizeBytes,
          typeCode: entry.typeGuid,
          typeName: entry.typeName,
          isBootable: entry.typeGuid.toLowerCase().startsWith('c12a7328'),
          isHidden: entry.isHidden,
          label: entry.name.length > 0 ? entry.name : null,
        })),
      )

      return {
        style: 'gpt',
        partitions,
        unallocated: computeUnallocated(partitions, reader.sizeBytes, sectorSize),
        warnings,
        isDamaged: !gpt.header.headerCrcValid || !gpt.header.entriesCrcValid || gpt.usedBackup,
      }
    }

    if (mbr === null) {
      // No table, and the sector-0 probe above already ruled out a filesystem
      // starting at zero. The whole device is reported as unallocated so the
      // scanner still has somewhere to carve — this is the state a freshly
      // wiped or badly damaged disk is in, and it is far from unrecoverable.
      return {
        style: 'unknown',
        partitions: [],
        unallocated: [{ offsetBytes: 0, sizeBytes: reader.sizeBytes }],
        warnings: ['No partition table or recognisable filesystem was found'],
        isDamaged: true,
      }
    }
  }

  // A conventional MBR disk.
  warnings.push(...mbr.warnings)

  const partitions = await describePartitions(
    reader,
    deviceId,
    mbr.entries.map((entry) => ({
      index: entry.index,
      offsetBytes: entry.offsetBytes,
      sizeBytes: entry.sizeBytes,
      typeCode: `0x${entry.type.toString(16).padStart(2, '0')}`,
      typeName: entry.typeName,
      isBootable: entry.bootable,
      isHidden: false,
      label: null,
    })),
  )

  return {
    style: 'mbr',
    partitions,
    unallocated: computeUnallocated(partitions, reader.sizeBytes, sectorSize),
    warnings,
    isDamaged: false,
  }
}

interface RawPartition {
  index: number
  offsetBytes: number
  sizeBytes: number
  typeCode: string
  typeName: string
  isBootable: boolean
  isHidden: boolean
  label: string | null
}

/**
 * Turn table entries into full partition records by probing each one's
 * filesystem.
 *
 * A partition whose boot sector cannot be read is still reported — it is
 * exactly the sort of partition a user is trying to recover, and hiding it
 * would remove the only route to its data.
 */
async function describePartitions(
  reader: BlockReader,
  deviceId: string,
  raw: readonly RawPartition[],
): Promise<Partition[]> {
  const partitions: Partition[] = []

  for (const entry of raw) {
    // Reject entries that point outside the device: a damaged table produces
    // these, and a slice built from one would read garbage.
    const isAddressable =
      entry.offsetBytes >= 0 && entry.sizeBytes > 0 && entry.offsetBytes < reader.sizeBytes

    const probe = isAddressable
      ? await probeFilesystem(new SlicedBlockReader(reader, entry.offsetBytes, entry.sizeBytes))
      : null

    partitions.push({
      id: `${deviceId}:p${entry.index}`,
      deviceId,
      index: entry.index,
      offsetBytes: entry.offsetBytes,
      sizeBytes: entry.sizeBytes,
      fileSystem: probe?.fileSystem ?? 'unknown',
      // Prefer a label from the filesystem itself over the GPT entry name:
      // the GPT name is set by the partitioning tool, the filesystem label by
      // the user.
      label: probe?.label ?? entry.label,
      driveLetter: null,
      typeCode: entry.typeCode,
      typeName: entry.typeName,
      isBootable: entry.isBootable,
      isHidden: entry.isHidden,
      isRecovered: false,
      freeBytes: null,
    })
  }

  return partitions
}

/**
 * Find the gaps between partitions.
 *
 * Alignment padding — the 1 MiB before the first partition, a few sectors
 * between them — is filtered out so the UI shows only regions large enough to
 * have held real data.
 */
export function computeUnallocated(
  partitions: readonly Partition[],
  deviceSizeBytes: number,
  sectorSize = DEFAULT_SECTOR_SIZE,
): UnallocatedRegion[] {
  const occupied = partitions
    .filter((partition) => partition.sizeBytes > 0 && partition.offsetBytes < deviceSizeBytes)
    .map((partition) => ({
      start: partition.offsetBytes,
      end: Math.min(partition.offsetBytes + partition.sizeBytes, deviceSizeBytes),
    }))
    .sort((a, b) => a.start - b.start)

  const gaps: UnallocatedRegion[] = []
  let cursor = 0

  for (const region of occupied) {
    if (region.start > cursor) {
      addGap(gaps, cursor, region.start)
    }
    cursor = Math.max(cursor, region.end)
  }

  if (cursor < deviceSizeBytes) {
    // The tail of a GPT disk always holds the backup table; excluding one
    // sector keeps it out of the reported free space.
    addGap(gaps, cursor, Math.max(cursor, deviceSizeBytes - sectorSize))
  }

  return gaps
}

function addGap(gaps: UnallocatedRegion[], start: number, end: number): void {
  const sizeBytes = end - start
  if (sizeBytes < MIN_REPORTABLE_GAP_BYTES) return

  gaps.push({ offsetBytes: start, sizeBytes })
}

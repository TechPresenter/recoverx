import {
  DEFAULT_SECTOR_SIZE,
  supportsQuickScan,
  type FileSystem,
  type Partition,
} from '@shared/types/disk'
import {
  MIN_CANDIDATE_SIZE_BYTES,
  confidenceRank,
  type PartitionCandidate,
  type PartitionConfidence,
  type PartitionEvidence,
} from '@shared/types/partition-search'
import type { BlockReader } from './block-device'
import { identifyFilesystem } from './filesystem-signature'

/**
 * Finding partitions that no table describes.
 *
 * The search rests on one fact: a filesystem's header is at a *fixed* offset
 * from the start of its own volume. Finding an NTFS boot sector at byte X of a
 * device therefore means a volume began at X; finding an ext superblock at X
 * means one began at X - 1024. That inverts the usual direction of a disk
 * scan — instead of reading a table to locate volumes, volumes are located and
 * the table inferred from them.
 *
 * The header also records the volume's own length, so a reconstructed partition
 * gets its true extent rather than "to the end of the free space". Where the
 * filesystem keeps a backup copy of that header, the two are compared: agreeing
 * copies at two independently derived positions is evidence a random run of
 * bytes cannot fake.
 *
 * Every read here goes through `BlockReader`, which is opened read-only. This
 * module identifies partitions; it never writes one.
 */

/**
 * A filesystem header, described by where it sits relative to its volume.
 *
 * `volumeOffset` is what makes the search work backwards: it is the distance
 * from the first byte of the volume to the sector holding this magic value.
 */
interface VolumeAnchor {
  readonly fileSystem: FileSystem
  /** Byte sequence that identifies the header. */
  readonly magic: Buffer
  /** Offset of `magic` within its own sector. */
  readonly matchOffset: number
  /** Distance from the start of the volume to the start of that sector. */
  readonly volumeOffset: number
}

function anchor(
  fileSystem: FileSystem,
  magic: string | readonly number[],
  matchOffset: number,
  volumeOffset: number,
): VolumeAnchor {
  return {
    fileSystem,
    magic: typeof magic === 'string' ? Buffer.from(magic, 'latin1') : Buffer.from(magic),
    matchOffset,
    volumeOffset,
  }
}

/**
 * Every header the search recognises.
 *
 * Deliberately excludes swap: it holds nothing recoverable, and its magic is a
 * plain ASCII word common enough in ordinary files to generate noise.
 *
 * The FAT anchor matches only `FAT1`, covering FAT12 and FAT16. The bare `FAT `
 * variant some formatters write is three characters of extremely common ASCII,
 * and admitting it produced more false positives than it did recovered volumes.
 * Such a volume is still found through its FAT32 or NTFS neighbours, and a
 * carve of the surrounding free space recovers its files regardless.
 */
export const VOLUME_ANCHORS: readonly VolumeAnchor[] = [
  anchor('ntfs', 'NTFS    ', 3, 0),
  anchor('exfat', 'EXFAT   ', 3, 0),
  anchor('refs', 'ReFS', 3, 0),
  anchor('fat32', 'FAT32   ', 0x52, 0),
  anchor('fat16', 'FAT1', 0x36, 0),
  anchor('xfs', 'XFSB', 0, 0),
  // The ext superblock is 1024 bytes into the volume; its magic is 0xEF53 LE.
  anchor('ext4', [0x53, 0xef], 0x38, 1024),
  anchor('btrfs', '_BHRfS_M', 0x40, 0x10000),
  anchor('hfs+', 'H+', 0, 1024),
  anchor('hfs+', 'HX', 0, 1024),
  anchor('apfs', 'NXSB', 0x20, 0),
  anchor('iso9660', 'CD001', 1, 0x8000),
]

/** Bytes read from a candidate's start to run the full filesystem identifier. */
const HEADER_PROBE_BYTES = 0x10100

/**
 * A position where a header *might* begin, before any of it is verified.
 *
 * Produced by the cheap chunk pass and confirmed by `evaluateCandidate`.
 */
export interface AnchorHit {
  /** Device-absolute byte offset of the implied start of the volume. */
  readonly volumeOffsetBytes: number
  readonly fileSystem: FileSystem
}

/**
 * Locate anchor magics within one chunk of the device.
 *
 * `Buffer.indexOf` is used rather than a per-sector loop on purpose. Checking
 * every sector of a 250 GB device against a dozen signatures is roughly five
 * billion comparisons in JavaScript; `indexOf` hands the same work to a native
 * substring search that runs at memory bandwidth, turning minutes of CPU into
 * seconds and leaving the disk as the only bottleneck.
 *
 * `chunkOffsetBytes` must be sector-aligned. Because every anchor's magic lies
 * wholly within a single sector, and chunks are whole numbers of sectors, no
 * valid anchor can straddle a chunk boundary — so the chunks need no overlap.
 */
export function findAnchorHits(
  chunk: Buffer,
  chunkOffsetBytes: number,
  sectorSize = DEFAULT_SECTOR_SIZE,
): AnchorHit[] {
  const hits: AnchorHit[] = []
  const seen = new Set<number>()

  for (const item of VOLUME_ANCHORS) {
    let cursor = chunk.indexOf(item.magic, 0)

    while (cursor !== -1) {
      const absolute = chunkOffsetBytes + cursor

      // A header always begins on a sector boundary, because a partition does.
      // This rejects the overwhelming majority of incidental matches — the same
      // bytes inside a document, an executable, or a disk image file.
      if ((absolute - item.matchOffset) % sectorSize === 0) {
        const volumeOffsetBytes = absolute - item.matchOffset - item.volumeOffset

        // Deduplicate within the chunk: FAT12 and FAT16 share an anchor, and a
        // volume can legitimately match more than one magic.
        if (volumeOffsetBytes >= 0 && !seen.has(volumeOffsetBytes)) {
          seen.add(volumeOffsetBytes)
          hits.push({ volumeOffsetBytes, fileSystem: item.fileSystem })
        }
      }

      cursor = chunk.indexOf(item.magic, cursor + 1)
    }
  }

  return hits.sort((a, b) => a.volumeOffsetBytes - b.volumeOffsetBytes)
}

/**
 * Read the header at a hit and decide whether it describes a real volume.
 *
 * Returns `null` when the region fails identification or plausibility, which is
 * the common case: an anchor hit is a hint, not a finding.
 */
export async function evaluateCandidate(
  reader: BlockReader,
  hit: AnchorHit,
  deviceId: string,
  index: number,
  regionEndBytes: number,
): Promise<PartitionCandidate | null> {
  const start = hit.volumeOffsetBytes
  if (start < 0 || start >= reader.sizeBytes) return null

  let header: Buffer
  try {
    header = await reader.read(start, Math.min(HEADER_PROBE_BYTES, reader.sizeBytes - start))
  } catch {
    // An unreadable sector here is a bad block, not a bad candidate — but with
    // no header there is nothing to reconstruct a partition from.
    return null
  }

  const probe = identifyFilesystem(header)
  if (probe.fileSystem === 'unknown' || probe.confidence !== 'strong') return null

  const evidence: PartitionEvidence[] = ['boot-sector']

  // --- Extent -------------------------------------------------------------
  const available = reader.sizeBytes - start
  let sizeBytes: number
  let confidence: PartitionConfidence

  /*
   * A reported size and a missing size are different facts and must not be
   * conflated. A volume that says it is 2 MB really is 2 MB — treating that as
   * "size unknown" and stretching it to fill the surrounding free space would
   * hand the scanner an extent tens of megabytes larger than the volume,
   * covering data that belongs to something else entirely.
   */
  if (probe.volumeSizeBytes !== null) {
    if (probe.volumeSizeBytes > available) {
      // The volume claims to extend past the end of the device. That happens
      // when a header survives from a larger disk this one was cloned from, and
      // it means the tail of the data is genuinely absent. Reporting the
      // readable part is still useful; pretending the size is right is not.
      sizeBytes = available
      confidence = 'possible'
      evidence.push('size-clipped')
    } else {
      sizeBytes = probe.volumeSizeBytes
      confidence = 'likely'
      evidence.push('self-reported-size')
    }
  } else {
    // ReFS and APFS keep their geometry in structures far from the header, so
    // there is genuinely no size to read. The free space around the candidate
    // is the best available bound.
    sizeBytes = Math.max(0, Math.min(regionEndBytes, reader.sizeBytes) - start)
    confidence = 'possible'
    evidence.push('estimated-size')
  }

  // Applies to both branches: a volume this small holds nothing a user came
  // here for, and at this size a header-shaped run of bytes inside some larger
  // file is the likelier explanation than a real partition.

  if (sizeBytes < MIN_CANDIDATE_SIZE_BYTES) return null

  // --- Corroboration ------------------------------------------------------
  const backup = await verifyBackupHeader(reader, start, header, probe.fileSystem)

  if (backup !== null) {
    evidence.push('backup-boot-sector')
    confidence = 'confirmed'

    // NTFS places its backup in the sector *after* the last one its BPB counts,
    // so a confirmed backup pins the true end of the volume one sector beyond
    // the self-reported length. Getting this right matters: the final sector of
    // an NTFS volume is where its own recovery structures live.
    if (backup.impliedEndBytes !== null && backup.impliedEndBytes - start >= sizeBytes) {
      const corrected = backup.impliedEndBytes - start
      if (corrected <= available) sizeBytes = corrected
    }
  }

  return {
    id: `${deviceId}:found${index}`,
    deviceId,
    offsetBytes: start,
    sizeBytes,
    fileSystem: probe.fileSystem,
    label: probe.label,
    clusterSizeBytes: probe.clusterSizeBytes,
    confidence,
    evidence,
    supportsQuickScan: supportsQuickScan(probe.fileSystem),
  }
}

interface BackupHeaderResult {
  /** End of the volume implied by where the backup was found, if meaningful. */
  readonly impliedEndBytes: number | null
}

/**
 * Look for the filesystem's own second copy of its header.
 *
 * This is the strongest evidence available without mounting anything. The
 * backup's position is computed from fields in the *primary* header, so finding
 * a matching header there means two independent structures agree about the
 * volume's geometry. Random data does not do that.
 *
 * Only the Windows filesystems are checked. ext's backup superblocks are at
 * block-group boundaries whose position depends on flags this probe does not
 * parse, and guessing wrongly would downgrade a good candidate for no reason.
 */
async function verifyBackupHeader(
  reader: BlockReader,
  start: number,
  header: Buffer,
  fileSystem: FileSystem,
): Promise<BackupHeaderResult | null> {
  if (fileSystem === 'ntfs') return verifyNtfsBackup(reader, start, header)
  if (fileSystem === 'fat32') return verifyFat32Backup(reader, start, header)
  if (fileSystem === 'exfat') return verifyExfatBackup(reader, start, header)

  return null
}

async function verifyNtfsBackup(
  reader: BlockReader,
  start: number,
  header: Buffer,
): Promise<BackupHeaderResult | null> {
  const bytesPerSector = header.readUInt16LE(0x0b)
  if (bytesPerSector < 512 || bytesPerSector > 8192) return null

  const totalSectors = Number(header.readBigUInt64LE(0x28))
  if (totalSectors <= 0) return null

  // The BPB's sector count excludes the backup, which sits immediately after.
  const backupOffset = start + totalSectors * bytesPerSector
  const copy = await readSector(reader, backupOffset, bytesPerSector)
  if (copy === null) return null

  if (copy.subarray(3, 11).toString('latin1') !== 'NTFS    ') return null
  if (Number(copy.readBigUInt64LE(0x28)) !== totalSectors) return null

  return { impliedEndBytes: backupOffset + bytesPerSector }
}

async function verifyFat32Backup(
  reader: BlockReader,
  start: number,
  header: Buffer,
): Promise<BackupHeaderResult | null> {
  const bytesPerSector = header.readUInt16LE(0x0b)
  if (bytesPerSector < 512 || bytesPerSector > 8192) return null

  const backupSector = header.readUInt16LE(0x32)
  // 0 and 0xFFFF both mean "no backup"; anything past the reserved region is a
  // corrupt field rather than a location worth reading.
  const reservedSectors = header.readUInt16LE(0x0e)
  if (backupSector === 0 || backupSector >= reservedSectors) return null

  const copy = await readSector(reader, start + backupSector * bytesPerSector, bytesPerSector)
  if (copy === null) return null

  if (copy.subarray(0x52, 0x5a).toString('latin1') !== 'FAT32   ') return null

  // The backup is a copy of sector 0, so it says nothing new about the extent.
  return { impliedEndBytes: null }
}

/** The exFAT specification fixes the backup Volume Boot Record at sector 12. */
const EXFAT_BACKUP_VBR_SECTOR = 12

async function verifyExfatBackup(
  reader: BlockReader,
  start: number,
  header: Buffer,
): Promise<BackupHeaderResult | null> {
  const shift = header.readUInt8(0x6c)
  if (shift < 9 || shift > 12) return null

  const bytesPerSector = 1 << shift
  const copy = await readSector(
    reader,
    start + EXFAT_BACKUP_VBR_SECTOR * bytesPerSector,
    bytesPerSector,
  )
  if (copy === null) return null

  if (copy.subarray(3, 11).toString('latin1') !== 'EXFAT   ') return null

  return { impliedEndBytes: null }
}

/** Read one sector, treating any failure as "no backup here". */
async function readSector(
  reader: BlockReader,
  offset: number,
  length: number,
): Promise<Buffer | null> {
  if (offset < 0 || offset + length > reader.sizeBytes) return null

  try {
    const buffer = await reader.read(offset, length)
    return buffer.length >= length ? buffer : null
  } catch {
    return null
  }
}

/**
 * Reduce raw candidates to a set of partitions that could coexist on one disk.
 *
 * Two effects are being removed. First, backup headers: an NTFS volume is found
 * twice, once at its start and once at the copy in its last sector, and the
 * second implies a bogus partition beginning near the first one's end. Second,
 * genuine false positives — a filesystem image stored *inside* another
 * partition looks exactly like a partition, because it is one, just not one
 * this disk has.
 *
 * Both are handled by the same rule: partitions do not overlap. Candidates are
 * accepted strongest-first so that a confirmed volume displaces a speculative
 * one claiming the same space, rather than losing to whichever came first.
 */
export function resolveCandidates(candidates: readonly PartitionCandidate[]): PartitionCandidate[] {
  const ordered = [...candidates].sort((a, b) => {
    const rank = confidenceRank(b.confidence) - confidenceRank(a.confidence)
    if (rank !== 0) return rank

    // A larger volume at the same confidence is the better explanation: the
    // smaller one is usually a structure nested inside it.
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes

    return a.offsetBytes - b.offsetBytes
  })

  const accepted: PartitionCandidate[] = []

  for (const candidate of ordered) {
    const end = candidate.offsetBytes + candidate.sizeBytes

    const clashes = accepted.some((existing) => {
      const existingEnd = existing.offsetBytes + existing.sizeBytes
      return candidate.offsetBytes < existingEnd && existing.offsetBytes < end
    })

    if (!clashes) accepted.push(candidate)
  }

  return accepted
    .sort((a, b) => a.offsetBytes - b.offsetBytes)
    .map((candidate, position) => ({
      ...candidate,
      // Renumber so the identifiers read in device order, which is how the
      // list is displayed and how a user describes what they are looking at.
      id: `${candidate.deviceId}:found${position + 1}`,
    }))
}

/**
 * Convert found volumes into partition records.
 *
 * Kept here, beside the search that produced them, rather than in the device
 * service: this is the last step of reconstructing a partition, and it is the
 * part with rules worth testing — where the indices come from, and what happens
 * to the results of an earlier search on the same device.
 *
 * Any previously adopted partitions in `existing` are dropped rather than
 * merged. Re-running a search means the user is replacing its results, and
 * accumulating both sets would show every volume twice.
 */
export function toRecoveredPartitions(
  deviceId: string,
  existing: readonly Partition[],
  candidates: readonly PartitionCandidate[],
): Partition[] {
  const fromTable = existing.filter((partition) => !partition.isRecovered)
  const highestIndex = fromTable.reduce((max, partition) => Math.max(max, partition.index), 0)

  const recovered = candidates.map<Partition>((candidate, position) => ({
    id: candidate.id,
    deviceId,
    index: highestIndex + position + 1,
    offsetBytes: candidate.offsetBytes,
    sizeBytes: candidate.sizeBytes,
    fileSystem: candidate.fileSystem,
    label: candidate.label,
    // A found partition is by definition not mounted: if Windows could see it,
    // it would not have needed finding.
    driveLetter: null,
    typeCode: 'recovered',
    typeName: 'Recovered volume',
    isBootable: false,
    isHidden: false,
    isRecovered: true,
    freeBytes: null,
  }))

  return [...fromTable, ...recovered].sort((a, b) => a.offsetBytes - b.offsetBytes)
}

/**
 * NTFS on-disk structures.
 *
 * Every function here is pure: buffers in, parsed structures out. That is what
 * lets the whole format be exercised against synthetic records covering the
 * cases a healthy volume never produces — a failed fixup, a truncated runlist,
 * an attribute that claims to extend past the end of its record.
 *
 * Reference: the NTFS layout is not formally published by Microsoft; these
 * offsets follow the structures documented by the Linux NTFS project and
 * corroborated by the ntfs-3g implementation.
 */

// --- Boot sector -----------------------------------------------------------

export interface NtfsGeometry {
  readonly bytesPerSector: number
  readonly sectorsPerCluster: number
  readonly clusterSizeBytes: number
  readonly totalSectors: number
  readonly volumeSizeBytes: number
  /** Cluster holding the start of $MFT. */
  readonly mftClusterNumber: number
  /** Cluster holding the start of $MFTMirr — the first four records, mirrored. */
  readonly mftMirrorClusterNumber: number
  readonly fileRecordSizeBytes: number
  readonly indexBufferSizeBytes: number
}

/**
 * Parse an NTFS boot sector.
 *
 * Returns `null` when the sector is not NTFS or carries geometry that cannot be
 * true. Rejecting implausible geometry matters here: a damaged boot sector that
 * yields a 0-byte cluster or a 2 GB file record would otherwise send the scanner
 * into an allocation loop.
 */
export function parseNtfsBootSector(sector: Buffer): NtfsGeometry | null {
  if (sector.length < 512) return null
  if (sector.subarray(3, 11).toString('latin1') !== 'NTFS    ') return null

  const bytesPerSector = sector.readUInt16LE(0x0b)
  if (
    bytesPerSector < 256 ||
    bytesPerSector > 8192 ||
    (bytesPerSector & (bytesPerSector - 1)) !== 0
  ) {
    return null
  }

  const sectorsPerCluster = decodeClusterFactor(sector.readUInt8(0x0d))
  if (sectorsPerCluster <= 0) return null

  const clusterSizeBytes = bytesPerSector * sectorsPerCluster
  if (clusterSizeBytes > 2 * 1024 * 1024) return null

  const totalSectors = Number(sector.readBigUInt64LE(0x28))
  const mftClusterNumber = Number(sector.readBigUInt64LE(0x30))
  const mftMirrorClusterNumber = Number(sector.readBigUInt64LE(0x38))

  if (totalSectors <= 0 || mftClusterNumber <= 0) return null

  const fileRecordSizeBytes = decodeSizeFactor(sector.readInt8(0x40), clusterSizeBytes)
  const indexBufferSizeBytes = decodeSizeFactor(sector.readInt8(0x44), clusterSizeBytes)

  // A FILE record is 1024 bytes on every volume in practice; anything outside
  // this range means the field is damaged.
  if (fileRecordSizeBytes < 256 || fileRecordSizeBytes > 65_536) return null

  return {
    bytesPerSector,
    sectorsPerCluster,
    clusterSizeBytes,
    totalSectors,
    volumeSizeBytes: totalSectors * bytesPerSector,
    mftClusterNumber,
    mftMirrorClusterNumber,
    fileRecordSizeBytes,
    indexBufferSizeBytes,
  }
}

/**
 * Sectors per cluster.
 *
 * Values above 0x80 are a signed power-of-two encoding, used for clusters
 * larger than 128 sectors. Reading the byte plainly gives 200-odd sectors per
 * cluster on such a volume, which is wrong by three orders of magnitude.
 */
function decodeClusterFactor(raw: number): number {
  if (raw === 0) return 0
  if (raw <= 0x80) return raw

  const shift = 256 - raw
  return shift > 0 && shift < 32 ? 1 << shift : 0
}

/**
 * Record/index size fields, which are either a cluster count or a negative
 * log2 byte count.
 */
function decodeSizeFactor(raw: number, clusterSizeBytes: number): number {
  if (raw > 0) return raw * clusterSizeBytes
  const shift = -raw
  return shift > 0 && shift < 32 ? 1 << shift : 0
}

// --- Fixups (update sequence array) ----------------------------------------

/**
 * Apply the update sequence array to a multi-sector structure.
 *
 * NTFS writes a per-record sequence number into the last two bytes of every
 * sector, stashing the real values in an array at the top of the record. It is
 * how a torn write is detected: if any sector's trailing bytes do not match the
 * sequence number, the record was only partially written and its contents are
 * not trustworthy.
 *
 * Returns `false` for a failed check. On a recovery scan a failed fixup means
 * the record is stale — worth reporting as damaged rather than parsing into
 * plausible-looking nonsense.
 */
export function applyFixups(record: Buffer, sectorSize: number): boolean {
  if (record.length < 0x30) return false

  const arrayOffset = record.readUInt16LE(0x04)
  const arrayCount = record.readUInt16LE(0x06)

  // `arrayCount` counts the sequence number plus one entry per sector.
  if (arrayCount === 0) return false
  const sectorCount = arrayCount - 1
  if (sectorCount <= 0) return false
  if (sectorCount * sectorSize > record.length) return false
  if (arrayOffset + arrayCount * 2 > record.length) return false

  const sequenceNumber = record.readUInt16LE(arrayOffset)

  for (let sector = 0; sector < sectorCount; sector += 1) {
    const tail = (sector + 1) * sectorSize - 2

    if (record.readUInt16LE(tail) !== sequenceNumber) return false

    record.writeUInt16LE(record.readUInt16LE(arrayOffset + 2 + sector * 2), tail)
  }

  return true
}

// --- Attributes ------------------------------------------------------------

export const AttributeType = {
  StandardInformation: 0x10,
  AttributeList: 0x20,
  FileName: 0x30,
  ObjectId: 0x40,
  SecurityDescriptor: 0x50,
  VolumeName: 0x60,
  VolumeInformation: 0x70,
  Data: 0x80,
  IndexRoot: 0x90,
  IndexAllocation: 0xa0,
  Bitmap: 0xb0,
  ReparsePoint: 0xc0,
  End: 0xffffffff,
} as const

export const AttributeFlags = {
  Compressed: 0x0001,
  Encrypted: 0x4000,
  Sparse: 0x8000,
} as const

export interface DataRun {
  /** Logical cluster number on the volume. `-1` for a sparse run. */
  readonly startLcn: number
  readonly clusterCount: number
  readonly isSparse: boolean
}

export interface ParsedAttribute {
  readonly type: number
  readonly name: string
  readonly isResident: boolean
  readonly flags: number
  /** Present for resident attributes. */
  readonly residentValue: Buffer | null
  /** Present for non-resident attributes. */
  readonly runs: readonly DataRun[]
  /** Actual data length. Non-resident attributes report it in their header. */
  readonly realSizeBytes: number
  readonly allocatedSizeBytes: number
  /** Bytes that have been written; the tail up to `realSize` reads as zeroes. */
  readonly initializedSizeBytes: number
  readonly startingVcn: number
}

/**
 * Walk the attribute list of a FILE record.
 *
 * Every bound is checked against the record length. A damaged attribute header
 * claiming a 4 GB length inside a 1 KB record is exactly what a recovery tool
 * meets, and it must terminate the walk rather than read out of bounds.
 */
export function parseAttributes(record: Buffer, firstOffset: number): ParsedAttribute[] {
  const attributes: ParsedAttribute[] = []
  let offset = firstOffset

  // A FILE record cannot hold more attributes than this; the bound stops a
  // cyclic or zero-length header from spinning forever.
  const MAX_ATTRIBUTES = 256

  for (let index = 0; index < MAX_ATTRIBUTES; index += 1) {
    if (offset + 4 > record.length) break

    const type = record.readUInt32LE(offset)
    if (type === AttributeType.End) break
    if (offset + 16 > record.length) break

    const length = record.readUInt32LE(offset + 4)
    // A zero or oversized length cannot be advanced past safely.
    if (length < 16 || offset + length > record.length) break

    const attribute = parseAttribute(record, offset, length)
    if (attribute !== null) attributes.push(attribute)

    offset += length
  }

  return attributes
}

function parseAttribute(record: Buffer, offset: number, length: number): ParsedAttribute | null {
  const type = record.readUInt32LE(offset)
  const isResident = record.readUInt8(offset + 8) === 0
  const nameLength = record.readUInt8(offset + 9)
  const nameOffset = record.readUInt16LE(offset + 10)
  const flags = record.readUInt16LE(offset + 12)

  let name = ''
  if (nameLength > 0 && offset + nameOffset + nameLength * 2 <= record.length) {
    name = record
      .subarray(offset + nameOffset, offset + nameOffset + nameLength * 2)
      .toString('utf16le')
  }

  if (isResident) {
    if (offset + 24 > record.length) return null

    const valueLength = record.readUInt32LE(offset + 16)
    const valueOffset = record.readUInt16LE(offset + 20)
    const start = offset + valueOffset

    if (valueOffset < 24 || start + valueLength > offset + length) return null

    return {
      type,
      name,
      isResident: true,
      flags,
      residentValue: record.subarray(start, start + valueLength),
      runs: [],
      realSizeBytes: valueLength,
      allocatedSizeBytes: valueLength,
      initializedSizeBytes: valueLength,
      startingVcn: 0,
    }
  }

  if (offset + 64 > record.length) return null

  const startingVcn = Number(record.readBigUInt64LE(offset + 16))
  const runlistOffset = record.readUInt16LE(offset + 32)
  const allocatedSize = Number(record.readBigUInt64LE(offset + 40))
  const realSize = Number(record.readBigUInt64LE(offset + 48))
  const initializedSize = Number(record.readBigUInt64LE(offset + 56))

  const runs =
    runlistOffset >= 64 && offset + runlistOffset < offset + length
      ? decodeRunList(record.subarray(offset + runlistOffset, offset + length))
      : []

  return {
    type,
    name,
    isResident: false,
    flags,
    residentValue: null,
    runs,
    realSizeBytes: realSize,
    allocatedSizeBytes: allocatedSize,
    initializedSizeBytes: initializedSize,
    startingVcn,
  }
}

/**
 * Decode a runlist into absolute cluster extents.
 *
 * Each run begins with a header byte packing two nibble-sized field widths. The
 * offset field is a **signed** delta from the previous run's start — the single
 * most common NTFS parsing mistake is reading it unsigned, which works on the
 * first run of every file and then places every subsequent fragment at a wildly
 * wrong location.
 */
export function decodeRunList(buffer: Buffer): DataRun[] {
  const runs: DataRun[] = []
  let offset = 0
  let previousLcn = 0

  // Bounded so a corrupt runlist cannot produce an unbounded list.
  const MAX_RUNS = 65_536

  while (offset < buffer.length && runs.length < MAX_RUNS) {
    const header = buffer.readUInt8(offset)
    if (header === 0) break

    const lengthSize = header & 0x0f
    const offsetSize = (header >> 4) & 0x0f

    if (lengthSize === 0 || lengthSize > 8 || offsetSize > 8) break
    if (offset + 1 + lengthSize + offsetSize > buffer.length) break

    const clusterCount = readUnsignedLe(buffer, offset + 1, lengthSize)
    if (clusterCount <= 0) break

    if (offsetSize === 0) {
      // No offset field: a sparse run, which occupies no space on disk.
      runs.push({ startLcn: -1, clusterCount, isSparse: true })
    } else {
      const delta = readSignedLe(buffer, offset + 1 + lengthSize, offsetSize)
      const startLcn = previousLcn + delta

      // A negative absolute LCN means the runlist is damaged.
      if (startLcn < 0) break

      previousLcn = startLcn
      runs.push({ startLcn, clusterCount, isSparse: false })
    }

    offset += 1 + lengthSize + offsetSize
  }

  return runs
}

function readUnsignedLe(buffer: Buffer, offset: number, size: number): number {
  let value = 0
  for (let index = size - 1; index >= 0; index -= 1) {
    value = value * 256 + (buffer[offset + index] ?? 0)
  }
  return value
}

function readSignedLe(buffer: Buffer, offset: number, size: number): number {
  let value = 0
  for (let index = size - 1; index >= 0; index -= 1) {
    value = value * 256 + (buffer[offset + index] ?? 0)
  }

  // Sign-extend from the most significant bit of the field's width.
  const signBit = Math.pow(2, size * 8 - 1)
  return value >= signBit ? value - signBit * 2 : value
}

// --- FILE records ----------------------------------------------------------

export const FileRecordFlags = {
  InUse: 0x0001,
  Directory: 0x0002,
} as const

export interface NtfsFileName {
  readonly parentRecordNumber: number
  readonly name: string
  /** 0 POSIX, 1 Win32, 2 DOS (8.3), 3 Win32 and DOS combined. */
  readonly nameSpace: number
  readonly realSizeBytes: number
  readonly allocatedSizeBytes: number
  readonly flags: number
}

export interface NtfsTimestamps {
  readonly createdAt: number | null
  readonly modifiedAt: number | null
  readonly accessedAt: number | null
  readonly changedAt: number | null
}

export interface NtfsRecord {
  readonly recordNumber: number
  readonly sequenceNumber: number
  /** `false` means the record describes a deleted file or directory. */
  readonly inUse: boolean
  readonly isDirectory: boolean
  /** 0 for a base record; otherwise the base this extension belongs to. */
  readonly baseRecordNumber: number
  readonly names: readonly NtfsFileName[]
  readonly timestamps: NtfsTimestamps
  readonly dataSizeBytes: number
  readonly dataRuns: readonly DataRun[]
  /** Small files live entirely inside the MFT record. */
  readonly residentData: Buffer | null
  readonly isCompressed: boolean
  readonly isEncrypted: boolean
  readonly isSparse: boolean
  /** `true` when the fixup check failed — contents are not trustworthy. */
  readonly isDamaged: boolean
}

/**
 * Parse one FILE record.
 *
 * `raw` is mutated in place by the fixup pass, so callers must pass a buffer
 * they own.
 */
export function parseFileRecord(
  raw: Buffer,
  sectorSize: number,
  fallbackRecordNumber: number,
): NtfsRecord | null {
  if (raw.length < 48) return null
  if (raw.subarray(0, 4).toString('latin1') !== 'FILE') return null

  const fixupsValid = applyFixups(raw, sectorSize)

  const sequenceNumber = raw.readUInt16LE(0x10)
  const firstAttributeOffset = raw.readUInt16LE(0x14)
  const flags = raw.readUInt16LE(0x16)
  const usedSize = raw.readUInt32LE(0x18)
  const baseReference = raw.readBigUInt64LE(0x20)

  // NTFS 3.1 records carry their own number at 0x2C. Older ones do not, so the
  // caller's positional guess is the fallback.
  const storedRecordNumber = raw.length >= 0x30 ? raw.readUInt32LE(0x2c) : 0
  const recordNumber = storedRecordNumber > 0 ? storedRecordNumber : fallbackRecordNumber

  if (firstAttributeOffset < 0x2a || firstAttributeOffset >= raw.length) return null

  // Trust `usedSize` only when it is plausible; a damaged value must not extend
  // the parse past the buffer.
  const limit = usedSize > firstAttributeOffset && usedSize <= raw.length ? usedSize : raw.length
  const attributes = parseAttributes(raw.subarray(0, limit), firstAttributeOffset)

  const names: NtfsFileName[] = []
  let timestamps: NtfsTimestamps = {
    createdAt: null,
    modifiedAt: null,
    accessedAt: null,
    changedAt: null,
  }
  let dataSizeBytes = 0
  let dataRuns: readonly DataRun[] = []
  let residentData: Buffer | null = null
  let attributeFlags = 0

  for (const attribute of attributes) {
    switch (attribute.type) {
      case AttributeType.StandardInformation:
        if (attribute.residentValue !== null) {
          timestamps = parseStandardInformation(attribute.residentValue) ?? timestamps
        }
        break

      case AttributeType.FileName:
        if (attribute.residentValue !== null) {
          const parsed = parseFileNameAttribute(attribute.residentValue)
          if (parsed !== null) names.push(parsed)
        }
        break

      case AttributeType.Data:
        // The unnamed $DATA stream is the file's contents; named streams are
        // alternate data streams and are not the file itself.
        if (attribute.name.length === 0) {
          attributeFlags |= attribute.flags
          if (attribute.isResident) {
            residentData = attribute.residentValue
            dataSizeBytes = attribute.realSizeBytes
          } else if (attribute.startingVcn === 0) {
            dataSizeBytes = attribute.realSizeBytes
            dataRuns = attribute.runs
          } else {
            // A continuation extent of an already-seen $DATA attribute.
            dataRuns = [...dataRuns, ...attribute.runs]
          }
        }
        break

      default:
        break
    }
  }

  return {
    recordNumber,
    sequenceNumber,
    inUse: (flags & FileRecordFlags.InUse) !== 0,
    isDirectory: (flags & FileRecordFlags.Directory) !== 0,
    baseRecordNumber: Number(baseReference & 0xffffffffffffn),
    names,
    timestamps,
    dataSizeBytes,
    dataRuns,
    residentData,
    isCompressed: (attributeFlags & AttributeFlags.Compressed) !== 0,
    isEncrypted: (attributeFlags & AttributeFlags.Encrypted) !== 0,
    isSparse: (attributeFlags & AttributeFlags.Sparse) !== 0,
    isDamaged: !fixupsValid,
  }
}

function parseStandardInformation(value: Buffer): NtfsTimestamps | null {
  if (value.length < 32) return null

  return {
    createdAt: filetimeToEpochMs(value.readBigUInt64LE(0)),
    modifiedAt: filetimeToEpochMs(value.readBigUInt64LE(8)),
    changedAt: filetimeToEpochMs(value.readBigUInt64LE(16)),
    accessedAt: filetimeToEpochMs(value.readBigUInt64LE(24)),
  }
}

function parseFileNameAttribute(value: Buffer): NtfsFileName | null {
  if (value.length < 0x42) return null

  const nameLength = value.readUInt8(0x40)
  const nameSpace = value.readUInt8(0x41)
  const nameEnd = 0x42 + nameLength * 2

  if (nameLength === 0 || nameEnd > value.length) return null

  return {
    // The upper 16 bits of the reference are a sequence number, not part of
    // the record address.
    parentRecordNumber: Number(value.readBigUInt64LE(0) & 0xffffffffffffn),
    name: value.subarray(0x42, nameEnd).toString('utf16le'),
    nameSpace,
    allocatedSizeBytes: Number(value.readBigUInt64LE(0x28)),
    realSizeBytes: Number(value.readBigUInt64LE(0x30)),
    flags: value.readUInt32LE(0x38),
  }
}

/**
 * Choose the name to show the user.
 *
 * A file commonly carries both a Win32 long name and a DOS 8.3 alias. The 8.3
 * form ("PROGRA~1") is never the right thing to display or to restore as.
 */
export function preferredFileName(names: readonly NtfsFileName[]): NtfsFileName | null {
  if (names.length === 0) return null

  const win32 = names.find((name) => name.nameSpace === 1 || name.nameSpace === 3)
  if (win32 !== undefined) return win32

  const posix = names.find((name) => name.nameSpace === 0)
  return posix ?? names[0] ?? null
}

/** Difference between the FILETIME epoch (1601) and the Unix epoch, in ms. */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n

/**
 * Convert a Windows FILETIME to epoch milliseconds.
 *
 * Returns `null` for zero and for values outside a plausible range. Deleted
 * records frequently carry partially overwritten timestamps, and a file dated
 * to the year 30000 in the results grid destroys confidence in everything else
 * on screen.
 */
export function filetimeToEpochMs(value: bigint): number | null {
  if (value === 0n) return null

  const milliseconds = Number(value / 10_000n - FILETIME_EPOCH_OFFSET_MS)

  if (!Number.isFinite(milliseconds)) return null
  // 1980-01-01 to 2100-01-01. Nothing on a real filesystem predates the former.
  if (milliseconds < 315_532_800_000 || milliseconds > 4_102_444_800_000) return null

  return milliseconds
}

/** Total bytes addressed by a runlist. */
export function runListSizeBytes(runs: readonly DataRun[], clusterSizeBytes: number): number {
  return runs.reduce((total, run) => total + run.clusterCount * clusterSizeBytes, 0)
}

/** MFT record number of the root directory, fixed by the format. */
export const ROOT_DIRECTORY_RECORD = 5

/** MFT record numbers below this are NTFS metadata files ($MFT, $LogFile, …). */
export const FIRST_USER_RECORD = 16

import { AttributeType } from '@main/scan/ntfs/ntfs'

/**
 * Synthetic NTFS structure builders.
 *
 * These construct byte-accurate FILE records, including a correctly computed
 * update sequence array, so the parser is exercised against the real format
 * rather than against a convenient approximation. Damage cases — a broken
 * fixup, a truncated runlist, an attribute that overruns its record — are
 * produced deliberately, because those are the records a recovery scan actually
 * meets and a healthy volume never contains.
 */

export const SECTOR_SIZE = 512
export const RECORD_SIZE = 1024

// --- Boot sector -----------------------------------------------------------

export interface NtfsBootOptions {
  readonly bytesPerSector?: number
  readonly sectorsPerCluster?: number
  readonly totalSectors?: number
  readonly mftCluster?: number
  /** Raw byte at 0x40. Positive = clusters per record, negative = log2 bytes. */
  readonly recordSizeFactor?: number
}

export function buildNtfsBootSector(options: NtfsBootOptions = {}): Buffer {
  const sector = Buffer.alloc(512)

  sector.writeUInt8(0xeb, 0)
  sector.writeUInt8(0x52, 1)
  sector.writeUInt8(0x90, 2)
  sector.write('NTFS    ', 3, 'latin1')

  sector.writeUInt16LE(options.bytesPerSector ?? 512, 0x0b)
  sector.writeUInt8(options.sectorsPerCluster ?? 8, 0x0d)
  sector.writeBigUInt64LE(BigInt(options.totalSectors ?? 2_097_152), 0x28)
  sector.writeBigUInt64LE(BigInt(options.mftCluster ?? 4), 0x30)
  sector.writeBigUInt64LE(2n, 0x38)
  // -10 encodes 2^10 = 1024-byte FILE records, which is what Windows uses.
  sector.writeInt8(options.recordSizeFactor ?? -10, 0x40)
  sector.writeInt8(-12, 0x44)

  sector.writeUInt8(0x55, 0x1fe)
  sector.writeUInt8(0xaa, 0x1ff)

  return sector
}

// --- Runlists --------------------------------------------------------------

export interface RunSpec {
  readonly clusterCount: number
  /** Absolute start cluster. Omit for a sparse run. */
  readonly startLcn?: number
}

/** Minimum bytes needed to hold an unsigned value. */
function unsignedWidth(value: number): number {
  let width = 1
  let remaining = value
  while (remaining > 0xff) {
    remaining = Math.floor(remaining / 256)
    width += 1
  }
  return width
}

/** Minimum bytes needed to hold a signed value without changing its sign. */
function signedWidth(value: number): number {
  let width = 1
  while (width < 8) {
    const limit = Math.pow(2, width * 8 - 1)
    if (value >= -limit && value < limit) return width
    width += 1
  }
  return 8
}

function writeUnsignedLe(target: Buffer, offset: number, value: number, width: number): void {
  let remaining = value
  for (let index = 0; index < width; index += 1) {
    target.writeUInt8(remaining % 256, offset + index)
    remaining = Math.floor(remaining / 256)
  }
}

function writeSignedLe(target: Buffer, offset: number, value: number, width: number): void {
  const modulus = Math.pow(2, width * 8)
  writeUnsignedLe(target, offset, value < 0 ? value + modulus : value, width)
}

/**
 * Encode a runlist.
 *
 * Offsets are written as signed deltas from the previous run, which is what the
 * format specifies and what makes backward-fragmented files parse correctly.
 */
export function encodeRunList(runs: readonly RunSpec[]): Buffer {
  const parts: Buffer[] = []
  let previousLcn = 0

  for (const run of runs) {
    const lengthWidth = unsignedWidth(run.clusterCount)

    if (run.startLcn === undefined) {
      const chunk = Buffer.alloc(1 + lengthWidth)
      chunk.writeUInt8(lengthWidth, 0)
      writeUnsignedLe(chunk, 1, run.clusterCount, lengthWidth)
      parts.push(chunk)
      continue
    }

    const delta = run.startLcn - previousLcn
    const offsetWidth = signedWidth(delta)

    const chunk = Buffer.alloc(1 + lengthWidth + offsetWidth)
    chunk.writeUInt8((offsetWidth << 4) | lengthWidth, 0)
    writeUnsignedLe(chunk, 1, run.clusterCount, lengthWidth)
    writeSignedLe(chunk, 1 + lengthWidth, delta, offsetWidth)

    parts.push(chunk)
    previousLcn = run.startLcn
  }

  // A zero header byte terminates the list.
  parts.push(Buffer.alloc(1))

  return Buffer.concat(parts)
}

// --- Attributes ------------------------------------------------------------

const align8 = (value: number): number => Math.ceil(value / 8) * 8

export function buildResidentAttribute(type: number, value: Buffer, name = ''): Buffer {
  const nameBytes = Buffer.from(name, 'utf16le')
  const valueOffset = align8(24 + nameBytes.length)
  const total = align8(valueOffset + value.length)

  const attribute = Buffer.alloc(total)

  attribute.writeUInt32LE(type, 0)
  attribute.writeUInt32LE(total, 4)
  attribute.writeUInt8(0, 8) // resident
  attribute.writeUInt8(name.length, 9)
  attribute.writeUInt16LE(nameBytes.length > 0 ? 24 : 0, 10)
  attribute.writeUInt16LE(0, 12) // flags
  attribute.writeUInt16LE(0, 14) // attribute id
  attribute.writeUInt32LE(value.length, 16)
  attribute.writeUInt16LE(valueOffset, 20)

  nameBytes.copy(attribute, 24)
  value.copy(attribute, valueOffset)

  return attribute
}

export interface NonResidentOptions {
  readonly realSize: number
  readonly allocatedSize?: number
  readonly initializedSize?: number
  readonly startingVcn?: number
  readonly flags?: number
  readonly name?: string
}

export function buildNonResidentAttribute(
  type: number,
  runs: readonly RunSpec[],
  options: NonResidentOptions,
): Buffer {
  const nameBytes = Buffer.from(options.name ?? '', 'utf16le')
  const runlist = encodeRunList(runs)
  const runlistOffset = align8(64 + nameBytes.length)
  const total = align8(runlistOffset + runlist.length)

  const attribute = Buffer.alloc(total)
  const lastVcn = runs.reduce((sum, run) => sum + run.clusterCount, 0) - 1

  attribute.writeUInt32LE(type, 0)
  attribute.writeUInt32LE(total, 4)
  attribute.writeUInt8(1, 8) // non-resident
  attribute.writeUInt8((options.name ?? '').length, 9)
  attribute.writeUInt16LE(nameBytes.length > 0 ? 64 : 0, 10)
  attribute.writeUInt16LE(options.flags ?? 0, 12)
  attribute.writeUInt16LE(0, 14)
  attribute.writeBigUInt64LE(BigInt(options.startingVcn ?? 0), 16)
  attribute.writeBigUInt64LE(BigInt(Math.max(lastVcn, 0)), 24)
  attribute.writeUInt16LE(runlistOffset, 32)
  attribute.writeUInt16LE(0, 34) // compression unit
  attribute.writeBigUInt64LE(BigInt(options.allocatedSize ?? options.realSize), 40)
  attribute.writeBigUInt64LE(BigInt(options.realSize), 48)
  attribute.writeBigUInt64LE(BigInt(options.initializedSize ?? options.realSize), 56)

  nameBytes.copy(attribute, 64)
  runlist.copy(attribute, runlistOffset)

  return attribute
}

// --- $STANDARD_INFORMATION / $FILE_NAME ------------------------------------

const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n

export function epochMsToFiletime(epochMs: number): bigint {
  return (BigInt(Math.round(epochMs)) + FILETIME_EPOCH_OFFSET_MS) * 10_000n
}

export interface TimestampSpec {
  readonly createdAt?: number
  readonly modifiedAt?: number
  readonly changedAt?: number
  readonly accessedAt?: number
}

export function buildStandardInformation(times: TimestampSpec = {}): Buffer {
  const value = Buffer.alloc(48)
  const write = (offset: number, epochMs: number | undefined): void => {
    value.writeBigUInt64LE(epochMs === undefined ? 0n : epochMsToFiletime(epochMs), offset)
  }

  write(0, times.createdAt)
  write(8, times.modifiedAt)
  write(16, times.changedAt)
  write(24, times.accessedAt)

  return value
}

export interface FileNameSpec {
  readonly name: string
  readonly parentRecordNumber: number
  /** 0 POSIX, 1 Win32, 2 DOS, 3 Win32+DOS. */
  readonly nameSpace?: number
  readonly realSize?: number
  readonly allocatedSize?: number
  readonly flags?: number
  readonly times?: TimestampSpec
}

export function buildFileNameAttributeValue(spec: FileNameSpec): Buffer {
  const nameBytes = Buffer.from(spec.name, 'utf16le')
  const value = Buffer.alloc(0x42 + nameBytes.length)

  // The upper 16 bits are a sequence number; a real reference carries one.
  value.writeBigUInt64LE(BigInt(spec.parentRecordNumber) | (1n << 48n), 0)
  value.writeBigUInt64LE(
    spec.times?.createdAt === undefined ? 0n : epochMsToFiletime(spec.times.createdAt),
    8,
  )
  value.writeBigUInt64LE(BigInt(spec.allocatedSize ?? 0), 0x28)
  value.writeBigUInt64LE(BigInt(spec.realSize ?? 0), 0x30)
  value.writeUInt32LE(spec.flags ?? 0, 0x38)
  value.writeUInt8(spec.name.length, 0x40)
  value.writeUInt8(spec.nameSpace ?? 1, 0x41)
  nameBytes.copy(value, 0x42)

  return value
}

// --- FILE records ----------------------------------------------------------

export interface FileRecordSpec {
  readonly recordNumber: number
  readonly sequenceNumber?: number
  readonly inUse?: boolean
  readonly isDirectory?: boolean
  readonly baseRecordNumber?: number
  readonly attributes: readonly Buffer[]
  readonly recordSize?: number
  readonly sectorSize?: number
  /** Corrupt the update sequence array, simulating a torn write. */
  readonly breakFixups?: boolean
}

/**
 * Assemble a FILE record with a valid update sequence array.
 *
 * The fixups are applied last, after every field is in place — the array stores
 * the bytes it displaces, so computing it earlier would capture zeroes.
 */
export function buildFileRecord(spec: FileRecordSpec): Buffer {
  const size = spec.recordSize ?? RECORD_SIZE
  const sectorSize = spec.sectorSize ?? SECTOR_SIZE
  const record = Buffer.alloc(size)

  const usaOffset = 0x30
  const usaCount = size / sectorSize + 1
  const firstAttributeOffset = align8(usaOffset + usaCount * 2)

  record.write('FILE', 0, 'latin1')
  record.writeUInt16LE(usaOffset, 0x04)
  record.writeUInt16LE(usaCount, 0x06)
  record.writeBigUInt64LE(0n, 0x08) // $LogFile LSN
  record.writeUInt16LE(spec.sequenceNumber ?? 1, 0x10)
  record.writeUInt16LE(1, 0x12) // hard link count
  record.writeUInt16LE(firstAttributeOffset, 0x14)

  const flags = (spec.inUse === false ? 0 : 0x01) | (spec.isDirectory === true ? 0x02 : 0)
  record.writeUInt16LE(flags, 0x16)

  let cursor = firstAttributeOffset
  for (const attribute of spec.attributes) {
    attribute.copy(record, cursor)
    cursor += attribute.length
  }

  // 0xFFFFFFFF terminates the attribute list.
  record.writeUInt32LE(0xffffffff, cursor)
  cursor += 8

  record.writeUInt32LE(cursor, 0x18) // used size
  record.writeUInt32LE(size, 0x1c) // allocated size
  record.writeBigUInt64LE(BigInt(spec.baseRecordNumber ?? 0), 0x20)
  record.writeUInt16LE(0, 0x28)
  record.writeUInt32LE(spec.recordNumber, 0x2c)

  applyOutgoingFixups(record, sectorSize, usaOffset, usaCount, spec.breakFixups === true)

  return record
}

/**
 * Write the update sequence array, displacing the last two bytes of each sector.
 * This is the inverse of the parser's `applyFixups`.
 */
function applyOutgoingFixups(
  record: Buffer,
  sectorSize: number,
  usaOffset: number,
  usaCount: number,
  breakThem: boolean,
): void {
  const sequenceNumber = 0x0042

  record.writeUInt16LE(sequenceNumber, usaOffset)

  for (let sector = 0; sector < usaCount - 1; sector += 1) {
    const tail = (sector + 1) * sectorSize - 2

    record.writeUInt16LE(record.readUInt16LE(tail), usaOffset + 2 + sector * 2)
    // A torn write leaves a sector whose trailing bytes are not the current
    // sequence number — which is precisely what the check exists to catch.
    record.writeUInt16LE(breakThem && sector === 0 ? 0xbeef : sequenceNumber, tail)
  }
}

/** Convenience: an ordinary file record with a name, timestamps and data. */
export function buildSimpleFile(options: {
  recordNumber: number
  name: string
  parentRecordNumber?: number
  sizeBytes?: number
  runs?: readonly RunSpec[]
  residentData?: Buffer
  inUse?: boolean
  isDirectory?: boolean
  times?: TimestampSpec
  nameSpace?: number
}): Buffer {
  const attributes: Buffer[] = [
    buildResidentAttribute(
      AttributeType.StandardInformation,
      buildStandardInformation(options.times),
    ),
    buildResidentAttribute(
      AttributeType.FileName,
      buildFileNameAttributeValue({
        name: options.name,
        parentRecordNumber: options.parentRecordNumber ?? 5,
        nameSpace: options.nameSpace ?? 1,
        realSize: options.sizeBytes ?? 0,
      }),
    ),
  ]

  if (options.residentData !== undefined) {
    attributes.push(buildResidentAttribute(AttributeType.Data, options.residentData))
  } else if (options.runs !== undefined) {
    attributes.push(
      buildNonResidentAttribute(AttributeType.Data, options.runs, {
        realSize: options.sizeBytes ?? 0,
      }),
    )
  }

  return buildFileRecord({
    recordNumber: options.recordNumber,
    inUse: options.inUse ?? true,
    isDirectory: options.isDirectory ?? false,
    attributes,
  })
}

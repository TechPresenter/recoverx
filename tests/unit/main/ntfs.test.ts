import { describe, expect, it } from 'vitest'
import {
  AttributeType,
  applyFixups,
  decodeRunList,
  filetimeToEpochMs,
  parseAttributes,
  parseFileRecord,
  parseNtfsBootSector,
  preferredFileName,
  runListSizeBytes,
  type NtfsFileName,
} from '@main/scan/ntfs/ntfs'
import {
  RECORD_SIZE,
  SECTOR_SIZE,
  buildFileNameAttributeValue,
  buildFileRecord,
  buildNonResidentAttribute,
  buildNtfsBootSector,
  buildResidentAttribute,
  buildSimpleFile,
  buildStandardInformation,
  encodeRunList,
  epochMsToFiletime,
} from './ntfs-fixtures'

describe('parseNtfsBootSector', () => {
  it('reads geometry from a standard volume', () => {
    const geometry = parseNtfsBootSector(buildNtfsBootSector())

    expect(geometry).not.toBeNull()
    expect(geometry?.bytesPerSector).toBe(512)
    expect(geometry?.sectorsPerCluster).toBe(8)
    expect(geometry?.clusterSizeBytes).toBe(4096)
    expect(geometry?.fileRecordSizeBytes).toBe(1024)
    expect(geometry?.mftClusterNumber).toBe(4)
  })

  it('decodes the signed power-of-two cluster factor', () => {
    // 0xF4 = -12 as a signed byte, meaning 2^12 = 4096 sectors per cluster.
    const geometry = parseNtfsBootSector(
      buildNtfsBootSector({ sectorsPerCluster: 0xf4, bytesPerSector: 512 }),
    )

    // Reading the byte plainly would give 244 sectors per cluster.
    expect(geometry?.sectorsPerCluster).toBe(4096)
  })

  it('decodes a positive record-size factor as a cluster count', () => {
    const geometry = parseNtfsBootSector(
      buildNtfsBootSector({ recordSizeFactor: 1, sectorsPerCluster: 1, bytesPerSector: 512 }),
    )

    expect(geometry?.fileRecordSizeBytes).toBe(512)
  })

  it('rejects a sector that is not NTFS', () => {
    expect(parseNtfsBootSector(Buffer.alloc(512))).toBeNull()
    expect(parseNtfsBootSector(Buffer.alloc(16))).toBeNull()
  })

  it('rejects implausible geometry rather than propagating it', () => {
    // A damaged field must not reach the scanner as a zero-byte cluster.
    expect(parseNtfsBootSector(buildNtfsBootSector({ bytesPerSector: 0 }))).toBeNull()
    expect(parseNtfsBootSector(buildNtfsBootSector({ bytesPerSector: 777 }))).toBeNull()
    expect(parseNtfsBootSector(buildNtfsBootSector({ sectorsPerCluster: 0 }))).toBeNull()
    expect(parseNtfsBootSector(buildNtfsBootSector({ mftCluster: 0 }))).toBeNull()
    expect(parseNtfsBootSector(buildNtfsBootSector({ totalSectors: 0 }))).toBeNull()
  })
})

describe('applyFixups', () => {
  it('restores the displaced bytes and accepts a consistent record', () => {
    const record = buildFileRecord({ recordNumber: 30, attributes: [] })

    // Before the pass, each sector ends with the sequence number.
    expect(record.readUInt16LE(SECTOR_SIZE - 2)).toBe(0x0042)
    expect(applyFixups(record, SECTOR_SIZE)).toBe(true)
    // After it, the original content is back.
    expect(record.readUInt16LE(SECTOR_SIZE - 2)).toBe(0)
  })

  it('rejects a record whose sectors were not all written', () => {
    const torn = buildFileRecord({ recordNumber: 31, attributes: [], breakFixups: true })

    expect(applyFixups(torn, SECTOR_SIZE)).toBe(false)
  })

  it('rejects a malformed or truncated update sequence array', () => {
    const record = buildFileRecord({ recordNumber: 32, attributes: [] })

    const noArray = Buffer.from(record)
    noArray.writeUInt16LE(0, 0x06)
    expect(applyFixups(noArray, SECTOR_SIZE)).toBe(false)

    const tooMany = Buffer.from(record)
    tooMany.writeUInt16LE(9999, 0x06)
    expect(applyFixups(tooMany, SECTOR_SIZE)).toBe(false)

    const outOfBounds = Buffer.from(record)
    outOfBounds.writeUInt16LE(RECORD_SIZE - 2, 0x04)
    expect(applyFixups(outOfBounds, SECTOR_SIZE)).toBe(false)

    expect(applyFixups(Buffer.alloc(8), SECTOR_SIZE)).toBe(false)
  })
})

describe('decodeRunList', () => {
  it('decodes a single contiguous run', () => {
    const runs = decodeRunList(encodeRunList([{ clusterCount: 100, startLcn: 5000 }]))

    expect(runs).toEqual([{ startLcn: 5000, clusterCount: 100, isSparse: false }])
  })

  it('decodes offsets as deltas from the previous run', () => {
    const runs = decodeRunList(
      encodeRunList([
        { clusterCount: 10, startLcn: 1000 },
        { clusterCount: 20, startLcn: 1200 },
        { clusterCount: 30, startLcn: 2000 },
      ]),
    )

    expect(runs.map((run) => run.startLcn)).toEqual([1000, 1200, 2000])
  })

  it('handles a backward fragment, where the delta is negative', () => {
    // Reading the delta unsigned is the classic NTFS bug: it works for the
    // first run of every file and misplaces every backward fragment.
    const runs = decodeRunList(
      encodeRunList([
        { clusterCount: 10, startLcn: 9000 },
        { clusterCount: 10, startLcn: 100 },
      ]),
    )

    expect(runs[1]?.startLcn).toBe(100)
  })

  it('decodes a sparse run, which occupies no space on disk', () => {
    const runs = decodeRunList(
      encodeRunList([
        { clusterCount: 5, startLcn: 100 },
        { clusterCount: 50 },
        { clusterCount: 5, startLcn: 200 },
      ]),
    )

    expect(runs[1]).toEqual({ startLcn: -1, clusterCount: 50, isSparse: true })
    // A sparse run must not disturb the delta base for what follows.
    expect(runs[2]?.startLcn).toBe(200)
  })

  it('stops at the terminator and ignores trailing bytes', () => {
    const encoded = Buffer.concat([
      encodeRunList([{ clusterCount: 7, startLcn: 42 }]),
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    ])

    expect(decodeRunList(encoded)).toHaveLength(1)
  })

  it('stops cleanly on a truncated runlist', () => {
    const full = encodeRunList([{ clusterCount: 1000, startLcn: 100_000 }])

    expect(() => decodeRunList(full.subarray(0, 2))).not.toThrow()
    expect(decodeRunList(full.subarray(0, 2))).toEqual([])
  })

  it('rejects a run that resolves to a negative cluster', () => {
    // Header: 1-byte length, 1-byte offset; delta -100 from a zero base.
    const damaged = Buffer.from([0x11, 0x05, 0x9c, 0x00])

    expect(decodeRunList(damaged)).toEqual([])
  })

  it('returns nothing for an empty or zero-terminated list', () => {
    expect(decodeRunList(Buffer.alloc(0))).toEqual([])
    expect(decodeRunList(Buffer.from([0x00]))).toEqual([])
  })

  it('totals the bytes a runlist addresses', () => {
    const runs = decodeRunList(
      encodeRunList([
        { clusterCount: 10, startLcn: 100 },
        { clusterCount: 6, startLcn: 500 },
      ]),
    )

    expect(runListSizeBytes(runs, 4096)).toBe(16 * 4096)
  })
})

describe('parseAttributes', () => {
  it('walks a list of resident attributes', () => {
    const record = buildFileRecord({
      recordNumber: 40,
      attributes: [
        buildResidentAttribute(AttributeType.StandardInformation, buildStandardInformation()),
        buildResidentAttribute(
          AttributeType.FileName,
          buildFileNameAttributeValue({ name: 'a.txt', parentRecordNumber: 5 }),
        ),
      ],
    })

    applyFixups(record, SECTOR_SIZE)
    const attributes = parseAttributes(record, record.readUInt16LE(0x14))

    expect(attributes.map((attribute) => attribute.type)).toEqual([
      AttributeType.StandardInformation,
      AttributeType.FileName,
    ])
  })

  it('stops on an attribute whose length overruns the record', () => {
    const record = buildFileRecord({
      recordNumber: 41,
      attributes: [buildResidentAttribute(AttributeType.Data, Buffer.from('hello'))],
    })
    applyFixups(record, SECTOR_SIZE)

    const first = record.readUInt16LE(0x14)
    record.writeUInt32LE(0x7fffffff, first + 4)

    expect(parseAttributes(record, first)).toEqual([])
  })

  it('stops on a zero-length attribute rather than looping', () => {
    const record = buildFileRecord({
      recordNumber: 42,
      attributes: [buildResidentAttribute(AttributeType.Data, Buffer.from('hello'))],
    })
    applyFixups(record, SECTOR_SIZE)

    const first = record.readUInt16LE(0x14)
    record.writeUInt32LE(0, first + 4)

    expect(parseAttributes(record, first)).toEqual([])
  })

  it('reads a named attribute, so alternate data streams are distinguishable', () => {
    const record = buildFileRecord({
      recordNumber: 43,
      attributes: [buildResidentAttribute(AttributeType.Data, Buffer.from('ads'), 'Zone')],
    })
    applyFixups(record, SECTOR_SIZE)

    const attributes = parseAttributes(record, record.readUInt16LE(0x14))
    expect(attributes[0]?.name).toBe('Zone')
  })

  it('reads non-resident header fields and its runlist', () => {
    const record = buildFileRecord({
      recordNumber: 44,
      attributes: [
        buildNonResidentAttribute(AttributeType.Data, [{ clusterCount: 25, startLcn: 8000 }], {
          realSize: 100_000,
          allocatedSize: 102_400,
          initializedSize: 100_000,
        }),
      ],
    })
    applyFixups(record, SECTOR_SIZE)

    const attribute = parseAttributes(record, record.readUInt16LE(0x14))[0]

    expect(attribute?.isResident).toBe(false)
    expect(attribute?.realSizeBytes).toBe(100_000)
    expect(attribute?.allocatedSizeBytes).toBe(102_400)
    expect(attribute?.runs).toEqual([{ startLcn: 8000, clusterCount: 25, isSparse: false }])
  })
})

describe('parseFileRecord', () => {
  it('parses an ordinary in-use file', () => {
    const raw = buildSimpleFile({
      recordNumber: 100,
      name: 'holiday.jpg',
      parentRecordNumber: 5,
      sizeBytes: 2_400_000,
      runs: [{ clusterCount: 600, startLcn: 40_000 }],
      times: { createdAt: Date.UTC(2025, 5, 1), modifiedAt: Date.UTC(2025, 5, 2) },
    })

    const record = parseFileRecord(raw, SECTOR_SIZE, 100)

    expect(record).not.toBeNull()
    expect(record?.recordNumber).toBe(100)
    expect(record?.inUse).toBe(true)
    expect(record?.isDirectory).toBe(false)
    expect(record?.isDamaged).toBe(false)
    expect(record?.names[0]?.name).toBe('holiday.jpg')
    expect(record?.names[0]?.parentRecordNumber).toBe(5)
    expect(record?.dataSizeBytes).toBe(2_400_000)
    expect(record?.dataRuns).toEqual([{ startLcn: 40_000, clusterCount: 600, isSparse: false }])
    expect(record?.timestamps.createdAt).toBe(Date.UTC(2025, 5, 1))
    expect(record?.timestamps.modifiedAt).toBe(Date.UTC(2025, 5, 2))
  })

  it('identifies a deleted record — the entire point of a quick scan', () => {
    const raw = buildSimpleFile({
      recordNumber: 101,
      name: 'deleted.docx',
      inUse: false,
      sizeBytes: 5000,
      runs: [{ clusterCount: 2, startLcn: 900 }],
    })

    const record = parseFileRecord(raw, SECTOR_SIZE, 101)

    expect(record?.inUse).toBe(false)
    // The runs survive deletion; that is what makes the file recoverable.
    expect(record?.dataRuns).toHaveLength(1)
  })

  it('identifies a directory', () => {
    const raw = buildSimpleFile({ recordNumber: 102, name: 'Photos', isDirectory: true })

    expect(parseFileRecord(raw, SECTOR_SIZE, 102)?.isDirectory).toBe(true)
  })

  it('returns resident data for a small file', () => {
    const contents = Buffer.from('a short note that fits inside the MFT record')
    const raw = buildSimpleFile({
      recordNumber: 103,
      name: 'note.txt',
      residentData: contents,
      sizeBytes: contents.length,
    })

    const record = parseFileRecord(raw, SECTOR_SIZE, 103)

    expect(record?.residentData?.toString()).toBe(contents.toString())
    expect(record?.dataRuns).toEqual([])
  })

  it('marks a record whose fixups failed as damaged', () => {
    const raw = buildFileRecord({
      recordNumber: 104,
      breakFixups: true,
      attributes: [
        buildResidentAttribute(
          AttributeType.FileName,
          buildFileNameAttributeValue({ name: 'torn.bin', parentRecordNumber: 5 }),
        ),
      ],
    })

    expect(parseFileRecord(raw, SECTOR_SIZE, 104)?.isDamaged).toBe(true)
  })

  it('rejects a buffer that is not a FILE record', () => {
    expect(parseFileRecord(Buffer.alloc(1024), SECTOR_SIZE, 0)).toBeNull()
    expect(parseFileRecord(Buffer.from('BAAD'), SECTOR_SIZE, 0)).toBeNull()
  })

  it('reports the base record of an extension record', () => {
    const raw = buildFileRecord({
      recordNumber: 200,
      baseRecordNumber: 100,
      attributes: [
        buildNonResidentAttribute(AttributeType.Data, [{ clusterCount: 5, startLcn: 700 }], {
          realSize: 20_480,
          startingVcn: 600,
        }),
      ],
    })

    const record = parseFileRecord(raw, SECTOR_SIZE, 200)

    expect(record?.baseRecordNumber).toBe(100)
  })

  it('ignores named data streams when sizing the file', () => {
    const raw = buildFileRecord({
      recordNumber: 105,
      attributes: [
        buildResidentAttribute(
          AttributeType.FileName,
          buildFileNameAttributeValue({ name: 'download.zip', parentRecordNumber: 5 }),
        ),
        buildNonResidentAttribute(AttributeType.Data, [{ clusterCount: 100, startLcn: 3000 }], {
          realSize: 400_000,
        }),
        // Mark-of-the-web, an alternate data stream. Not the file's contents.
        buildResidentAttribute(
          AttributeType.Data,
          Buffer.from('[ZoneTransfer]'),
          'Zone.Identifier',
        ),
      ],
    })

    const record = parseFileRecord(raw, SECTOR_SIZE, 105)

    expect(record?.dataSizeBytes).toBe(400_000)
    expect(record?.residentData).toBeNull()
  })

  it('flags compressed, encrypted and sparse data', () => {
    const build = (flags: number): ReturnType<typeof parseFileRecord> =>
      parseFileRecord(
        buildFileRecord({
          recordNumber: 106,
          attributes: [
            buildNonResidentAttribute(AttributeType.Data, [{ clusterCount: 4, startLcn: 10 }], {
              realSize: 16_384,
              flags,
            }),
          ],
        }),
        SECTOR_SIZE,
        106,
      )

    expect(build(0x0001)?.isCompressed).toBe(true)
    expect(build(0x4000)?.isEncrypted).toBe(true)
    expect(build(0x8000)?.isSparse).toBe(true)
  })
})

describe('preferredFileName', () => {
  const name = (value: string, nameSpace: number): NtfsFileName => ({
    parentRecordNumber: 5,
    name: value,
    nameSpace,
    realSizeBytes: 0,
    allocatedSizeBytes: 0,
    flags: 0,
  })

  it('prefers the Win32 long name over the 8.3 alias', () => {
    // Restoring a file as "PROGRA~1" would be actively wrong.
    const chosen = preferredFileName([name('PROGRA~1', 2), name('Program Files', 1)])

    expect(chosen?.name).toBe('Program Files')
  })

  it('accepts a combined Win32+DOS name', () => {
    expect(preferredFileName([name('readme.txt', 3)])?.name).toBe('readme.txt')
  })

  it('falls back to POSIX, then to whatever exists', () => {
    expect(preferredFileName([name('weird:name', 0)])?.name).toBe('weird:name')
    expect(preferredFileName([name('ONLY83~1', 2)])?.name).toBe('ONLY83~1')
    expect(preferredFileName([])).toBeNull()
  })
})

describe('filetimeToEpochMs', () => {
  it('round-trips a real timestamp', () => {
    const when = Date.UTC(2024, 0, 15, 12, 30, 0)

    expect(filetimeToEpochMs(epochMsToFiletime(when))).toBe(when)
  })

  it('treats zero as absent', () => {
    expect(filetimeToEpochMs(0n)).toBeNull()
  })

  it('rejects values outside a plausible range', () => {
    // Deleted records frequently carry partially overwritten timestamps; a file
    // dated to the year 30000 in the results grid destroys confidence in
    // everything else on screen.
    expect(filetimeToEpochMs(1n)).toBeNull()
    expect(filetimeToEpochMs(0xfffffffffffffffn)).toBeNull()
    expect(filetimeToEpochMs(epochMsToFiletime(Date.UTC(1970, 0, 1)))).toBeNull()
  })
})

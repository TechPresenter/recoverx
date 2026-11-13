import { describe, expect, it } from 'vitest'
import {
  FatAttributes,
  assumeContiguousChain,
  clusterToOffset,
  decodeFatDateTime,
  followClusterChain,
  parseFatBootSector,
  parseFatDirectory,
  readFatEntry,
} from '@main/scan/fat/fat'
import {
  decodeExfatTimestamp,
  exfatClusterToOffset,
  followExfatChain,
  parseExfatBootSector,
  parseExfatDirectory,
} from '@main/scan/fat/exfat'

// --- FAT fixtures ----------------------------------------------------------

interface FatBootOptions {
  bytesPerSector?: number
  sectorsPerCluster?: number
  reservedSectors?: number
  fatCount?: number
  rootEntries?: number
  sectorsPerFat?: number
  totalSectors?: number
  rootCluster?: number
  label?: string
  fat32?: boolean
}

function buildFatBoot(options: FatBootOptions = {}): Buffer {
  const sector = Buffer.alloc(512)
  const isFat32 = options.fat32 === true

  const bytesPerSector = options.bytesPerSector ?? 512
  const totalSectors = options.totalSectors ?? 100_000
  const sectorsPerFat = options.sectorsPerFat ?? 64

  sector.write('MSDOS5.0', 3, 'latin1')
  sector.writeUInt16LE(bytesPerSector, 0x0b)
  sector.writeUInt8(options.sectorsPerCluster ?? 4, 0x0d)
  sector.writeUInt16LE(options.reservedSectors ?? 1, 0x0e)
  sector.writeUInt8(options.fatCount ?? 2, 0x10)
  sector.writeUInt16LE(options.rootEntries ?? (isFat32 ? 0 : 512), 0x11)

  if (isFat32) {
    sector.writeUInt32LE(totalSectors, 0x20)
    sector.writeUInt32LE(sectorsPerFat, 0x24)
    sector.writeUInt32LE(options.rootCluster ?? 2, 0x2c)
    sector.write((options.label ?? 'NO NAME').padEnd(11, ' '), 0x47, 'latin1')
  } else {
    // Volumes above 65535 sectors must use the 32-bit total field.
    if (totalSectors > 0xffff) sector.writeUInt32LE(totalSectors, 0x20)
    else sector.writeUInt16LE(totalSectors, 0x13)
    sector.writeUInt16LE(sectorsPerFat, 0x16)
    sector.write((options.label ?? 'NO NAME').padEnd(11, ' '), 0x2b, 'latin1')
  }

  sector.writeUInt8(0x55, 0x1fe)
  sector.writeUInt8(0xaa, 0x1ff)

  return sector
}

interface ShortEntryOptions {
  name: string
  extension?: string
  attributes?: number
  firstCluster?: number
  sizeBytes?: number
  deleted?: boolean
  lowercaseName?: boolean
}

function buildShortEntry(options: ShortEntryOptions): Buffer {
  const entry = Buffer.alloc(32)

  entry.write(options.name.padEnd(8, ' ').slice(0, 8), 0, 'latin1')
  entry.write((options.extension ?? '').padEnd(3, ' ').slice(0, 3), 8, 'latin1')

  if (options.deleted === true) entry.writeUInt8(0xe5, 0)

  entry.writeUInt8(options.attributes ?? FatAttributes.Archive, 0x0b)
  entry.writeUInt8(options.lowercaseName === true ? 0x18 : 0x00, 0x0c)
  entry.writeUInt16LE(((options.firstCluster ?? 0) >>> 16) & 0xffff, 0x14)
  entry.writeUInt16LE((options.firstCluster ?? 0) & 0xffff, 0x1a)
  entry.writeUInt32LE(options.sizeBytes ?? 0, 0x1c)

  return entry
}

/**
 * Long-name entries, written the way FAT stores them: last fragment first, so
 * they appear in reverse order immediately before the 8.3 entry.
 */
function buildLongNameEntries(name: string, deleted = false): Buffer[] {
  const fragments: string[] = []
  for (let index = 0; index < name.length; index += 13) {
    fragments.push(name.slice(index, index + 13))
  }

  return fragments
    .map((fragment, index) => {
      // 0xFF padding is what a real formatter writes into the unused units.
      const entry = Buffer.alloc(32, 0xff)
      const isLast = index === fragments.length - 1

      entry.writeUInt8(deleted ? 0xe5 : (index + 1) | (isLast ? 0x40 : 0x00), 0)
      entry.writeUInt8(FatAttributes.LongName, 0x0b)
      entry.writeUInt8(0, 0x0c)
      entry.writeUInt8(0, 0x0d)
      entry.writeUInt16LE(0, 0x1a)

      const encoded = Buffer.from(fragment, 'utf16le')
      const slots = [
        { at: 0x01, size: 10 },
        { at: 0x0e, size: 12 },
        { at: 0x1c, size: 4 },
      ]

      let consumed = 0
      let terminated = false

      for (const slot of slots) {
        for (let byte = 0; byte < slot.size; byte += 2) {
          if (consumed < encoded.length) {
            entry.writeUInt16LE(encoded.readUInt16LE(consumed), slot.at + byte)
            consumed += 2
          } else if (!terminated) {
            entry.writeUInt16LE(0x0000, slot.at + byte)
            terminated = true
          }
        }
      }

      return entry
    })
    .reverse()
}

// --- exFAT fixtures --------------------------------------------------------

function buildExfatBoot(
  options: { volumeSectors?: number; clusterCount?: number; rootCluster?: number } = {},
): Buffer {
  const sector = Buffer.alloc(512)

  sector.write('EXFAT   ', 3, 'latin1')
  sector.writeBigUInt64LE(0n, 0x40)
  sector.writeBigUInt64LE(BigInt(options.volumeSectors ?? 1_000_000), 0x48)
  sector.writeUInt32LE(2048, 0x50)
  sector.writeUInt32LE(512, 0x54)
  sector.writeUInt32LE(4096, 0x58)
  sector.writeUInt32LE(options.clusterCount ?? 100_000, 0x5c)
  sector.writeUInt32LE(options.rootCluster ?? 5, 0x60)
  sector.writeUInt8(9, 0x6c) // 512-byte sectors
  sector.writeUInt8(3, 0x6d) // 8 sectors per cluster
  sector.writeUInt8(1, 0x6e)

  return sector
}

interface ExfatEntrySetOptions {
  name: string
  sizeBytes?: number
  firstCluster?: number
  contiguous?: boolean
  deleted?: boolean
  isDirectory?: boolean
  created?: number
}

function buildExfatEntrySet(options: ExfatEntrySetOptions): Buffer {
  const nameEntryCount = Math.max(1, Math.ceil(options.name.length / 15))
  const secondaryCount = 1 + nameEntryCount
  const buffer = Buffer.alloc((secondaryCount + 1) * 32)

  const inUse = options.deleted === true ? 0x00 : 0x80

  // File entry
  buffer.writeUInt8(0x05 | inUse, 0)
  buffer.writeUInt8(secondaryCount, 1)
  buffer.writeUInt16LE(options.isDirectory === true ? 0x10 : 0x20, 4)
  buffer.writeUInt32LE(options.created ?? 0, 8)
  buffer.writeUInt32LE(options.created ?? 0, 12)
  buffer.writeUInt32LE(options.created ?? 0, 16)

  // Stream extension
  const stream = 32
  buffer.writeUInt8(0x40 | inUse, stream)
  buffer.writeUInt8(0x01 | (options.contiguous === true ? 0x02 : 0x00), stream + 1)
  buffer.writeUInt8(options.name.length, stream + 3)
  buffer.writeBigUInt64LE(BigInt(options.sizeBytes ?? 0), stream + 8)
  buffer.writeUInt32LE(options.firstCluster ?? 0, stream + 0x14)
  buffer.writeBigUInt64LE(BigInt(options.sizeBytes ?? 0), stream + 0x18)

  // File name entries
  const encoded = Buffer.from(options.name, 'utf16le')
  for (let index = 0; index < nameEntryCount; index += 1) {
    const at = 64 + index * 32
    buffer.writeUInt8(0x41 | inUse, at)
    encoded.copy(buffer, at + 2, index * 30, Math.min((index + 1) * 30, encoded.length))
  }

  return buffer
}

// --- FAT geometry ----------------------------------------------------------

describe('parseFatBootSector', () => {
  it('classifies by cluster count, not by the label string', () => {
    // The "FAT16"/"FAT32" text is documentation; formatting tools write it
    // inconsistently and every real driver uses the count.
    expect(
      parseFatBootSector(buildFatBoot({ totalSectors: 8000, sectorsPerFat: 8 }))?.variant,
    ).toBe('fat12')
    expect(parseFatBootSector(buildFatBoot())?.variant).toBe('fat16')
    expect(
      parseFatBootSector(
        buildFatBoot({
          fat32: true,
          totalSectors: 1_000_000,
          sectorsPerCluster: 8,
          reservedSectors: 32,
          sectorsPerFat: 1000,
        }),
      )?.variant,
    ).toBe('fat32')
  })

  it('computes the data area layout', () => {
    const geometry = parseFatBootSector(buildFatBoot())

    expect(geometry?.bytesPerSector).toBe(512)
    expect(geometry?.clusterSizeBytes).toBe(2048)
    expect(geometry?.rootDirectorySectors).toBe(32)
    // reserved(1) + fats(2 x 64) + root(32)
    expect(geometry?.firstDataSector).toBe(161)
    expect(geometry?.firstRootDirectorySector).toBe(129)
  })

  it('reads the root cluster and skips the fixed root directory on FAT32', () => {
    const geometry = parseFatBootSector(
      buildFatBoot({
        fat32: true,
        totalSectors: 1_000_000,
        sectorsPerCluster: 8,
        reservedSectors: 32,
        sectorsPerFat: 1000,
        rootCluster: 7,
      }),
    )

    expect(geometry?.rootCluster).toBe(7)
    expect(geometry?.rootDirectorySectors).toBe(0)
    expect(geometry?.firstRootDirectorySector).toBe(0)
  })

  it('reads a volume label but ignores the NO NAME placeholder', () => {
    expect(parseFatBootSector(buildFatBoot({ label: 'CAMERA' }))?.volumeLabel).toBe('CAMERA')
    expect(parseFatBootSector(buildFatBoot())?.volumeLabel).toBeNull()
  })

  it('rejects geometry that cannot be true', () => {
    expect(parseFatBootSector(buildFatBoot({ bytesPerSector: 0 }))).toBeNull()
    expect(parseFatBootSector(buildFatBoot({ sectorsPerCluster: 0 }))).toBeNull()
    // Not a power of two.
    expect(parseFatBootSector(buildFatBoot({ sectorsPerCluster: 3 }))).toBeNull()
    expect(parseFatBootSector(buildFatBoot({ reservedSectors: 0 }))).toBeNull()
    expect(parseFatBootSector(buildFatBoot({ fatCount: 0 }))).toBeNull()
    expect(parseFatBootSector(buildFatBoot({ totalSectors: 10 }))).toBeNull()
    expect(parseFatBootSector(Buffer.alloc(64))).toBeNull()
  })

  it('maps clusters to byte offsets, counting from cluster 2', () => {
    const geometry = parseFatBootSector(buildFatBoot())!

    expect(clusterToOffset(geometry, 2)).toBe(161 * 512)
    expect(clusterToOffset(geometry, 3)).toBe(161 * 512 + 2048)
  })
})

// --- FAT table -------------------------------------------------------------

describe('readFatEntry', () => {
  it('unpacks FAT12 entries, which share bytes between neighbours', () => {
    // Entries 0..2 packed into 4.5 bytes: 0x123, 0x456, 0x789.
    const fat = Buffer.from([0x23, 0x61, 0x45, 0x89, 0x07])

    expect(readFatEntry(fat, 'fat12', 0)).toBe(0x123)
    expect(readFatEntry(fat, 'fat12', 1)).toBe(0x456)
    expect(readFatEntry(fat, 'fat12', 2)).toBe(0x789)
  })

  it('reads FAT16 and masks the reserved bits of FAT32', () => {
    const fat16 = Buffer.alloc(8)
    fat16.writeUInt16LE(0x1234, 4)
    expect(readFatEntry(fat16, 'fat16', 2)).toBe(0x1234)

    const fat32 = Buffer.alloc(16)
    // The top four bits are reserved and must not reach the caller.
    fat32.writeUInt32LE(0xf0000abc, 8)
    expect(readFatEntry(fat32, 'fat32', 2)).toBe(0x0abc)
  })

  it('returns 0 past the end of the table rather than throwing', () => {
    expect(readFatEntry(Buffer.alloc(4), 'fat32', 9999)).toBe(0)
    expect(readFatEntry(Buffer.alloc(4), 'fat12', -1)).toBe(0)
  })
})

describe('followClusterChain', () => {
  const geometry = parseFatBootSector(buildFatBoot())!

  const buildFat16 = (links: Record<number, number>): Buffer => {
    const fat = Buffer.alloc(4096)
    for (const [cluster, next] of Object.entries(links)) {
      fat.writeUInt16LE(next, Number(cluster) * 2)
    }
    return fat
  }

  it('follows a chain to its end marker', () => {
    expect(followClusterChain(buildFat16({ 2: 3, 3: 4, 4: 0xffff }), geometry, 2)).toEqual([
      2, 3, 4,
    ])
  })

  it('stops at a free entry, which is what deletion leaves behind', () => {
    expect(followClusterChain(buildFat16({ 2: 3, 3: 0 }), geometry, 2)).toEqual([2, 3])
  })

  it('stops at a bad-cluster marker', () => {
    expect(followClusterChain(buildFat16({ 2: 3, 3: 0xfff7 }), geometry, 2)).toEqual([2, 3])
  })

  it('does not hang on a cycle, which damaged tables routinely contain', () => {
    expect(followClusterChain(buildFat16({ 2: 3, 3: 4, 4: 2 }), geometry, 2)).toEqual([2, 3, 4])
  })

  it('rejects an out-of-range starting cluster', () => {
    expect(followClusterChain(buildFat16({}), geometry, 0)).toEqual([])
    expect(followClusterChain(buildFat16({}), geometry, 999_999)).toEqual([])
  })
})

describe('assumeContiguousChain', () => {
  const geometry = parseFatBootSector(buildFatBoot())!

  it('covers exactly the clusters a file of that size needs', () => {
    // 2048-byte clusters: 5000 bytes needs three.
    expect(assumeContiguousChain(geometry, 10, 5000)).toEqual([10, 11, 12])
    expect(assumeContiguousChain(geometry, 10, 2048)).toEqual([10])
  })

  it('clamps at the end of the volume', () => {
    const chain = assumeContiguousChain(geometry, geometry.clusterCount, 1024 * 1024 * 100)

    expect(chain.length).toBeLessThanOrEqual(3)
  })

  it('returns nothing for an empty file or an invalid start', () => {
    expect(assumeContiguousChain(geometry, 10, 0)).toEqual([])
    expect(assumeContiguousChain(geometry, 0, 5000)).toEqual([])
  })
})

// --- FAT directories -------------------------------------------------------

describe('parseFatDirectory', () => {
  it('reads a plain 8.3 entry', () => {
    const buffer = Buffer.concat([
      buildShortEntry({ name: 'REPORT', extension: 'TXT', firstCluster: 5, sizeBytes: 1234 }),
      Buffer.alloc(32),
    ])

    const { entries, reachedEnd } = parseFatDirectory(buffer)

    expect(reachedEnd).toBe(true)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('REPORT.TXT')
    expect(entries[0]?.firstCluster).toBe(5)
    expect(entries[0]?.sizeBytes).toBe(1234)
    expect(entries[0]?.isDeleted).toBe(false)
  })

  it('reassembles a long name from its fragments', () => {
    const longName = 'My Holiday Photographs 2025.jpeg'
    const buffer = Buffer.concat([
      ...buildLongNameEntries(longName),
      buildShortEntry({ name: 'MYHOLI~1', extension: 'JPE', firstCluster: 20, sizeBytes: 999 }),
      Buffer.alloc(32),
    ])

    const { entries } = parseFatDirectory(buffer)

    expect(entries[0]?.name).toBe(longName)
    expect(entries[0]?.hasLongName).toBe(true)
    expect(entries[0]?.shortName).toBe('MYHOLI~1.JPE')
  })

  it('detects a deleted entry and marks the lost first character', () => {
    const buffer = Buffer.concat([
      buildShortEntry({
        name: 'SECRET',
        extension: 'DOC',
        deleted: true,
        firstCluster: 42,
        sizeBytes: 8000,
      }),
      Buffer.alloc(32),
    ])

    const { entries } = parseFatDirectory(buffer)

    expect(entries[0]?.isDeleted).toBe(true)
    // The 0xE5 marker destroyed the first character; dropping it silently would
    // produce "ECRET.DOC", which looks real and is wrong.
    expect(entries[0]?.name).toBe('_ECRET.DOC')
    // The first cluster and the size survive — that is what makes it recoverable.
    expect(entries[0]?.firstCluster).toBe(42)
    expect(entries[0]?.sizeBytes).toBe(8000)
  })

  it('still recovers the long name of a deleted file', () => {
    const buffer = Buffer.concat([
      ...buildLongNameEntries('Quarterly Report Final.docx', true),
      buildShortEntry({ name: 'QUARTE~1', extension: 'DOC', deleted: true, firstCluster: 77 }),
      Buffer.alloc(32),
    ])

    const { entries } = parseFatDirectory(buffer)

    expect(entries[0]?.name).toBe('Quarterly Report Final.docx')
    expect(entries[0]?.isDeleted).toBe(true)
  })

  it('stops at the end-of-directory marker and ignores what follows', () => {
    const buffer = Buffer.concat([
      buildShortEntry({ name: 'FIRST', extension: 'TXT' }),
      Buffer.alloc(32),
      buildShortEntry({ name: 'AFTER', extension: 'TXT' }),
    ])

    expect(parseFatDirectory(buffer).entries).toHaveLength(1)
  })

  it('identifies directories and volume labels', () => {
    const buffer = Buffer.concat([
      buildShortEntry({ name: 'PHOTOS', attributes: FatAttributes.Directory, firstCluster: 9 }),
      buildShortEntry({ name: 'MYDISK', attributes: FatAttributes.VolumeLabel }),
      Buffer.alloc(32),
    ])

    const { entries } = parseFatDirectory(buffer)

    expect(entries[0]?.isDirectory).toBe(true)
    expect(entries[1]?.isVolumeLabel).toBe(true)
  })

  it('applies the Windows lower-case flags', () => {
    const buffer = Buffer.concat([
      buildShortEntry({ name: 'README', extension: 'TXT', lowercaseName: true }),
      Buffer.alloc(32),
    ])

    expect(parseFatDirectory(buffer).entries[0]?.name).toBe('readme.txt')
  })

  it('reassembles the 32-bit first cluster from its split halves', () => {
    // FAT32 stores the high word at 0x14 and the low word at 0x1A.
    const buffer = Buffer.concat([
      buildShortEntry({ name: 'BIG', extension: 'BIN', firstCluster: 0x00123456 }),
      Buffer.alloc(32),
    ])

    expect(parseFatDirectory(buffer).entries[0]?.firstCluster).toBe(0x00123456)
  })

  it('handles a truncated buffer without throwing', () => {
    expect(() => parseFatDirectory(Buffer.alloc(20))).not.toThrow()
    expect(parseFatDirectory(Buffer.alloc(20)).entries).toEqual([])
  })
})

describe('decodeFatDateTime', () => {
  it('decodes a packed date and time', () => {
    const date = ((2024 - 1980) << 9) | (3 << 5) | 15
    const time = (14 << 11) | (30 << 5) | 0

    expect(decodeFatDateTime(date, time)).toBe(Date.UTC(2024, 2, 15, 14, 30, 0))
  })

  it('treats a zero date as absent', () => {
    expect(decodeFatDateTime(0, 0)).toBeNull()
  })

  it('rejects impossible components rather than rolling them over', () => {
    // Date.UTC would happily turn month 15 into the following year.
    expect(decodeFatDateTime((44 << 9) | (15 << 5) | 1, 0)).toBeNull()
    expect(decodeFatDateTime((44 << 9) | (3 << 5) | 0, 0)).toBeNull()
    expect(decodeFatDateTime((44 << 9) | (3 << 5) | 1, 25 << 11)).toBeNull()
  })
})

// --- exFAT -----------------------------------------------------------------

describe('parseExfatBootSector', () => {
  it('decodes shift-encoded geometry', () => {
    const geometry = parseExfatBootSector(buildExfatBoot())

    expect(geometry?.bytesPerSector).toBe(512)
    expect(geometry?.sectorsPerCluster).toBe(8)
    expect(geometry?.clusterSizeBytes).toBe(4096)
    expect(geometry?.rootDirectoryCluster).toBe(5)
    expect(geometry?.clusterCount).toBe(100_000)
  })

  it('rejects a non-exFAT sector and out-of-range shifts', () => {
    expect(parseExfatBootSector(Buffer.alloc(512))).toBeNull()

    const badShift = buildExfatBoot()
    badShift.writeUInt8(200, 0x6c)
    expect(parseExfatBootSector(badShift)).toBeNull()

    expect(parseExfatBootSector(buildExfatBoot({ rootCluster: 0 }))).toBeNull()
  })

  it('maps clusters to offsets from the cluster heap', () => {
    const geometry = parseExfatBootSector(buildExfatBoot())!

    expect(exfatClusterToOffset(geometry, 2)).toBe(4096 * 512)
    expect(exfatClusterToOffset(geometry, 3)).toBe(4096 * 512 + 4096)
  })
})

describe('followExfatChain', () => {
  const geometry = parseExfatBootSector(buildExfatBoot())!

  it('follows a 32-bit chain to its terminator', () => {
    const fat = Buffer.alloc(64)
    fat.writeUInt32LE(3, 8)
    fat.writeUInt32LE(4, 12)
    fat.writeUInt32LE(0xffffffff, 16)

    expect(followExfatChain(fat, geometry, 2)).toEqual([2, 3, 4])
  })

  it('does not hang on a cycle', () => {
    const fat = Buffer.alloc(64)
    fat.writeUInt32LE(3, 8)
    fat.writeUInt32LE(2, 12)

    expect(followExfatChain(fat, geometry, 2)).toEqual([2, 3])
  })
})

describe('parseExfatDirectory', () => {
  it('assembles a file from its File, Stream and Name entries', () => {
    const buffer = Buffer.concat([
      buildExfatEntrySet({
        name: 'IMG_0421.CR3',
        sizeBytes: 28_000_000,
        firstCluster: 640,
        contiguous: true,
      }),
      Buffer.alloc(32),
    ])

    const { entries, reachedEnd } = parseExfatDirectory(buffer)

    expect(reachedEnd).toBe(true)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('IMG_0421.CR3')
    expect(entries[0]?.sizeBytes).toBe(28_000_000)
    expect(entries[0]?.firstCluster).toBe(640)
    expect(entries[0]?.isContiguous).toBe(true)
    expect(entries[0]?.isDeleted).toBe(false)
  })

  it('reads a long name spanning several Name entries', () => {
    const name = 'A considerably longer file name than fifteen characters.mov'
    const { entries } = parseExfatDirectory(
      Buffer.concat([buildExfatEntrySet({ name }), Buffer.alloc(32)]),
    )

    // `nameLength` is authoritative; trusting the padding would append stray
    // characters to every long name.
    expect(entries[0]?.name).toBe(name)
  })

  it('detects deletion from the cleared in-use bit, keeping every field', () => {
    const { entries } = parseExfatDirectory(
      Buffer.concat([
        buildExfatEntrySet({
          name: 'deleted-clip.mp4',
          sizeBytes: 5_000_000,
          firstCluster: 900,
          contiguous: true,
          deleted: true,
        }),
        Buffer.alloc(32),
      ]),
    )

    expect(entries[0]?.isDeleted).toBe(true)
    // exFAT keeps the name and the contiguity flag through deletion, which is
    // why a deleted exFAT file can be recovered exactly rather than assumed.
    expect(entries[0]?.name).toBe('deleted-clip.mp4')
    expect(entries[0]?.isContiguous).toBe(true)
    expect(entries[0]?.firstCluster).toBe(900)
  })

  it('reports a fragmented file, whose chain must be followed', () => {
    const { entries } = parseExfatDirectory(
      Buffer.concat([
        buildExfatEntrySet({ name: 'frag.bin', contiguous: false }),
        Buffer.alloc(32),
      ]),
    )

    expect(entries[0]?.isContiguous).toBe(false)
  })

  it('identifies directories', () => {
    const { entries } = parseExfatDirectory(
      Buffer.concat([buildExfatEntrySet({ name: 'DCIM', isDirectory: true }), Buffer.alloc(32)]),
    )

    expect(entries[0]?.isDirectory).toBe(true)
  })

  it('skips bitmap, upcase and label entries', () => {
    const bitmap = Buffer.alloc(32)
    bitmap.writeUInt8(0x81, 0)
    const label = Buffer.alloc(32)
    label.writeUInt8(0x83, 0)

    const { entries } = parseExfatDirectory(
      Buffer.concat([bitmap, label, buildExfatEntrySet({ name: 'real.txt' }), Buffer.alloc(32)]),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('real.txt')
  })

  it('counts an incomplete entry set instead of inventing a file', () => {
    // A File entry whose Stream entry was overwritten.
    const orphan = Buffer.alloc(64)
    orphan.writeUInt8(0x85, 0)
    orphan.writeUInt8(2, 1)

    const { entries, incompleteSets } = parseExfatDirectory(
      Buffer.concat([orphan, Buffer.alloc(32)]),
    )

    expect(entries).toHaveLength(0)
    expect(incompleteSets).toBe(1)
  })

  it('handles a truncated buffer without throwing', () => {
    expect(() => parseExfatDirectory(Buffer.alloc(20))).not.toThrow()
  })
})

describe('decodeExfatTimestamp', () => {
  it('decodes the packed 32-bit form', () => {
    const packed = ((2023 - 1980) << 25) | (7 << 21) | (4 << 16) | (9 << 11) | (15 << 5) | 15

    expect(decodeExfatTimestamp(packed)).toBe(Date.UTC(2023, 6, 4, 9, 15, 30))
  })

  it('treats zero as absent and rejects impossible components', () => {
    expect(decodeExfatTimestamp(0)).toBeNull()
    expect(decodeExfatTimestamp((43 << 25) | (13 << 21) | (1 << 16))).toBeNull()
  })
})

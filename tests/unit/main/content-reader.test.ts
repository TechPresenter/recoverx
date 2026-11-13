import { describe, expect, it } from 'vitest'
import { BufferBlockReader } from '@main/disk/block-device'
import {
  decodeText,
  extentsLength,
  findEmbeddedJpeg,
  formatHexDump,
  looksLikeText,
  readExtents,
} from '@main/preview/content-reader'
import type { FileExtent } from '@shared/types/scan'

/** A device image whose byte at every offset encodes that offset. */
function rampDevice(length = 4096): Buffer {
  const buffer = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) buffer.writeUInt8(index & 0xff, index)
  return buffer
}

describe('readExtents', () => {
  const device = new BufferBlockReader(Buffer.from('AAAABBBBCCCCDDDDEEEE', 'latin1'))

  it('reads a single extent', async () => {
    const extents: FileExtent[] = [{ offsetBytes: 4, lengthBytes: 4 }]

    expect((await readExtents(device, extents, { maxBytes: 100 })).toString()).toBe('BBBB')
  })

  it('joins fragmented extents in logical order', async () => {
    // The clusters are out of physical order; the file's bytes are not.
    const extents: FileExtent[] = [
      { offsetBytes: 16, lengthBytes: 4 },
      { offsetBytes: 0, lengthBytes: 4 },
      { offsetBytes: 8, lengthBytes: 4 },
    ]

    expect((await readExtents(device, extents, { maxBytes: 100 })).toString()).toBe('EEEEAAAACCCC')
  })

  it('stops at the byte budget', async () => {
    const extents: FileExtent[] = [
      { offsetBytes: 0, lengthBytes: 8 },
      { offsetBytes: 8, lengthBytes: 8 },
    ]

    expect((await readExtents(device, extents, { maxBytes: 6 })).toString()).toBe('AAAABB')
  })

  it('skips whole extents that fall before the window', async () => {
    const extents: FileExtent[] = [
      { offsetBytes: 0, lengthBytes: 4 },
      { offsetBytes: 4, lengthBytes: 4 },
      { offsetBytes: 8, lengthBytes: 4 },
    ]

    expect((await readExtents(device, extents, { maxBytes: 100, skipBytes: 4 })).toString()).toBe(
      'BBBBCCCC',
    )
  })

  it('skips partway into an extent', async () => {
    const extents: FileExtent[] = [{ offsetBytes: 0, lengthBytes: 8 }]

    expect((await readExtents(device, extents, { maxBytes: 100, skipBytes: 2 })).toString()).toBe(
      'AABBBB',
    )
  })

  it('returns what it could read when the device ends early', async () => {
    // A partially readable file is still worth showing.
    const extents: FileExtent[] = [{ offsetBytes: 16, lengthBytes: 100 }]

    expect((await readExtents(device, extents, { maxBytes: 100 })).toString()).toBe('EEEE')
  })

  it('returns empty for a zero budget, no extents, or empty extents', async () => {
    expect(await readExtents(device, [], { maxBytes: 100 })).toHaveLength(0)
    expect(
      await readExtents(device, [{ offsetBytes: 0, lengthBytes: 4 }], { maxBytes: 0 }),
    ).toHaveLength(0)
    expect(
      await readExtents(device, [{ offsetBytes: 0, lengthBytes: 0 }], { maxBytes: 10 }),
    ).toHaveLength(0)
  })

  it('reads the correct bytes across a large fragmented file', async () => {
    const image = rampDevice(4096)
    const reader = new BufferBlockReader(image)

    const extents: FileExtent[] = [
      { offsetBytes: 2048, lengthBytes: 512 },
      { offsetBytes: 512, lengthBytes: 512 },
    ]

    const result = await readExtents(reader, extents, { maxBytes: 1024 })

    expect(result).toHaveLength(1024)
    expect(result[0]).toBe(2048 & 0xff)
    expect(result[512]).toBe(512 & 0xff)
  })
})

describe('extentsLength', () => {
  it('totals the extents, ignoring negatives', () => {
    expect(
      extentsLength([
        { offsetBytes: 0, lengthBytes: 100 },
        { offsetBytes: 500, lengthBytes: 250 },
        { offsetBytes: 900, lengthBytes: -5 },
      ]),
    ).toBe(350)
  })

  it('is zero for no extents', () => {
    expect(extentsLength([])).toBe(0)
  })
})

describe('findEmbeddedJpeg', () => {
  const jpeg = (payloadLength: number): Buffer =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(payloadLength, 0x41),
      Buffer.from([0xff, 0xd9]),
    ])

  it('extracts an embedded JPEG from surrounding data', () => {
    const raw = Buffer.concat([Buffer.alloc(64, 0x11), jpeg(100), Buffer.alloc(64, 0x22)])
    const found = findEmbeddedJpeg(raw)

    expect(found).not.toBeNull()
    expect(found?.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(found?.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
  })

  it('prefers the largest preview over the thumbnail', () => {
    // RAW files embed both. Showing a 160x120 icon when a full-size preview
    // exists is a poor result for the type where preview matters most.
    const raw = Buffer.concat([jpeg(50), Buffer.alloc(32), jpeg(500)])

    expect(findEmbeddedJpeg(raw)?.length).toBe(500 + 6)
  })

  it('ignores a byte pair that only looks like a start marker', () => {
    // FF D8 without the following FF is not a JPEG stream.
    const noise = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0x22, 0xff, 0xd9])

    expect(findEmbeddedJpeg(noise)).toBeNull()
  })

  it('returns null when there is no end marker', () => {
    expect(findEmbeddedJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x41]))).toBeNull()
  })

  it('returns null for empty or unrelated data', () => {
    expect(findEmbeddedJpeg(Buffer.alloc(0))).toBeNull()
    expect(findEmbeddedJpeg(Buffer.from('plain text'))).toBeNull()
  })
})

describe('formatHexDump', () => {
  it('renders offset, hex and printable columns', () => {
    const dump = formatHexDump(Buffer.from('ABC'), 256, 16)

    expect(dump).toContain('00000000')
    expect(dump).toContain('41 42 43')
    expect(dump.endsWith('ABC')).toBe(true)
  })

  it('replaces non-printable bytes with a dot', () => {
    const dump = formatHexDump(Buffer.from([0x00, 0x41, 0xff]), 256, 16)

    expect(dump.endsWith('.A.')).toBe(true)
  })

  it('wraps at the row width and honours the byte cap', () => {
    const rows = formatHexDump(Buffer.alloc(64, 0x41), 32, 16).split('\n')

    expect(rows).toHaveLength(2)
    expect(rows[1]?.startsWith('00000010')).toBe(true)
  })

  it('is empty for an empty buffer', () => {
    expect(formatHexDump(Buffer.alloc(0))).toBe('')
  })
})

describe('decodeText', () => {
  it('detects a UTF-8 BOM and strips it', () => {
    const result = decodeText(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo')]),
    )

    expect(result.text).toBe('héllo')
    expect(result.encoding).toBe('UTF-8 (BOM)')
  })

  it('decodes UTF-16 little endian', () => {
    const result = decodeText(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]),
    )

    expect(result.text).toBe('hello')
    expect(result.encoding).toBe('UTF-16 LE')
  })

  it('decodes UTF-16 big endian by swapping', () => {
    const payload = Buffer.from('hello', 'utf16le')
    payload.swap16()

    const result = decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), payload]))

    expect(result.text).toBe('hello')
    expect(result.encoding).toBe('UTF-16 BE')
  })

  it('falls back to UTF-8 with no BOM', () => {
    expect(decodeText(Buffer.from('plain')).encoding).toBe('UTF-8')
  })
})

describe('looksLikeText', () => {
  it('accepts ordinary text, including accents and newlines', () => {
    expect(looksLikeText(Buffer.from('Dear Anna,\r\n\tThank you for the café.\n'))).toBe(true)
  })

  it('rejects anything containing a NUL byte', () => {
    // Decisive: text files do not contain them, binaries almost always do.
    expect(looksLikeText(Buffer.from([0x41, 0x42, 0x00, 0x43]))).toBe(false)
  })

  it('rejects data dominated by control bytes', () => {
    expect(looksLikeText(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0b]))).toBe(false)
  })

  it('rejects an empty buffer', () => {
    expect(looksLikeText(Buffer.alloc(0))).toBe(false)
  })

  it('tolerates a small proportion of control bytes', () => {
    const mostlyText = Buffer.concat([Buffer.from('a'.repeat(200)), Buffer.from([0x01, 0x02])])

    expect(looksLikeText(mostlyText)).toBe(true)
  })
})

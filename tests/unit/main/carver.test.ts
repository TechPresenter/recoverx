import { describe, expect, it } from 'vitest'
import { BufferBlockReader } from '@main/disk/block-device'
import {
  CARVE_SIGNATURES,
  MAX_HEADER_BYTES,
  lengthStrategy,
  type CarveSignature,
} from '@main/scan/carve/carve-signatures'
import { dropNested, findHeaders, resolveCarvedFile } from '@main/scan/carve/carver'

const signature = (id: string): CarveSignature => {
  const found = CARVE_SIGNATURES.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no signature ${id}`)
  return found
}

// --- Builders --------------------------------------------------------------

/** A JPEG with a valid APPn marker and a terminator. */
function jpeg(payload = 2048): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(payload, 0x41),
    Buffer.from([0xff, 0xd9]),
  ])
}

/** A PNG with the IHDR its validator requires and an IEND terminator. */
function png(payload = 256): Buffer {
  const head = Buffer.alloc(16)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')

  return Buffer.concat([
    head,
    Buffer.alloc(payload, 0x42),
    Buffer.from([...Buffer.from('IEND', 'latin1'), 0xae, 0x42, 0x60, 0x82]),
  ])
}

/** A BMP whose header declares its own size. */
function bmp(size = 512): Buffer {
  const buffer = Buffer.alloc(size, 0x43)
  buffer.write('BM', 0, 'latin1')
  buffer.writeUInt32LE(size, 2)
  buffer.writeUInt32LE(40, 14) // BITMAPINFOHEADER
  return buffer
}

/** A RIFF/WAVE whose payload length is declared at offset 4. */
function wav(payload = 512): Buffer {
  const buffer = Buffer.alloc(8 + payload, 0x44)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(payload, 4)
  buffer.write('WAVE', 8, 'latin1')
  return buffer
}

/** A SQLite database whose header gives page size and count. */
function sqlite(pageSize = 4096, pages = 4): Buffer {
  const buffer = Buffer.alloc(pageSize * pages, 0x45)
  buffer.write('SQLite format 3\0', 0, 'latin1')
  buffer.writeUInt16BE(pageSize, 16)
  buffer.writeUInt32BE(pages, 28)
  return buffer
}

function withPadding(file: Buffer, before = 4096, after = 4096): Buffer {
  return Buffer.concat([Buffer.alloc(before, 0x00), file, Buffer.alloc(after, 0x00)])
}

// --- findHeaders -----------------------------------------------------------

describe('findHeaders', () => {
  it('finds a JPEG at a known offset', () => {
    const image = withPadding(jpeg())
    const matches = findHeaders(image, 0)

    expect(matches).toHaveLength(1)
    expect(matches[0]?.signature.id).toBe('jpeg')
    expect(matches[0]?.offsetBytes).toBe(4096)
  })

  it('reports offsets relative to the region base', () => {
    const matches = findHeaders(withPadding(jpeg()), 1_000_000)

    expect(matches[0]?.offsetBytes).toBe(1_004_096)
  })

  it('finds several files in one buffer, in order', () => {
    const image = Buffer.concat([
      Buffer.alloc(512),
      jpeg(1024),
      Buffer.alloc(512),
      png(),
      Buffer.alloc(512),
    ])

    const ids = findHeaders(image, 0).map((match) => match.signature.id)

    expect(ids).toContain('jpeg')
    expect(ids).toContain('png')
    expect(findHeaders(image, 0).map((m) => m.offsetBytes)).toEqual(
      [...findHeaders(image, 0).map((m) => m.offsetBytes)].sort((a, b) => a - b),
    )
  })

  it('rejects a JPEG header with an impossible marker byte', () => {
    // FF D8 FF occurs constantly inside compressed data. Without the marker
    // check, a 2 TB scan would return a hundred thousand phantom images.
    const fake = Buffer.concat([
      Buffer.alloc(64),
      Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      Buffer.alloc(512),
    ])

    expect(findHeaders(fake, 0)).toHaveLength(0)
  })

  it('rejects a PNG signature not followed by IHDR', () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x00),
    ])

    expect(findHeaders(fake, 0)).toHaveLength(0)
  })

  it('separates the RIFF family by their form type', () => {
    // WAV, AVI and WebP share the RIFF header and differ four bytes later.
    const ids = findHeaders(withPadding(wav()), 0).map((match) => match.signature.id)

    expect(ids).toEqual(['wav'])
  })

  it('accounts for a header that sits inside the file', () => {
    // MP4's 'ftyp' marker follows a four-byte box size, so the file begins
    // earlier than the pattern that identifies it.
    const mp4 = Buffer.alloc(4096, 0x00)
    mp4.writeUInt32BE(32, 1000)
    mp4.write('ftyp', 1004, 'latin1')
    mp4.write('isom', 1008, 'latin1')

    const matches = findHeaders(mp4, 0, { signatures: [signature('mp4')] })

    expect(matches).toHaveLength(1)
    expect(matches[0]?.offsetBytes).toBe(1000)
  })

  it('honours the usable length so an overlap is not reported twice', () => {
    const image = withPadding(jpeg(), 8192)

    // The header sits at 8192; a usable length below that must exclude it.
    expect(findHeaders(image, 0, { usableLength: 8000 })).toHaveLength(0)
    expect(findHeaders(image, 0, { usableLength: 9000 })).toHaveLength(1)
  })

  it('defers a match too close to the end for its validator', () => {
    // Deciding on a truncated view would be a guess; the next chunk has the
    // context and will see it.
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41])

    expect(findHeaders(truncated, 0)).toHaveLength(0)
  })

  it('finds nothing in empty or unremarkable data', () => {
    expect(findHeaders(Buffer.alloc(0), 0)).toEqual([])
    expect(findHeaders(Buffer.alloc(65_536), 0)).toEqual([])
  })

  it('reports a file embedded inside another as its own candidate', () => {
    // A JPEG inside a RAW is a genuine second candidate; which one the user
    // wants is decided later, not here.
    const container = Buffer.concat([png(64), jpeg(512)])
    const ids = findHeaders(container, 0).map((match) => match.signature.id)

    expect(ids).toContain('png')
    expect(ids).toContain('jpeg')
  })
})

// --- resolveCarvedFile -----------------------------------------------------

describe('resolveCarvedFile', () => {
  const resolve = async (image: Buffer, limit = image.length) => {
    const reader = new BufferBlockReader(image)
    const [match] = findHeaders(image, 0)
    if (match === undefined) return null

    return resolveCarvedFile(reader, match, { limitBytes: limit })
  }

  it('uses the declared length when the header carries one', async () => {
    const file = await resolve(withPadding(bmp(2048)))

    expect(file?.signatureId).toBe('bmp')
    expect(file?.sizeBytes).toBe(2048)
    expect(file?.lengthSource).toBe('header')
  })

  it('reads the RIFF payload length and adds the preamble', async () => {
    const file = await resolve(withPadding(wav(1024)))

    expect(file?.sizeBytes).toBe(1024 + 8)
    expect(file?.lengthSource).toBe('header')
  })

  it('computes a SQLite size from page size times page count', async () => {
    const file = await resolve(withPadding(sqlite(4096, 3)))

    expect(file?.sizeBytes).toBe(4096 * 3)
    expect(file?.lengthSource).toBe('header')
  })

  it('stops at the terminator for a footer-delimited format', async () => {
    const image = withPadding(jpeg(4096))
    const file = await resolve(image)

    expect(file?.lengthSource).toBe('footer')
    // Header (4) + payload + terminator (2).
    expect(file?.sizeBytes).toBe(4 + 4096 + 2)
  })

  it('does not terminate inside its own header', async () => {
    const file = await resolve(withPadding(png(128)))

    expect(file?.lengthSource).toBe('footer')
    expect(file?.sizeBytes).toBeGreaterThan(128)
  })

  it('falls back to the cap when no terminator is present', async () => {
    // A truncated file has no terminator. The readable bytes are still worth
    // offering, marked as approximate.
    const truncated = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(8192, 0x41),
    ])

    const file = await resolve(truncated)

    expect(file?.lengthSource).toBe('capped')
    expect(file?.sizeBytes).toBe(truncated.length)
  })

  it('ignores a declared length that runs past the device', async () => {
    const lying = bmp(512)
    lying.writeUInt32LE(500_000_000, 2)

    const file = await resolve(lying)

    // Falls back rather than trusting a field that cannot be true.
    expect(file?.lengthSource).toBe('capped')
    expect(file?.sizeBytes).toBeLessThanOrEqual(lying.length)
  })

  it('rejects a candidate with too little room to be a real file', async () => {
    const reader = new BufferBlockReader(withPadding(jpeg()))
    const [match] = findHeaders(withPadding(jpeg()), 0)

    // A limit that leaves only a handful of bytes after the header.
    expect(await resolveCarvedFile(reader, match!, { limitBytes: 4100 })).toBeNull()
  })

  it('never extends past the region limit', async () => {
    const image = withPadding(jpeg(4096), 4096, 65_536)
    const reader = new BufferBlockReader(image)
    const [match] = findHeaders(image, 0)

    const file = await resolveCarvedFile(reader, match!, { limitBytes: 6000 })

    expect(file).not.toBeNull()
    expect((file?.offsetBytes ?? 0) + (file?.sizeBytes ?? 0)).toBeLessThanOrEqual(6000)
  })
})

// --- dropNested ------------------------------------------------------------

describe('dropNested', () => {
  const file = (offsetBytes: number, sizeBytes: number) => ({
    signatureId: 'jpeg',
    label: 'JPEG image',
    extension: 'jpg',
    category: 'image' as const,
    offsetBytes,
    sizeBytes,
    lengthSource: 'footer' as const,
  })

  it('drops a candidate that starts inside an earlier file', () => {
    // Every embedded thumbnail becoming its own result would bury the scan in
    // duplicates.
    const kept = dropNested([file(0, 1000), file(200, 100), file(2000, 500)])

    expect(kept.map((entry) => entry.offsetBytes)).toEqual([0, 2000])
  })

  it('keeps a file starting exactly where the previous one ended', () => {
    const kept = dropNested([file(0, 1000), file(1000, 500)])

    expect(kept).toHaveLength(2)
  })

  it('handles an empty list', () => {
    expect(dropNested([])).toEqual([])
  })
})

// --- Signature table -------------------------------------------------------

describe('carving signature table', () => {
  it('has unique ids', () => {
    const ids = CARVE_SIGNATURES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every signature a non-empty header and sane bounds', () => {
    for (const entry of CARVE_SIGNATURES) {
      expect(entry.header.length).toBeGreaterThan(0)
      expect(entry.minSizeBytes).toBeGreaterThan(0)
      expect(entry.maxSizeBytes).toBeGreaterThan(entry.minSizeBytes)
    }
  })

  it('classifies each signature into exactly one length strategy', () => {
    for (const entry of CARVE_SIGNATURES) {
      expect(['header', 'footer', 'capped']).toContain(lengthStrategy(entry))
    }
  })

  it('exposes the longest header, which sizes the chunk overlap', () => {
    expect(MAX_HEADER_BYTES).toBe(
      CARVE_SIGNATURES.reduce((longest, entry) => Math.max(longest, entry.header.length), 0),
    )
    expect(MAX_HEADER_BYTES).toBeGreaterThan(0)
  })
})

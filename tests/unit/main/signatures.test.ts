import { describe, expect, it } from 'vitest'
import {
  FILE_SIGNATURES,
  hasNoSignature,
  identifyContent,
  verifyContent,
} from '@main/preview/signatures'

/** Build a buffer with `bytes` written at `offset`, zero-padded elsewhere. */
function withMagic(bytes: readonly number[] | string, offset = 0, length = 64): Buffer {
  const buffer = Buffer.alloc(length)
  const values = typeof bytes === 'string' ? [...bytes].map((c) => c.charCodeAt(0)) : bytes

  values.forEach((value, index) => {
    buffer.writeUInt8(value, offset + index)
  })

  return buffer
}

describe('identifyContent', () => {
  it('recognises common image formats', () => {
    expect(identifyContent(withMagic([0xff, 0xd8, 0xff]))?.id).toBe('jpeg')
    expect(identifyContent(withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.id).toBe(
      'png',
    )
    expect(identifyContent(withMagic('GIF89a'))?.id).toBe('gif')
    expect(identifyContent(withMagic('WEBP', 8))?.id).toBe('webp')
  })

  it('recognises documents and archives', () => {
    expect(identifyContent(withMagic('%PDF-1.7'))?.id).toBe('pdf')
    expect(identifyContent(withMagic([0x50, 0x4b, 0x03, 0x04]))?.id).toBe('zip')
    expect(identifyContent(withMagic([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))?.id).toBe(
      'ole2',
    )
    expect(identifyContent(withMagic('SQLite format 3'))?.id).toBe('sqlite')
  })

  it('puts Canon CR3 ahead of the generic MP4 container', () => {
    // Both are ISO base media. Checked in the wrong order, every CR3 would be
    // reported as a video.
    expect(identifyContent(withMagic('ftypcrx ', 4))?.id).toBe('cr3')
    expect(identifyContent(withMagic('ftypisom', 4))?.id).toBe('mp4')
  })

  it('distinguishes CR2 from a plain little-endian TIFF via its wildcard', () => {
    const cr2 = withMagic([0x49, 0x49, 0x2a, 0x00])
    // Offset 4-7 is the IFD pointer (any value); 8-9 carries the "CR" marker.
    cr2.writeUInt32LE(0x00000010, 4)
    cr2.write('CR', 8, 'latin1')

    expect(identifyContent(cr2)?.id).toBe('cr2')
    expect(identifyContent(withMagic([0x49, 0x49, 0x2a, 0x00]))?.id).toBe('tiff-le')
  })

  it('returns null for content it does not recognise', () => {
    expect(identifyContent(Buffer.from('just some plain text here'))).toBeNull()
    expect(identifyContent(Buffer.alloc(0))).toBeNull()
  })

  it('does not read past the end of a short buffer', () => {
    expect(() => identifyContent(Buffer.from([0xff, 0xd8]))).not.toThrow()
    expect(identifyContent(Buffer.from([0xff, 0xd8]))).toBeNull()
  })
})

describe('verifyContent', () => {
  it('confirms bytes that match the extension', () => {
    const result = verifyContent(withMagic([0xff, 0xd8, 0xff]), 'jpg')

    expect(result.verdict).toBe('match')
    expect(result.detectedLabel).toBe('JPEG image')
  })

  it('accepts any extension a format legitimately uses', () => {
    // .docx, .xlsx and .jar are all ZIP archives; flagging a valid .docx as
    // corrupt because its bytes say "ZIP" would be worse than useless.
    const zip = withMagic([0x50, 0x4b, 0x03, 0x04])

    expect(verifyContent(zip, 'docx').verdict).toBe('match')
    expect(verifyContent(zip, 'xlsx').verdict).toBe('match')
    expect(verifyContent(zip, 'zip').verdict).toBe('match')
  })

  it('is case-insensitive and tolerates a leading dot', () => {
    const jpeg = withMagic([0xff, 0xd8, 0xff])

    expect(verifyContent(jpeg, 'JPG').verdict).toBe('match')
    expect(verifyContent(jpeg, '.Jpeg').verdict).toBe('match')
  })

  it('reports a mismatch when the bytes are identifiably something else', () => {
    // A PNG recovered under a .jpg name: recoverable, but not what it claims.
    const result = verifyContent(withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'jpg')

    expect(result.verdict).toBe('mismatch')
    expect(result.detectedLabel).toBe('PNG image')
  })

  it('reports a blank head as a mismatch, not as unknown', () => {
    // The commonest failure for a deleted file whose clusters were reused: the
    // metadata survives perfectly while the data is gone.
    const result = verifyContent(Buffer.alloc(64), 'jpg')

    expect(result.verdict).toBe('mismatch')
    expect(result.isBlank).toBe(true)
  })

  it('reports unknown rather than mismatch for a format with no magic bytes', () => {
    // Marking a perfectly good .txt as corrupt would be a lie.
    const result = verifyContent(Buffer.from('Dear Anna,\n\nThank you for'), 'txt')

    expect(result.verdict).toBe('unknown')
    expect(result.isBlank).toBe(false)
  })

  it('names the format even when there is no extension to compare against', () => {
    const result = verifyContent(withMagic([0xff, 0xd8, 0xff]), '')

    expect(result.verdict).toBe('unknown')
    expect(result.detectedLabel).toBe('JPEG image')
  })

  it('reports an empty read distinctly from a blank one', () => {
    expect(verifyContent(Buffer.alloc(0), 'jpg').verdict).toBe('empty')
  })
})

describe('hasNoSignature', () => {
  it('knows which extensions carry no magic bytes', () => {
    expect(hasNoSignature('txt')).toBe(true)
    expect(hasNoSignature('.CSV')).toBe(true)
    expect(hasNoSignature('json')).toBe(true)
    expect(hasNoSignature('jpg')).toBe(false)
    expect(hasNoSignature('pdf')).toBe(false)
  })
})

describe('signature table', () => {
  it('has unique ids', () => {
    const ids = FILE_SIGNATURES.map((signature) => signature.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares at least one extension for every signature', () => {
    expect(FILE_SIGNATURES.every((signature) => signature.extensions.length > 0)).toBe(true)
  })

  it('lists every extension in lower case, without a dot', () => {
    const bad = FILE_SIGNATURES.flatMap((signature) =>
      signature.extensions.filter(
        (extension) => extension !== extension.toLowerCase() || extension.startsWith('.'),
      ),
    )

    expect(bad).toEqual([])
  })
})

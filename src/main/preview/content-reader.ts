import type { FileExtent } from '@shared/types/scan'
import type { BlockReader } from '../disk/block-device'

/**
 * Reading recovered file content from its extents.
 *
 * The same machinery serves preview and recovery, which is why it streams by
 * extent rather than assembling a whole file: previewing a 40 GB disk image
 * must read a few kilobytes, and recovering one must never hold it in memory.
 *
 * Every read is read-only, through the same `BlockReader` the scanner used —
 * there is no path in this module that can write to the source device.
 */

/** Bytes read for the signature check and hex dump. */
export const HEAD_PROBE_BYTES = 4096

export interface ReadExtentsOptions {
  /** Stop after this many bytes. */
  readonly maxBytes: number
  /** Skip this many bytes from the logical start of the file. */
  readonly skipBytes?: number
}

/**
 * Read a window of a file's contents.
 *
 * Extents are consumed in order, so the result is the file's bytes in their
 * logical sequence even when the clusters are scattered across the volume.
 * A short read — the device ended, or a bad sector truncated an extent — yields
 * a shorter buffer rather than an error: a partially readable file is still
 * worth showing.
 */
export async function readExtents(
  reader: BlockReader,
  extents: readonly FileExtent[],
  options: ReadExtentsOptions,
): Promise<Buffer> {
  const maxBytes = Math.max(0, options.maxBytes)
  if (maxBytes === 0 || extents.length === 0) return Buffer.alloc(0)

  let remainingSkip = Math.max(0, options.skipBytes ?? 0)
  let remaining = maxBytes

  const chunks: Buffer[] = []

  for (const extent of extents) {
    if (remaining <= 0) break
    if (extent.lengthBytes <= 0) continue

    // Skip whole extents that fall before the requested window.
    if (remainingSkip >= extent.lengthBytes) {
      remainingSkip -= extent.lengthBytes
      continue
    }

    const offset = extent.offsetBytes + remainingSkip
    const available = extent.lengthBytes - remainingSkip
    remainingSkip = 0

    const length = Math.min(available, remaining)

    let chunk: Buffer
    try {
      chunk = await reader.read(offset, length)
    } catch {
      // A bad sector ends the read here rather than failing the whole preview.
      break
    }

    if (chunk.length === 0) break

    chunks.push(chunk)
    remaining -= chunk.length

    // A short read means the device would not give us the rest.
    if (chunk.length < length) break
  }

  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks)
}

/** Total addressable length of a set of extents. */
export function extentsLength(extents: readonly FileExtent[]): number {
  return extents.reduce((total, extent) => total + Math.max(0, extent.lengthBytes), 0)
}

/**
 * Locate the largest embedded JPEG in a buffer.
 *
 * Camera RAW files (CR2, NEF, ARW, DNG, ORF…) embed one or more full-colour
 * JPEG previews. Decoding the RAW sensor data itself would need a per-vendor
 * decoder; the embedded preview is what every photo tool actually displays, and
 * finding it is a scan for the SOI/EOI marker pair.
 *
 * The largest match is chosen because RAW files also embed a small thumbnail,
 * and showing a 160x120 icon when a full-size preview exists would be a poor
 * result for the one file type where preview matters most.
 */
export function findEmbeddedJpeg(buffer: Buffer): Buffer | null {
  const SOI_SECOND = 0xd8
  const EOI_SECOND = 0xd9
  const MARKER = 0xff

  let best: Buffer | null = null
  let index = 0

  while (index < buffer.length - 1) {
    if (buffer[index] !== MARKER || buffer[index + 1] !== SOI_SECOND) {
      index += 1
      continue
    }

    // A JPEG stream opens FF D8 FF; the third byte separates a real start from
    // two bytes that happen to collide.
    if (buffer[index + 2] !== MARKER) {
      index += 1
      continue
    }

    const end = findEndOfImage(buffer, index + 2, MARKER, EOI_SECOND)
    if (end === -1) {
      index += 2
      continue
    }

    const candidate = buffer.subarray(index, end + 2)
    if (best === null || candidate.length > best.length) best = candidate

    index = end + 2
  }

  return best
}

function findEndOfImage(buffer: Buffer, from: number, marker: number, eoi: number): number {
  for (let index = from; index < buffer.length - 1; index += 1) {
    if (buffer[index] === marker && buffer[index + 1] === eoi) return index
  }

  return -1
}

/**
 * Format a hex dump.
 *
 * Always available, whatever the file type. For a recovery user deciding
 * whether a result is worth restoring, seeing that the first sixteen bytes are
 * zeroes — or that they are somebody else's database page — settles the
 * question faster than any rendered preview.
 */
export function formatHexDump(buffer: Buffer, maxBytes = 256, bytesPerRow = 16): string {
  const length = Math.min(buffer.length, maxBytes)
  if (length === 0) return ''

  const rows: string[] = []

  for (let offset = 0; offset < length; offset += bytesPerRow) {
    const slice = buffer.subarray(offset, Math.min(offset + bytesPerRow, length))

    const hex = [...slice]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(bytesPerRow * 3 - 1, ' ')

    // Printable ASCII only; everything else becomes a dot, as in every hex
    // editor. Rendering raw control characters would corrupt the layout.
    const text = [...slice]
      .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'))
      .join('')

    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${text}`)
  }

  return rows.join('\n')
}

/**
 * Decode a buffer as text, detecting the encoding from its byte-order mark.
 *
 * Falls back to UTF-8, which is correct for the overwhelming majority of files
 * and degrades to replacement characters rather than to an exception.
 */
export function decodeText(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' }
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'UTF-16 LE' }
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Node has no UTF-16BE decoder; swapping to LE is the standard workaround.
    const swapped = Buffer.from(buffer.subarray(2))
    if (swapped.length % 2 === 0) swapped.swap16()
    return { text: swapped.toString('utf16le'), encoding: 'UTF-16 BE' }
  }

  return { text: buffer.toString('utf8'), encoding: 'UTF-8' }
}

/**
 * `true` when a buffer looks like text rather than binary.
 *
 * Used to offer a text preview for files with no signature. The heuristic is
 * the proportion of bytes outside the printable range, ignoring the usual
 * whitespace — the same test `file(1)` and most editors apply.
 */
export function looksLikeText(buffer: Buffer, sampleBytes = 1024): boolean {
  const length = Math.min(buffer.length, sampleBytes)
  if (length === 0) return false

  let suspicious = 0

  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index] ?? 0

    // A NUL byte in the first kilobyte is decisive: text files do not contain
    // them, and binary formats almost always do.
    if (byte === 0x00) return false

    const isPrintable = byte >= 0x20 && byte <= 0x7e
    const isWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d
    // Bytes above 0x7F are assumed to be multi-byte UTF-8 sequences.
    const isHighByte = byte >= 0x80

    if (!isPrintable && !isWhitespace && !isHighByte) suspicious += 1
  }

  return suspicious / length < 0.1
}

import type { FileCategory } from '@shared/types/scan'

/**
 * Carving signatures.
 *
 * A deep scan finds files by their *contents* — it reads raw sectors looking
 * for the byte patterns that begin known formats. This is what recovers data
 * from a volume whose filesystem is gone: after a format, a repartition, or
 * corruption severe enough that no directory survives.
 *
 * The hard part is not finding the start of a file. It is knowing where it
 * ends. Three strategies, in descending order of reliability:
 *
 *   1. **Length in the header.** BMP, RIFF, SQLite and the ISO base-media
 *      formats all record their own size. Exact, and worth the parsing.
 *   2. **A terminator.** JPEG, PNG, GIF and PDF end with a defined marker.
 *      Reliable, but a truncated file has none, so a cap is still needed.
 *   3. **A size cap.** Everything else. The carved file will contain trailing
 *      slack from whatever followed it on disk — usually harmless for media,
 *      which ignores trailing bytes, and honest about being approximate.
 *
 * Validators exist because a three-byte header matches by chance roughly every
 * sixteen million bytes. On a 2 TB scan that is a hundred thousand false
 * positives per signature, which would bury the real results.
 */

export type LengthStrategy = 'header' | 'footer' | 'capped'

export interface CarveSignature {
  readonly id: string
  readonly label: string
  /** Extension given to the carved file. */
  readonly extension: string
  readonly category: FileCategory
  /** Bytes that begin the format. */
  readonly header: readonly number[]
  /**
   * Where the header sits inside the file.
   *
   * Almost always 0. The ISO base-media formats are the exception: their
   * recognisable `ftyp` marker is preceded by a four-byte box size, so the file
   * actually starts four bytes earlier.
   */
  readonly headerOffsetInFile?: number | undefined
  /** Bytes that end it, when the format defines a terminator. */
  readonly footer?: readonly number[] | undefined
  /** Upper bound on a carved file of this type. */
  readonly maxSizeBytes: number
  /**
   * Smallest plausible file. Anything shorter is a false positive, not a file —
   * a 40-byte "JPEG" is a coincidence.
   */
  readonly minSizeBytes: number
  /**
   * Read the length the header declares.
   * Returns `null` when the format does not carry one, or the value is absurd.
   */
  readonly readLength?: ((buffer: Buffer, offset: number) => number | null) | undefined
  /** Reject a header that matched by chance. */
  readonly validate?: ((buffer: Buffer, offset: number) => boolean) | undefined
}

const MB = 1024 * 1024

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0))

/** Safe bounded read; returns `null` rather than throwing past the end. */
function u32le(buffer: Buffer, offset: number): number | null {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : null
}

function u32be(buffer: Buffer, offset: number): number | null {
  return offset + 4 <= buffer.length ? buffer.readUInt32BE(offset) : null
}

/** Reject a declared length that cannot be real. */
function plausible(length: number | null, min: number, max: number): number | null {
  if (length === null || !Number.isFinite(length)) return null
  return length >= min && length <= max ? length : null
}

export const CARVE_SIGNATURES: readonly CarveSignature[] = [
  // --- Images -------------------------------------------------------------
  {
    id: 'jpeg',
    label: 'JPEG image',
    extension: 'jpg',
    category: 'image',
    header: [0xff, 0xd8, 0xff],
    footer: [0xff, 0xd9],
    maxSizeBytes: 64 * MB,
    minSizeBytes: 1024,
    // The fourth byte must be an APPn, COM or quantisation marker. Without this
    // check, any FF D8 FF triple in compressed data starts a phantom file.
    validate: (buffer, offset) => {
      const marker = buffer[offset + 3]
      return marker !== undefined && marker >= 0xc0 && marker <= 0xfe
    },
  },
  {
    id: 'png',
    label: 'PNG image',
    extension: 'png',
    category: 'image',
    header: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    footer: [...ascii('IEND'), 0xae, 0x42, 0x60, 0x82],
    maxSizeBytes: 64 * MB,
    minSizeBytes: 128,
    // The signature is followed by an IHDR chunk in every valid PNG.
    validate: (buffer, offset) =>
      buffer.subarray(offset + 12, offset + 16).toString('latin1') === 'IHDR',
  },
  {
    id: 'gif',
    label: 'GIF image',
    extension: 'gif',
    category: 'image',
    header: ascii('GIF8'),
    footer: [0x3b],
    maxSizeBytes: 32 * MB,
    minSizeBytes: 64,
    validate: (buffer, offset) => {
      const version = buffer.subarray(offset + 4, offset + 6).toString('latin1')
      return version === '7a' || version === '9a'
    },
  },
  {
    id: 'bmp',
    label: 'Bitmap image',
    extension: 'bmp',
    category: 'image',
    header: ascii('BM'),
    maxSizeBytes: 128 * MB,
    minSizeBytes: 128,
    // The file size sits at offset 2, which makes BMP exact to carve.
    readLength: (buffer, offset) => plausible(u32le(buffer, offset + 2), 128, 128 * MB),
    validate: (buffer, offset) => {
      // The header size field only takes a handful of documented values.
      const headerSize = u32le(buffer, offset + 14)
      return headerSize === 12 || headerSize === 40 || headerSize === 108 || headerSize === 124
    },
  },
  {
    id: 'webp',
    label: 'WebP image',
    extension: 'webp',
    category: 'image',
    header: ascii('RIFF'),
    maxSizeBytes: 32 * MB,
    minSizeBytes: 64,
    // RIFF records payload length at offset 4, excluding the 8-byte preamble.
    readLength: (buffer, offset) => {
      const payload = u32le(buffer, offset + 4)
      return payload === null ? null : plausible(payload + 8, 64, 32 * MB)
    },
    validate: (buffer, offset) =>
      buffer.subarray(offset + 8, offset + 12).toString('latin1') === 'WEBP',
  },
  {
    id: 'psd',
    label: 'Photoshop document',
    extension: 'psd',
    category: 'design',
    header: ascii('8BPS'),
    maxSizeBytes: 512 * MB,
    minSizeBytes: 1024,
    validate: (buffer, offset) => {
      const version = buffer.readUInt16BE?.(offset + 4)
      return version === 1 || version === 2
    },
  },

  // --- Camera RAW ---------------------------------------------------------
  {
    id: 'cr2',
    label: 'Canon RAW',
    extension: 'cr2',
    category: 'image',
    header: [0x49, 0x49, 0x2a, 0x00],
    maxSizeBytes: 128 * MB,
    minSizeBytes: MB,
    validate: (buffer, offset) =>
      buffer.subarray(offset + 8, offset + 10).toString('latin1') === 'CR',
  },

  // --- Audio and video ----------------------------------------------------
  {
    id: 'wav',
    label: 'WAV audio',
    extension: 'wav',
    category: 'audio',
    header: ascii('RIFF'),
    maxSizeBytes: 512 * MB,
    minSizeBytes: 128,
    readLength: (buffer, offset) => {
      const payload = u32le(buffer, offset + 4)
      return payload === null ? null : plausible(payload + 8, 128, 512 * MB)
    },
    validate: (buffer, offset) =>
      buffer.subarray(offset + 8, offset + 12).toString('latin1') === 'WAVE',
  },
  {
    id: 'avi',
    label: 'AVI video',
    extension: 'avi',
    category: 'video',
    header: ascii('RIFF'),
    maxSizeBytes: 2048 * MB,
    minSizeBytes: 1024,
    readLength: (buffer, offset) => {
      const payload = u32le(buffer, offset + 4)
      return payload === null ? null : plausible(payload + 8, 1024, 2048 * MB)
    },
    validate: (buffer, offset) =>
      buffer.subarray(offset + 8, offset + 12).toString('latin1') === 'AVI ',
  },
  {
    id: 'mp4',
    label: 'MP4 video',
    extension: 'mp4',
    category: 'video',
    // The 'ftyp' box, whose four-byte size precedes it.
    header: ascii('ftyp'),
    headerOffsetInFile: 4,
    maxSizeBytes: 4096 * MB,
    minSizeBytes: 4096,
    validate: (buffer, offset) => {
      // The box size must be sane, and the brand printable.
      const size = u32be(buffer, offset - 4)
      if (size === null || size < 8 || size > 1024) return false

      const brand = buffer.subarray(offset + 4, offset + 8)
      return brand.length === 4 && [...brand].every((byte) => byte >= 0x20 && byte <= 0x7e)
    },
  },
  {
    id: 'mp3',
    label: 'MP3 audio',
    extension: 'mp3',
    category: 'audio',
    header: ascii('ID3'),
    maxSizeBytes: 64 * MB,
    minSizeBytes: 4096,
    validate: (buffer, offset) => {
      // ID3v2 major version is 2, 3 or 4; the byte after must not be 0xFF.
      const major = buffer[offset + 3]
      return major !== undefined && major >= 2 && major <= 4
    },
  },
  {
    id: 'flac',
    label: 'FLAC audio',
    extension: 'flac',
    category: 'audio',
    header: ascii('fLaC'),
    maxSizeBytes: 512 * MB,
    minSizeBytes: 4096,
  },
  {
    id: 'matroska',
    label: 'Matroska video',
    extension: 'mkv',
    category: 'video',
    header: [0x1a, 0x45, 0xdf, 0xa3],
    maxSizeBytes: 4096 * MB,
    minSizeBytes: 4096,
  },

  // --- Documents and archives --------------------------------------------
  {
    id: 'pdf',
    label: 'PDF document',
    extension: 'pdf',
    category: 'document',
    header: ascii('%PDF-'),
    footer: ascii('%%EOF'),
    maxSizeBytes: 256 * MB,
    minSizeBytes: 512,
    validate: (buffer, offset) => {
      // "%PDF-1.x" or "%PDF-2.x".
      const major = buffer[offset + 5]
      return major === 0x31 || major === 0x32
    },
  },
  {
    id: 'zip',
    label: 'ZIP archive',
    // Also covers .docx, .xlsx and .pptx, which are ZIPs. The container is what
    // can be identified from bytes alone; the user renames if they know better.
    extension: 'zip',
    category: 'archive',
    header: [0x50, 0x4b, 0x03, 0x04],
    footer: [0x50, 0x4b, 0x05, 0x06],
    maxSizeBytes: 1024 * MB,
    minSizeBytes: 128,
  },
  {
    id: 'rar',
    label: 'RAR archive',
    extension: 'rar',
    category: 'archive',
    header: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
    maxSizeBytes: 1024 * MB,
    minSizeBytes: 128,
  },
  {
    id: '7z',
    label: '7-Zip archive',
    extension: '7z',
    category: 'archive',
    header: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    maxSizeBytes: 1024 * MB,
    minSizeBytes: 128,
  },
  {
    id: 'ole2',
    label: 'Office 97-2003 document',
    extension: 'doc',
    category: 'document',
    header: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    maxSizeBytes: 256 * MB,
    minSizeBytes: 4096,
  },
  {
    id: 'rtf',
    label: 'Rich text',
    extension: 'rtf',
    category: 'document',
    header: ascii('{\\rtf'),
    maxSizeBytes: 64 * MB,
    minSizeBytes: 128,
  },

  // --- Data ---------------------------------------------------------------
  {
    id: 'sqlite',
    label: 'SQLite database',
    extension: 'db',
    category: 'database',
    header: ascii('SQLite format 3'),
    maxSizeBytes: 1024 * MB,
    minSizeBytes: 4096,
    // Page size at 16 (big-endian) times page count at 28 gives the exact size.
    readLength: (buffer, offset) => {
      if (offset + 32 > buffer.length) return null

      const rawPageSize = buffer.readUInt16BE(offset + 16)
      // The value 1 is a documented escape meaning 65536.
      const pageSize = rawPageSize === 1 ? 65_536 : rawPageSize
      const pageCount = buffer.readUInt32BE(offset + 28)

      if ((pageSize & (pageSize - 1)) !== 0 || pageSize < 512) return null
      if (pageCount === 0) return null

      return plausible(pageSize * pageCount, 512, 1024 * MB)
    },
  },
  {
    id: 'pst',
    label: 'Outlook data file',
    extension: 'pst',
    category: 'email',
    header: [0x21, 0x42, 0x44, 0x4e],
    maxSizeBytes: 4096 * MB,
    minSizeBytes: 4096,
  },
]

/** Which of the three strategies a signature will use. */
export function lengthStrategy(signature: CarveSignature): LengthStrategy {
  if (signature.readLength !== undefined) return 'header'
  if (signature.footer !== undefined) return 'footer'
  return 'capped'
}

/** Longest header in the table, used to size the overlap between read chunks. */
export const MAX_HEADER_BYTES = CARVE_SIGNATURES.reduce(
  (longest, signature) => Math.max(longest, signature.header.length),
  0,
)

/**
 * Bytes a validator may read past the header start.
 *
 * The chunk reader keeps at least this much beyond a candidate before deciding,
 * so a validator is never handed a truncated view and forced to guess.
 */
export const VALIDATION_LOOKAHEAD_BYTES = 64

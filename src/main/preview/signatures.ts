import type { FileCategory } from '@shared/types/scan'

/**
 * Content identification from magic bytes.
 *
 * This is the single most valuable check a recovery tool can perform. A file
 * recovered from a deleted MFT record carries a name and a size, but nothing
 * about that metadata proves the *clusters* still hold the file's contents. If
 * `holiday.jpg` starts with 4 KB of zeroes, or with the middle of a database
 * page, the user needs to know before they spend an hour restoring it.
 *
 * So the result of a verification is one of three things, never a boolean:
 *   - `match`    the bytes are what the extension claims
 *   - `mismatch` the bytes are identifiably something else
 *   - `unknown`  no signature is known for this type, so nothing is claimed
 *
 * Reporting `unknown` honestly matters as much as reporting a mismatch: a .txt
 * file has no magic bytes, and marking it "unverified" is truthful where
 * marking it "corrupt" would be a lie.
 */

export interface FileSignature {
  /** Identifier used in the UI, e.g. `jpeg`. */
  readonly id: string
  /** Human-readable format name. */
  readonly label: string
  readonly category: FileCategory
  /** Bytes that must appear at `offset`. */
  readonly magic: readonly number[]
  readonly offset: number
  /**
   * Extensions that legitimately carry this signature.
   *
   * Many-to-many on purpose: `.docx`, `.xlsx` and `.jar` are all ZIP archives,
   * and flagging a valid .docx as a mismatch because its bytes say "ZIP" would
   * be worse than useless.
   */
  readonly extensions: readonly string[]
  /** Bytes that must NOT appear, used to separate formats sharing a prefix. */
  readonly excludeMagic?: readonly number[] | undefined
}

/** `?` marks a wildcard byte in the patterns below. */
const ANY = -1

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0))

/**
 * Signature table, most specific first.
 *
 * Order matters: `ftypcrx` (Canon RAW) must be checked before the generic
 * `ftyp` MP4 family, or every CR3 would be reported as a video.
 */
export const FILE_SIGNATURES: readonly FileSignature[] = [
  // --- Images -------------------------------------------------------------
  {
    id: 'jpeg',
    label: 'JPEG image',
    category: 'image',
    magic: [0xff, 0xd8, 0xff],
    offset: 0,
    extensions: ['jpg', 'jpeg', 'jpe', 'thm'],
  },
  {
    id: 'png',
    label: 'PNG image',
    category: 'image',
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    offset: 0,
    extensions: ['png'],
  },
  {
    id: 'gif',
    label: 'GIF image',
    category: 'image',
    magic: ascii('GIF8'),
    offset: 0,
    extensions: ['gif'],
  },
  {
    id: 'bmp',
    label: 'Bitmap image',
    category: 'image',
    magic: ascii('BM'),
    offset: 0,
    extensions: ['bmp', 'dib'],
  },
  {
    id: 'webp',
    label: 'WebP image',
    category: 'image',
    magic: ascii('WEBP'),
    offset: 8,
    extensions: ['webp'],
  },
  {
    id: 'heic',
    label: 'HEIF image',
    category: 'image',
    magic: ascii('ftypheic'),
    offset: 4,
    extensions: ['heic', 'heif'],
  },
  {
    id: 'heix',
    label: 'HEIF image',
    category: 'image',
    magic: ascii('ftypmif1'),
    offset: 4,
    extensions: ['heic', 'heif', 'avif'],
  },
  {
    id: 'avif',
    label: 'AVIF image',
    category: 'image',
    magic: ascii('ftypavif'),
    offset: 4,
    extensions: ['avif'],
  },
  {
    id: 'psd',
    label: 'Photoshop document',
    category: 'design',
    magic: ascii('8BPS'),
    offset: 0,
    extensions: ['psd', 'psb'],
  },
  {
    id: 'ico',
    label: 'Icon',
    category: 'image',
    magic: [0x00, 0x00, 0x01, 0x00],
    offset: 0,
    extensions: ['ico'],
  },

  // Canon's CR3 uses the ISO base-media container, so it must precede MP4.
  {
    id: 'cr3',
    label: 'Canon RAW (CR3)',
    category: 'image',
    magic: ascii('ftypcrx'),
    offset: 4,
    extensions: ['cr3'],
  },
  // CR2 is TIFF with a "CR" marker at offset 8.
  {
    id: 'cr2',
    label: 'Canon RAW (CR2)',
    category: 'image',
    magic: [0x49, 0x49, 0x2a, 0x00, ANY, ANY, ANY, ANY, 0x43, 0x52],
    offset: 0,
    extensions: ['cr2'],
  },
  {
    id: 'tiff-le',
    label: 'TIFF image',
    category: 'image',
    magic: [0x49, 0x49, 0x2a, 0x00],
    offset: 0,
    extensions: ['tif', 'tiff', 'nef', 'arw', 'dng', 'orf', 'rw2', 'pef', 'srw', 'cr2'],
  },
  {
    id: 'tiff-be',
    label: 'TIFF image',
    category: 'image',
    magic: [0x4d, 0x4d, 0x00, 0x2a],
    offset: 0,
    extensions: ['tif', 'tiff', 'nef', 'arw', 'dng'],
  },

  // --- Documents ----------------------------------------------------------
  {
    id: 'pdf',
    label: 'PDF document',
    category: 'document',
    magic: ascii('%PDF-'),
    offset: 0,
    extensions: ['pdf'],
  },
  {
    id: 'rtf',
    label: 'Rich text',
    category: 'document',
    magic: ascii('{\\rtf'),
    offset: 0,
    extensions: ['rtf'],
  },
  // The legacy Office container, also used by .msi and older Visio files.
  {
    id: 'ole2',
    label: 'Office 97-2003 document',
    category: 'document',
    magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    offset: 0,
    extensions: ['doc', 'xls', 'ppt', 'msi', 'msg', 'vsd'],
  },
  {
    id: 'epub',
    label: 'EPUB book',
    category: 'document',
    magic: ascii('mimetypeapplication/epub'),
    offset: 30,
    extensions: ['epub'],
  },

  // --- Archives (and the modern Office formats, which are ZIPs) -----------
  {
    id: 'zip',
    label: 'ZIP archive',
    category: 'archive',
    magic: [0x50, 0x4b, 0x03, 0x04],
    offset: 0,
    extensions: [
      'zip',
      'docx',
      'xlsx',
      'pptx',
      'odt',
      'ods',
      'odp',
      'epub',
      'jar',
      'apk',
      'xpi',
      'kmz',
    ],
  },
  {
    id: 'zip-empty',
    label: 'ZIP archive',
    category: 'archive',
    magic: [0x50, 0x4b, 0x05, 0x06],
    offset: 0,
    extensions: ['zip', 'docx', 'xlsx', 'pptx'],
  },
  {
    id: 'rar',
    label: 'RAR archive',
    category: 'archive',
    magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
    offset: 0,
    extensions: ['rar'],
  },
  {
    id: '7z',
    label: '7-Zip archive',
    category: 'archive',
    magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    offset: 0,
    extensions: ['7z'],
  },
  {
    id: 'gzip',
    label: 'GZIP archive',
    category: 'archive',
    magic: [0x1f, 0x8b],
    offset: 0,
    extensions: ['gz', 'tgz', 'gzip'],
  },
  {
    id: 'bzip2',
    label: 'BZIP2 archive',
    category: 'archive',
    magic: ascii('BZh'),
    offset: 0,
    extensions: ['bz2'],
  },
  {
    id: 'xz',
    label: 'XZ archive',
    category: 'archive',
    magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
    offset: 0,
    extensions: ['xz'],
  },
  {
    id: 'cab',
    label: 'Cabinet archive',
    category: 'archive',
    magic: ascii('MSCF'),
    offset: 0,
    extensions: ['cab'],
  },
  {
    id: 'iso',
    label: 'ISO image',
    category: 'archive',
    magic: ascii('CD001'),
    offset: 0x8001,
    extensions: ['iso'],
  },

  // --- Audio and video ----------------------------------------------------
  {
    id: 'mp3-id3',
    label: 'MP3 audio',
    category: 'audio',
    magic: ascii('ID3'),
    offset: 0,
    extensions: ['mp3'],
  },
  {
    id: 'flac',
    label: 'FLAC audio',
    category: 'audio',
    magic: ascii('fLaC'),
    offset: 0,
    extensions: ['flac'],
  },
  {
    id: 'ogg',
    label: 'Ogg media',
    category: 'audio',
    magic: ascii('OggS'),
    offset: 0,
    extensions: ['ogg', 'oga', 'ogv', 'opus'],
  },
  {
    id: 'wav',
    label: 'WAV audio',
    category: 'audio',
    magic: ascii('WAVE'),
    offset: 8,
    extensions: ['wav'],
  },
  {
    id: 'aiff',
    label: 'AIFF audio',
    category: 'audio',
    magic: ascii('AIFF'),
    offset: 8,
    extensions: ['aif', 'aiff'],
  },
  {
    id: 'avi',
    label: 'AVI video',
    category: 'video',
    magic: ascii('AVI '),
    offset: 8,
    extensions: ['avi'],
  },
  {
    id: 'matroska',
    label: 'Matroska video',
    category: 'video',
    magic: [0x1a, 0x45, 0xdf, 0xa3],
    offset: 0,
    extensions: ['mkv', 'webm', 'mka'],
  },
  {
    id: 'mp4',
    label: 'MP4 video',
    category: 'video',
    magic: ascii('ftyp'),
    offset: 4,
    extensions: ['mp4', 'm4v', 'm4a', 'mov', '3gp', 'f4v'],
  },
  {
    id: 'asf',
    label: 'Windows Media',
    category: 'video',
    magic: [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11],
    offset: 0,
    extensions: ['wmv', 'wma', 'asf'],
  },
  {
    id: 'flv',
    label: 'Flash video',
    category: 'video',
    magic: ascii('FLV'),
    offset: 0,
    extensions: ['flv'],
  },
  {
    id: 'mpeg-ps',
    label: 'MPEG video',
    category: 'video',
    magic: [0x00, 0x00, 0x01, 0xba],
    offset: 0,
    extensions: ['mpg', 'mpeg', 'vob'],
  },

  // --- Data and executables ----------------------------------------------
  {
    id: 'sqlite',
    label: 'SQLite database',
    category: 'database',
    magic: ascii('SQLite format 3'),
    offset: 0,
    extensions: ['db', 'sqlite', 'sqlite3', 'db3'],
  },
  {
    id: 'pst',
    label: 'Outlook data file',
    category: 'email',
    magic: [0x21, 0x42, 0x44, 0x4e],
    offset: 0,
    extensions: ['pst', 'ost'],
  },
  {
    id: 'pe',
    label: 'Windows executable',
    category: 'executable',
    magic: ascii('MZ'),
    offset: 0,
    extensions: ['exe', 'dll', 'sys', 'ocx', 'scr'],
  },
  {
    id: 'elf',
    label: 'ELF executable',
    category: 'executable',
    magic: [0x7f, 0x45, 0x4c, 0x46],
    offset: 0,
    extensions: ['elf', 'so', 'o'],
  },
  {
    id: 'dwg',
    label: 'AutoCAD drawing',
    category: 'cad',
    magic: ascii('AC10'),
    offset: 0,
    extensions: ['dwg'],
  },
]

/** Bytes that must be read to evaluate every signature except the ISO check. */
export const SIGNATURE_PROBE_BYTES = 64

export type VerificationVerdict = 'match' | 'mismatch' | 'unknown' | 'empty'

export interface ContentVerification {
  readonly verdict: VerificationVerdict
  /** Identified format, when one was recognised. */
  readonly detectedId: string | null
  readonly detectedLabel: string | null
  /**
   * `true` when the leading bytes are all zero.
   *
   * The commonest failure mode for a deleted file whose clusters were reused:
   * the metadata survives perfectly while the data is gone.
   */
  readonly isBlank: boolean
}

/** Match a byte pattern, honouring wildcards. */
function matches(buffer: Buffer, signature: FileSignature): boolean {
  const end = signature.offset + signature.magic.length
  if (end > buffer.length) return false

  for (let index = 0; index < signature.magic.length; index += 1) {
    const expected = signature.magic[index]
    if (expected === ANY) continue
    if (buffer[signature.offset + index] !== expected) return false
  }

  return true
}

/** Identify content by its magic bytes. Returns `null` when nothing matches. */
export function identifyContent(buffer: Buffer): FileSignature | null {
  for (const signature of FILE_SIGNATURES) {
    if (matches(buffer, signature)) return signature
  }

  return null
}

/**
 * Check recovered bytes against the name they were recovered under.
 *
 * `extension` is compared case-insensitively and without a leading dot.
 */
export function verifyContent(buffer: Buffer, extension: string): ContentVerification {
  const isBlank =
    buffer.length > 0 && buffer.subarray(0, Math.min(buffer.length, 32)).every((byte) => byte === 0)

  if (buffer.length === 0) {
    return { verdict: 'empty', detectedId: null, detectedLabel: null, isBlank: true }
  }

  const normalised = extension.toLowerCase().replace(/^\./u, '')
  const detected = identifyContent(buffer)

  if (detected === null) {
    // Nothing recognised. An all-zero head is strong evidence of overwriting;
    // anything else is simply a format with no magic bytes (.txt, .csv, .log).
    return {
      verdict: isBlank ? 'mismatch' : 'unknown',
      detectedId: null,
      detectedLabel: null,
      isBlank,
    }
  }

  // A recognised format with no extension to compare against tells the user
  // what the file is, without claiming agreement it cannot assess.
  if (normalised.length === 0) {
    return {
      verdict: 'unknown',
      detectedId: detected.id,
      detectedLabel: detected.label,
      isBlank: false,
    }
  }

  return {
    verdict: detected.extensions.includes(normalised) ? 'match' : 'mismatch',
    detectedId: detected.id,
    detectedLabel: detected.label,
    isBlank: false,
  }
}

/** Extensions known to carry no magic bytes, so `unknown` is expected. */
const SIGNATURE_FREE_EXTENSIONS = new Set([
  'txt',
  'log',
  'csv',
  'tsv',
  'md',
  'json',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'sh',
  'ps1',
  'yml',
  'yaml',
  'ini',
  'cfg',
  'conf',
  'sql',
  'srt',
  'vtt',
])

/**
 * `true` when `unknown` is the expected answer for this extension, so the UI can
 * say "no signature to check" rather than implying something went wrong.
 */
export function hasNoSignature(extension: string): boolean {
  return SIGNATURE_FREE_EXTENSIONS.has(extension.toLowerCase().replace(/^\./u, ''))
}

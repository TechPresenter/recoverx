import type { BlockReader } from '../../disk/block-device'
import {
  CARVE_SIGNATURES,
  VALIDATION_LOOKAHEAD_BYTES,
  lengthStrategy,
  type CarveSignature,
  type LengthStrategy,
} from './carve-signatures'

/**
 * The carving engine.
 *
 * Split in two on purpose:
 *
 *   `findHeaders`       pure, synchronous, one pass over a buffer. All the
 *                       pattern matching lives here and is directly testable.
 *   `resolveCarvedFile` needs I/O, because a file's terminator frequently sits
 *                       beyond the buffer its header was found in.
 *
 * The scan is a single pass dispatched on the first byte. A naive
 * implementation runs `indexOf` once per signature, which on a 2 TB device
 * means twenty full passes over two terabytes. Here every byte is looked at
 * once, and the overwhelming majority are rejected by a single array index.
 */

export interface HeaderMatch {
  readonly signature: CarveSignature
  /** Absolute offset of the *file* start, not of the matched pattern. */
  readonly offsetBytes: number
}

export interface CarvedFile {
  readonly signatureId: string
  readonly label: string
  readonly extension: string
  readonly category: CarveSignature['category']
  readonly offsetBytes: number
  readonly sizeBytes: number
  /** How the length was decided, which is what the quality score reflects. */
  readonly lengthSource: LengthStrategy
}

/** First-byte dispatch table, built once per signature set. */
type DispatchTable = Array<readonly CarveSignature[] | undefined>

const dispatchCache = new WeakMap<readonly CarveSignature[], DispatchTable>()

function buildDispatch(signatures: readonly CarveSignature[]): DispatchTable {
  const cached = dispatchCache.get(signatures)
  if (cached !== undefined) return cached

  const table: DispatchTable = new Array<readonly CarveSignature[] | undefined>(256)
  const buckets = new Map<number, CarveSignature[]>()

  for (const signature of signatures) {
    const first = signature.header[0]
    if (first === undefined) continue

    const bucket = buckets.get(first) ?? []
    bucket.push(signature)
    buckets.set(first, bucket)
  }

  for (const [byte, bucket] of buckets) table[byte] = bucket

  dispatchCache.set(signatures, table)

  return table
}

export interface FindHeadersOptions {
  readonly signatures?: readonly CarveSignature[]
  /**
   * Only report matches beginning within this many bytes of the buffer start.
   *
   * Chunks overlap so a header spanning a boundary is still found, and this is
   * what stops the overlap being reported twice.
   */
  readonly usableLength?: number
}

/**
 * Find every signature header in a buffer.
 *
 * Matches are returned in ascending offset order. Overlapping matches are all
 * reported: a JPEG embedded in a RAW file is a genuine second candidate, and
 * deciding which the user wants is not this function's job.
 */
export function findHeaders(
  buffer: Buffer,
  baseOffset: number,
  options: FindHeadersOptions = {},
): HeaderMatch[] {
  const signatures = options.signatures ?? CARVE_SIGNATURES
  const table = buildDispatch(signatures)

  const limit = Math.min(options.usableLength ?? buffer.length, buffer.length)
  const matches: HeaderMatch[] = []

  for (let index = 0; index < limit; index += 1) {
    const candidates = table[buffer[index]!]
    // The common case by an enormous margin: no signature starts with this byte.
    if (candidates === undefined) continue

    for (const signature of candidates) {
      if (!matchesHeader(buffer, index, signature.header)) continue

      // A validator may read past the header; without enough bytes it would be
      // deciding on a truncated view, so the match is deferred to the chunk
      // that contains the context.
      if (signature.validate !== undefined) {
        if (index + VALIDATION_LOOKAHEAD_BYTES > buffer.length) continue
        if (!signature.validate(buffer, index)) continue
      }

      const fileStart = baseOffset + index - (signature.headerOffsetInFile ?? 0)
      // A header whose file would begin before the region started is a match on
      // the tail of something outside it.
      if (fileStart < baseOffset && index < (signature.headerOffsetInFile ?? 0)) continue

      matches.push({ signature, offsetBytes: fileStart })
    }
  }

  return matches
}

function matchesHeader(buffer: Buffer, offset: number, header: readonly number[]): boolean {
  if (offset + header.length > buffer.length) return false

  // Index 0 already matched via the dispatch table.
  for (let index = 1; index < header.length; index += 1) {
    if (buffer[offset + index] !== header[index]) return false
  }

  return true
}

/** Bytes read at a time while searching for a terminator. */
const FOOTER_WINDOW_BYTES = 1024 * 1024

export interface ResolveOptions {
  /** Highest offset the carved file may extend to. */
  readonly limitBytes: number
}

/**
 * Decide how long a carved file is.
 *
 * Returns `null` when the candidate cannot be a real file — a declared length
 * that runs past the device, or a footer-terminated format whose terminator is
 * nowhere within its maximum size.
 */
export async function resolveCarvedFile(
  reader: BlockReader,
  match: HeaderMatch,
  options: ResolveOptions,
): Promise<CarvedFile | null> {
  const { signature, offsetBytes } = match
  const strategy = lengthStrategy(signature)

  const available = Math.max(0, Math.min(options.limitBytes, reader.sizeBytes) - offsetBytes)
  if (available < signature.minSizeBytes) return null

  const build = (sizeBytes: number, lengthSource: LengthStrategy): CarvedFile => ({
    signatureId: signature.id,
    label: signature.label,
    extension: signature.extension,
    category: signature.category,
    offsetBytes,
    sizeBytes,
    lengthSource,
  })

  if (strategy === 'header' && signature.readLength !== undefined) {
    // The declared length lives in the first few dozen bytes.
    const head = await reader.read(offsetBytes, Math.min(128, available))
    const declared = signature.readLength(head, signature.headerOffsetInFile ?? 0)

    if (declared !== null && declared <= available) return build(declared, 'header')

    // A length field that does not survive its own sanity check means the
    // header is damaged or this was a false positive; fall back rather than
    // trusting it.
  }

  if (strategy === 'footer' || signature.footer !== undefined) {
    const end = await findFooter(reader, signature, offsetBytes, available)
    if (end !== null) return build(end, 'footer')

    // No terminator within the maximum size. For a truncated file that is
    // expected, so the capped length is still worth offering.
  }

  const capped = Math.min(signature.maxSizeBytes, available)
  return capped >= signature.minSizeBytes ? build(capped, 'capped') : null
}

/**
 * Search forward for a format's terminator.
 *
 * Windows overlap by the footer length so a terminator straddling a boundary is
 * not missed — the failure that produces a file truncated by exactly one window.
 */
async function findFooter(
  reader: BlockReader,
  signature: CarveSignature,
  offsetBytes: number,
  available: number,
): Promise<number | null> {
  const footer = signature.footer
  if (footer === undefined || footer.length === 0) return null

  const needle = Buffer.from(footer)
  const searchLimit = Math.min(signature.maxSizeBytes, available)

  let position = 0

  while (position < searchLimit) {
    const length = Math.min(FOOTER_WINDOW_BYTES, searchLimit - position)
    const window = await reader.read(offsetBytes + position, length)

    if (window.length === 0) break

    // Skip the header itself, so a format whose footer could match inside its
    // own signature does not terminate at byte zero.
    const from = position === 0 ? signature.header.length : 0
    const found = window.indexOf(needle, from)

    if (found !== -1) {
      const size = position + found + needle.length
      return size >= signature.minSizeBytes ? size : null
    }

    if (window.length < length) break

    // Step back by the footer length so a straddling terminator is still seen.
    position += Math.max(1, window.length - (needle.length - 1))
  }

  return null
}

/**
 * Drop candidates that begin inside a file already carved.
 *
 * Without this, every embedded thumbnail in a RAW file and every image inside a
 * ZIP becomes its own result, and a scan of a photo library returns tens of
 * thousands of duplicates the user has to wade through.
 *
 * Matches are assumed to arrive in ascending offset order.
 */
export function dropNested(files: readonly CarvedFile[]): CarvedFile[] {
  const kept: CarvedFile[] = []
  let coveredUntil = -1

  for (const file of files) {
    if (file.offsetBytes < coveredUntil) continue

    kept.push(file)
    coveredUntil = file.offsetBytes + file.sizeBytes
  }

  return kept
}

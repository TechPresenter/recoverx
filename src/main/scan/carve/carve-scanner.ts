import { categoryOf, type RecoveredFile, type RecoveryQuality } from '@shared/types/scan'
import type { BlockReader } from '../../disk/block-device'
import type { ScanBatch, ScanOptions } from '../scan-types'
import { CARVE_SIGNATURES, MAX_HEADER_BYTES, VALIDATION_LOOKAHEAD_BYTES } from './carve-signatures'
import { dropNested, findHeaders, resolveCarvedFile, type CarvedFile } from './carver'

/**
 * Deep scan.
 *
 * Where a quick scan reads the filesystem's own records, this reads the sectors
 * themselves. It is the only thing that works when the metadata is gone — after
 * a format, a repartition, or corruption that leaves no directory intact.
 *
 * The cost is what it cannot know. A carved file has no name, no timestamps and
 * no folder, because none of that lives in the file's own bytes. And because
 * carving assumes a file occupies consecutive sectors, a fragmented file is
 * recovered only as far as its first fragment. Both are stated in the results
 * rather than papered over.
 */

/**
 * Bytes read per iteration.
 *
 * Large enough that the per-read overhead disappears against the scan, small
 * enough that a paused scan stops promptly and memory stays flat.
 */
const CHUNK_BYTES = 8 * 1024 * 1024

/**
 * Overlap between consecutive chunks.
 *
 * A header straddling a boundary would otherwise be invisible to both chunks.
 * The overlap covers the longest header plus the lookahead a validator may use.
 */
const OVERLAP_BYTES = MAX_HEADER_BYTES + VALIDATION_LOOKAHEAD_BYTES

/** Results emitted per batch. */
const FILES_PER_BATCH = 256

export async function* carveVolume(
  reader: BlockReader,
  sessionId: string,
  volumeOffsetBytes: number,
  options: ScanOptions,
): AsyncGenerator<ScanBatch> {
  const total = reader.sizeBytes
  // Headers must *begin* within this bound. A file that starts inside it may
  // legitimately extend beyond, which is why the resolver gets the full device.
  const scanLimit = Math.min(total, options.maxUnits ?? total)

  let emitted: RecoveredFile[] = []
  let position = 0

  while (position < scanLimit) {
    const length = Math.min(CHUNK_BYTES + OVERLAP_BYTES, total - position)

    let chunk: Buffer
    try {
      chunk = await reader.read(position, length)
    } catch {
      // A bad sector costs this chunk, not the scan. Skipping forward is the
      // whole point of carving a failing drive.
      position += CHUNK_BYTES
      continue
    }

    if (chunk.length === 0) break

    // Only headers beginning in the non-overlapping part are ours to report;
    // the rest belong to the next chunk. Clamped to the scan bound as well, so a
    // caller asking for the first few kilobytes does not get a whole chunk.
    const usableLength = Math.min(CHUNK_BYTES, chunk.length, scanLimit - position)
    const matches = findHeaders(chunk, position, { usableLength })

    const resolved: CarvedFile[] = []
    for (const match of matches) {
      const file = await resolveCarvedFile(reader, match, { limitBytes: total })
      if (file !== null) resolved.push(file)
    }

    for (const carved of dropNested(resolved)) {
      emitted.push(toRecoveredFile(carved, sessionId, volumeOffsetBytes))
    }

    if (emitted.length >= FILES_PER_BATCH) {
      yield { files: emitted, processed: position + usableLength, total }
      emitted = []
    }

    position += usableLength
  }

  yield { files: emitted, processed: scanLimit, total }
}

/**
 * Turn a carved region into a result.
 *
 * The name is synthesised from the offset rather than a counter, so the same
 * volume scanned twice produces the same identifiers — which is what lets a
 * rescan update rows instead of duplicating them.
 */
function toRecoveredFile(
  carved: CarvedFile,
  sessionId: string,
  volumeOffsetBytes: number,
): RecoveredFile {
  const name = `${carved.signatureId}-${carved.offsetBytes.toString(16).padStart(12, '0')}.${carved.extension}`

  return {
    id: `${sessionId}:carve:${carved.offsetBytes}`,
    sessionId,
    name,
    // Carved files have no folder: the directory that held them is gone, which
    // is why a deep scan was needed. They are grouped by type instead.
    path: carved.label,
    extension: carved.extension,
    category: categoryOf(name) === 'other' ? carved.category : categoryOf(name),
    sizeBytes: carved.sizeBytes,
    // Everything a deep scan finds was found because nothing references it.
    isDeleted: true,
    isDirectory: false,
    // None of these live in a file's own bytes.
    createdAt: null,
    modifiedAt: null,
    accessedAt: null,
    quality: carveQuality(carved),
    source: 'carved',
    extents: [
      { offsetBytes: carved.offsetBytes + volumeOffsetBytes, lengthBytes: carved.sizeBytes },
    ],
    hasResidentData: false,
    // Carving cannot see fragmentation; a file is read as one run by definition.
    isFragmented: false,
    isCompressed: false,
    isEncrypted: false,
  }
}

/**
 * Score a carved file.
 *
 * Never `excellent`. That grade means the metadata survived *and* the clusters
 * were untouched, and a carved file has no metadata to begin with — claiming it
 * would overstate what the scan actually established.
 */
function carveQuality(carved: CarvedFile): RecoveryQuality {
  switch (carved.lengthSource) {
    case 'header':
    case 'footer':
      // The end of the file was determined from its own contents.
      return 'good'
    case 'capped':
      // The size is an upper bound, so the file carries trailing slack.
      return 'fair'
  }
}

/** Signatures a deep scan looks for. Exposed for the settings screen. */
export const DEEP_SCAN_SIGNATURE_COUNT = CARVE_SIGNATURES.length

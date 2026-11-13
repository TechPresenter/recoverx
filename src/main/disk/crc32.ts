/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320).
 *
 * Used to validate GPT headers and partition-entry arrays. This matters for a
 * recovery tool specifically: a checksum mismatch is how a *damaged* GPT is
 * distinguished from an intact one, which is what tells the Partition Recovery
 * module that it should fall back to the backup header at the end of the disk.
 */

/** Lazily built, then reused — 1 KiB of table for a large speed-up. */
let table: Uint32Array | null = null

function buildTable(): Uint32Array {
  const next = new Uint32Array(256)

  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    }
    next[index] = value >>> 0
  }

  return next
}

/** CRC-32 of a buffer, as an unsigned 32-bit value. */
export function crc32(data: Uint8Array): number {
  table ??= buildTable()

  let crc = 0xffffffff

  for (const byte of data) {
    // `!` is safe: the table has 256 entries and the index is masked to a byte.
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

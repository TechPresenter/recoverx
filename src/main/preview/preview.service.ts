import {
  type FilePreview,
  type PreviewFact,
  type PreviewKind,
  type RecoveredFile,
} from '@shared/types/scan'
import { formatBytes } from '@shared/utils/bytes'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import { formatTimestamp } from '@shared/utils/time'
import type { ScanRepository } from '../database/repositories/scan.repository'
import type { BlockReader } from '../disk/block-device'
import type { DiskService } from '../disk/disk.service'
import type { Logger } from '../logging/logger'
import {
  decodeText,
  extentsLength,
  findEmbeddedJpeg,
  formatHexDump,
  looksLikeText,
  readExtents,
} from './content-reader'
import { hasNoSignature, identifyContent, verifyContent } from './signatures'

/**
 * File preview.
 *
 * Preview exists to answer one question before a user commits to a recovery:
 * *is this actually my file?* So the most important output is not the rendered
 * image — it is the verification verdict and the hex dump, both of which are
 * produced for every result regardless of type.
 *
 * Reads are strictly bounded. Previewing a 40 GB disk image must cost a few
 * kilobytes, and the byte budget is chosen per kind rather than per file.
 */

/** Enough to identify content and show a meaningful dump. */
const PROBE_BYTES = 8192

/**
 * Ceiling on bytes shipped to the renderer for a visual preview.
 *
 * A `data:` URL is base64, so the transferred string is a third larger again.
 * Eight megabytes covers essentially every photograph while keeping a single
 * IPC message to a sane size.
 */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024

/** Bytes decoded for a text preview. */
const MAX_TEXT_BYTES = 128 * 1024

/** RAW files hide their embedded JPEG some way in, so the window is generous. */
const MAX_RAW_SCAN_BYTES = 4 * 1024 * 1024

const MIME_BY_SIGNATURE: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heix: 'image/heif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  matroska: 'video/webm',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  'mp3-id3': 'audio/mpeg',
}

/** RAW formats whose embedded JPEG preview is worth hunting for. */
const RAW_SIGNATURES = new Set(['cr2', 'cr3', 'tiff-le', 'tiff-be'])

export class PreviewService {
  private readonly disks: DiskService
  private readonly repository: ScanRepository
  private readonly logger: Logger

  constructor(disks: DiskService, repository: ScanRepository, logger: Logger) {
    this.disks = disks
    this.repository = repository
    this.logger = logger.child('preview')
  }

  async preview(fileId: string): Promise<FilePreview> {
    const [file] = this.repository.getFilesByIds([fileId])

    if (file === undefined) {
      throw new AppError(ErrorCode.NotFound, 'That result is no longer available', {
        details: fileId,
        retryable: false,
      })
    }

    const session = this.repository.getSession(file.sessionId)
    if (session === null) {
      throw new AppError(ErrorCode.NotFound, 'The scan this result came from no longer exists', {
        retryable: false,
      })
    }

    // A directory has no contents of its own, and a file whose extents were
    // lost has nothing to read — both still deserve a metadata panel.
    if (file.isDirectory || file.extents.length === 0) {
      return this.metadataOnly(file, file.isDirectory ? 'binary' : 'binary')
    }

    let owner: BlockReader | null = null

    try {
      owner = this.disks.openDevice(session.deviceId)
      return await this.buildPreview(file, owner)
    } catch (error) {
      this.logger.warn('Preview could not read the device', {
        fileId,
        reason: describeUnknown(error),
      })

      // Elevation or a removed device. The metadata is still worth showing, and
      // failing the whole panel would tell the user nothing.
      return this.metadataOnly(file, 'binary')
    } finally {
      owner?.close()
    }
  }

  // --- internals -----------------------------------------------------------

  private async buildPreview(file: RecoveredFile, reader: BlockReader): Promise<FilePreview> {
    const head = await readExtents(reader, file.extents, { maxBytes: PROBE_BYTES })
    const verification = verifyContent(head, file.extension)
    const signature = identifyContent(head)

    const base = {
      fileId: file.id,
      name: file.name,
      verdict: verification.verdict,
      detectedLabel: verification.detectedLabel,
      isBlank: verification.isBlank,
      signatureUnavailable: hasNoSignature(file.extension),
      hexDump: formatHexDump(head),
      facts: this.buildFacts(file, verification.detectedLabel),
    }

    // --- Images, including the embedded preview inside a camera RAW --------
    if (signature !== null && RAW_SIGNATURES.has(signature.id) && file.category === 'image') {
      const window = await readExtents(reader, file.extents, {
        maxBytes: Math.min(MAX_RAW_SCAN_BYTES, file.sizeBytes),
      })
      const embedded = findEmbeddedJpeg(window)

      if (embedded !== null) {
        return {
          ...base,
          kind: 'image',
          mediaDataUrl: toDataUrl(embedded, 'image/jpeg'),
          text: null,
          textTruncated: false,
          textEncoding: null,
          bytesRead: window.length,
          facts: [
            ...base.facts,
            { label: 'Preview', value: `Embedded JPEG, ${formatBytes(embedded.length)}` },
          ],
        }
      }
    }

    const mime = signature === null ? null : MIME_BY_SIGNATURE[signature.id]

    if (mime !== undefined && mime !== null && file.sizeBytes <= MAX_MEDIA_BYTES) {
      const content = await readExtents(reader, file.extents, { maxBytes: file.sizeBytes })

      return {
        ...base,
        kind: signature?.category === 'image' ? 'image' : 'media',
        mediaDataUrl: toDataUrl(content, mime),
        text: null,
        textTruncated: false,
        textEncoding: null,
        bytesRead: content.length,
      }
    }

    // --- Text -------------------------------------------------------------
    if (signature === null && looksLikeText(head)) {
      const content = await readExtents(reader, file.extents, {
        maxBytes: Math.min(MAX_TEXT_BYTES, file.sizeBytes),
      })
      const decoded = decodeText(content)

      return {
        ...base,
        kind: 'text',
        mediaDataUrl: null,
        text: decoded.text,
        textTruncated: file.sizeBytes > content.length,
        textEncoding: decoded.encoding,
        bytesRead: content.length,
      }
    }

    // --- Anything else: the dump and the facts ----------------------------
    return {
      ...base,
      kind: 'binary',
      mediaDataUrl: null,
      text: null,
      textTruncated: false,
      textEncoding: null,
      bytesRead: head.length,
    }
  }

  /** Used when the content cannot be read at all. */
  private metadataOnly(file: RecoveredFile, kind: PreviewKind): FilePreview {
    return {
      fileId: file.id,
      name: file.name,
      kind,
      verdict: 'empty',
      detectedLabel: null,
      isBlank: false,
      signatureUnavailable: hasNoSignature(file.extension),
      mediaDataUrl: null,
      text: null,
      textTruncated: false,
      textEncoding: null,
      hexDump: '',
      bytesRead: 0,
      facts: this.buildFacts(file, null),
    }
  }

  /**
   * The facts panel.
   *
   * Deliberately includes the physical detail — extent count, allocated span —
   * because for a user weighing whether a result is worth restoring, "stored in
   * 47 fragments" is a genuine signal about how likely a clean recovery is.
   */
  private buildFacts(file: RecoveredFile, detectedLabel: string | null): PreviewFact[] {
    const facts: PreviewFact[] = [
      { label: 'Size', value: formatBytes(file.sizeBytes) },
      { label: 'Location', value: file.path.length > 0 ? file.path : 'Volume root' },
      { label: 'State', value: file.isDeleted ? 'Deleted' : 'Present' },
      { label: 'Recoverability', value: file.quality },
    ]

    if (detectedLabel !== null) {
      facts.push({ label: 'Detected format', value: detectedLabel })
    }

    if (file.modifiedAt !== null) {
      facts.push({ label: 'Modified', value: formatTimestamp(file.modifiedAt) })
    }

    if (file.createdAt !== null) {
      facts.push({ label: 'Created', value: formatTimestamp(file.createdAt) })
    }

    if (file.extents.length > 0) {
      facts.push({
        label: 'Fragments',
        value: file.isFragmented ? `${file.extents.length} fragments` : 'Contiguous',
      })
      facts.push({ label: 'Allocated', value: formatBytes(extentsLength(file.extents)) })
    }

    if (file.hasResidentData) {
      facts.push({ label: 'Storage', value: 'Held inside the file record' })
    }

    if (file.isCompressed) facts.push({ label: 'Compression', value: 'NTFS compressed' })
    if (file.isEncrypted) facts.push({ label: 'Encryption', value: 'Encrypted (EFS)' })

    return facts
  }
}

/** Build a `data:` URL the renderer can use directly. */
function toDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

import { constants as fsConstants } from 'node:fs'
import { access, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LOG_FILE_PREFIX } from '@shared/constants/app'
import type { LogCleanupResult, LogFileInfo, LogQuery, LogQueryResult } from '@shared/types/logging'
import { AppError, ErrorCode } from '@shared/utils/errors'
import { alignToLineStart, filterEntries, paginate, parseLogLines } from './log-parser'

/**
 * Filesystem access for the diagnostics log files.
 *
 * A busy scan can produce a 20 MB log file per rotation window. Reading and
 * parsing that on every keystroke in the Logs screen would stall the main
 * process, so reads are bounded: only the tail of a large file is loaded, and
 * the result reports `truncated` so the UI can say so plainly instead of
 * implying the user is seeing the whole history.
 */

/** Upper bound on how much of a single file is read per query (8 MiB). */
const MAX_SCAN_BYTES = 8 * 1024 * 1024

/** Guard against reading an unrelated file if the directory is ever shared. */
const LOG_FILE_PATTERN = new RegExp(`^${LOG_FILE_PREFIX}-\\d{4}-\\d{2}-\\d{2}\\.log$`)

/**
 * List the readable log files, newest first.
 *
 * Entries that vanish between `readdir` and `stat` (rotation deleting an expired
 * file mid-listing) are skipped rather than failing the whole request.
 */
export async function listLogFiles(
  logDirectory: string,
  activeFileName: string,
): Promise<LogFileInfo[]> {
  let names: string[]
  try {
    names = await readdir(logDirectory)
  } catch {
    // The directory is created lazily by the rotate transport on first write.
    return []
  }

  const files: LogFileInfo[] = []

  for (const name of names) {
    if (!LOG_FILE_PATTERN.test(name)) continue

    try {
      const stats = await stat(join(logDirectory, name))
      if (!stats.isFile()) continue

      files.push({
        name,
        sizeBytes: stats.size,
        modifiedAt: stats.mtimeMs,
        isActive: name === activeFileName,
      })
    } catch {
      continue
    }
  }

  return files.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/**
 * Read, filter and paginate log records.
 *
 * @param fallbackFileName Used when the query does not name a file — normally
 *                         the file the logger is currently appending to.
 */
export async function queryLogs(
  logDirectory: string,
  query: LogQuery,
  fallbackFileName: string,
): Promise<LogQueryResult> {
  const fileName = query.file ?? fallbackFileName

  // Path traversal guard: the renderer supplies this name, so it is untrusted.
  // Only names matching the logger's own rotation pattern are ever opened.
  if (!LOG_FILE_PATTERN.test(fileName)) {
    throw new AppError(ErrorCode.Validation, 'Invalid log file name', {
      details: fileName,
      retryable: false,
    })
  }

  const filePath = join(logDirectory, fileName)

  let fileSize: number
  try {
    const stats = await stat(filePath)
    fileSize = stats.size
  } catch {
    // A day with no records yet has no file. An empty result is the correct
    // answer, not an error.
    return {
      file: fileName,
      entries: [],
      total: 0,
      scannedBytes: 0,
      truncated: false,
      malformedLines: 0,
    }
  }

  const { text, scannedBytes, truncated, lineOffset } = await readTail(filePath, fileSize)

  const parsed = parseLogLines(text, fileName, lineOffset)
  const matched = filterEntries(parsed.entries, query)
  const page = paginate(matched, query.limit, query.offset)

  return {
    file: fileName,
    entries: page,
    total: matched.length,
    scannedBytes,
    truncated,
    malformedLines: parsed.malformed,
  }
}

/**
 * Delete every log file except the one currently being written.
 *
 * Removing the active file would leave the rotate transport holding a handle to
 * a deleted inode, silently discarding every subsequent record until the next
 * rotation — so it is always preserved.
 */
export async function clearLogs(
  logDirectory: string,
  activeFileName: string,
): Promise<LogCleanupResult> {
  const files = await listLogFiles(logDirectory, activeFileName)

  let removedFiles = 0
  let freedBytes = 0

  for (const file of files) {
    if (file.name === activeFileName) continue

    try {
      await rm(join(logDirectory, file.name), { force: true })
      removedFiles += 1
      freedBytes += file.sizeBytes
    } catch {
      // Locked by an antivirus scanner or another reader; skip and continue.
      continue
    }
  }

  return { removedFiles, freedBytes }
}

/** Total bytes occupied by the log directory, and how many files it holds. */
export async function measureLogDirectory(
  logDirectory: string,
): Promise<{ sizeBytes: number; fileCount: number }> {
  const files = await listLogFiles(logDirectory, '')
  return {
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    fileCount: files.length,
  }
}

/** `true` when the directory exists and is readable. */
export async function isLogDirectoryReadable(logDirectory: string): Promise<boolean> {
  try {
    await access(logDirectory, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

// --- internals -------------------------------------------------------------

interface TailRead {
  readonly text: string
  readonly scannedBytes: number
  readonly truncated: boolean
  /**
   * Number of whole lines skipped before the returned text. Used to keep entry
   * ids stable across queries against the same file.
   */
  readonly lineOffset: number
}

/**
 * Read at most `MAX_SCAN_BYTES` from the end of a file, aligned to a line
 * boundary.
 *
 * For a file within budget this is a single full read. For a larger file the
 * first (partial) line of the window is discarded, because a JSON record split
 * across the window boundary would otherwise be counted as malformed on every
 * query.
 */
async function readTail(filePath: string, fileSize: number): Promise<TailRead> {
  if (fileSize === 0) {
    return { text: '', scannedBytes: 0, truncated: false, lineOffset: 0 }
  }

  const truncated = fileSize > MAX_SCAN_BYTES
  const length = truncated ? MAX_SCAN_BYTES : fileSize
  const position = fileSize - length

  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    const raw = buffer.toString('utf8', 0, bytesRead)

    if (!truncated) {
      return { text: raw, scannedBytes: bytesRead, truncated: false, lineOffset: 0 }
    }

    const aligned = alignToLineStart(raw)
    return {
      text: aligned.text,
      scannedBytes: bytesRead,
      truncated: true,
      // The absolute line index within the file is unknowable without reading
      // the head. Ids only need to be unique within one result set (they are
      // React keys for the virtualised list), and restarting at 0 satisfies that.
      lineOffset: 0,
    }
  } finally {
    await handle.close()
  }
}

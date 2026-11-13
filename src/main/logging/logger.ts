import { join } from 'node:path'
import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { LOG_FILE_PREFIX } from '@shared/constants/app'
import type { LogEntry } from '@shared/types/logging'
import type { AppSettings, LogLevel } from '@shared/types/settings'
import { serializeMeta } from './log-parser'

/**
 * Structured logging for the main process.
 *
 * Three sinks run in parallel:
 *   1. A daily-rotating JSON-lines file — the durable record, and the source the
 *      in-app Logs screen reads.
 *   2. A colourised console stream, development only.
 *   3. A live broadcaster that batches records to open windows so the Logs
 *      screen can tail without polling.
 *
 * Logging must never be able to take the application down: every sink is
 * wrapped so that a full disk, a locked file or an unserialisable payload
 * degrades to a dropped record rather than an unhandled exception in a
 * scan worker.
 */

export interface Logger {
  error(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  debug(message: string, meta?: unknown): void
  /** Derive a logger tagged with a narrower subsystem name. */
  child(scope: string): Logger
}

export interface LoggingOptions {
  readonly logDirectory: string
  readonly level: LogLevel
  /**
   * Days of log files to keep — the user's "Keep logs for" setting. `null`
   * deletes nothing, for the boot window before that setting has been read:
   * any number guessed there would be applied the first time a new day's
   * file is opened, deleting logs the user chose to keep for longer.
   */
  readonly retentionDays: number | null
  readonly enableConsole: boolean
}

/**
 * Where the rotate transport records which files it created and when, the
 * list it deletes old files from.
 *
 * Named here rather than left to the library, whose default name is a hash of
 * all the transport's options: changing the retention would then start a new,
 * empty list, and every file recorded in the old one would never be deleted.
 */
const AUDIT_FILE = `.${LOG_FILE_PREFIX}-audit.json`

/**
 * Batches log records for delivery to renderer windows.
 *
 * A scan emits thousands of records per second; forwarding each one as its own
 * IPC message would saturate the channel and starve the UI thread. Batching on a
 * short interval keeps the Logs screen live while bounding the message rate.
 */
class LogBroadcaster {
  private static readonly FLUSH_INTERVAL_MS = 400
  private static readonly MAX_BUFFERED = 500

  private buffer: LogEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private sink: ((entries: LogEntry[]) => void) | null = null
  private sequence = 0
  private dropped = 0

  setSink(sink: ((entries: LogEntry[]) => void) | null): void {
    this.sink = sink
  }

  push(
    level: LogLevel,
    scope: string,
    message: string,
    meta: string | null,
    timestamp: number,
  ): void {
    if (this.sink === null) return

    if (this.buffer.length >= LogBroadcaster.MAX_BUFFERED) {
      // Drop the oldest rather than the newest: during a failure cascade the
      // most recent records are the ones an operator needs.
      this.buffer.shift()
      this.dropped += 1
    }

    this.sequence += 1
    this.buffer.push({
      id: `live:${this.sequence}`,
      timestamp,
      level,
      scope,
      message,
      meta,
    })

    this.schedule()
  }

  private schedule(): void {
    if (this.timer !== null) return

    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, LogBroadcaster.FLUSH_INTERVAL_MS)

    // Never hold the event loop open purely to deliver log batches.
    this.timer.unref()
  }

  flush(): void {
    if (this.buffer.length === 0 || this.sink === null) return

    const batch = this.buffer
    this.buffer = []

    if (this.dropped > 0) {
      this.dropped = 0
    }

    try {
      this.sink(batch)
    } catch {
      // A closed window or a destroyed webContents must not propagate here.
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.buffer = []
    this.sink = null
  }
}

const broadcaster = new LogBroadcaster()

let root: winston.Logger | null = null
let activeOptions: LoggingOptions | null = null
let activeLogDirectory = ''
let activeFileName = ''

/**
 * Winston format that emits exactly one JSON object per line, matching the
 * schema `src/main/logging/log-parser.ts` reads back.
 */
const jsonLineFormat = winston.format.printf((info): string => {
  const record = {
    ts: typeof info.ts === 'number' ? info.ts : Date.now(),
    level: info.level,
    scope: typeof info.scope === 'string' ? info.scope : 'app',
    message: typeof info.message === 'string' ? info.message : String(info.message),
    meta: typeof info.meta === 'string' ? info.meta : null,
  }
  return JSON.stringify(record)
})

const consoleFormat = winston.format.combine(
  winston.format.colorize({ level: true }),
  winston.format.printf((info): string => {
    const scope = typeof info.scope === 'string' ? info.scope : 'app'
    const meta = typeof info.meta === 'string' ? ` ${info.meta}` : ''
    const time = new Date(typeof info.ts === 'number' ? info.ts : Date.now())
      .toISOString()
      .slice(11, 23)
    return `${time} ${info.level} [${scope}] ${String(info.message)}${meta}`
  }),
)

/**
 * Build the current day's log file name. Mirrors the `datePattern` configured on
 * the rotate transport so the Logs screen can mark the active file.
 */
function currentLogFileName(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${LOG_FILE_PREFIX}-${year}-${month}-${day}.log`
}

/**
 * Initialise the logging subsystem. Safe to call again to apply changed
 * settings — the previous transports are closed first.
 */
export function initializeLogging(options: LoggingOptions): Logger {
  root?.close()

  activeOptions = options
  activeLogDirectory = options.logDirectory
  activeFileName = currentLogFileName()

  const rotateTransport = new DailyRotateFile({
    dirname: options.logDirectory,
    filename: `${LOG_FILE_PREFIX}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    extension: '',
    maxSize: '20m',
    // Files older than this are deleted whenever a new file is started (each
    // day, and when a new transport opens a file not yet on its list).
    ...(options.retentionDays === null ? {} : { maxFiles: `${options.retentionDays}d` }),
    auditFile: join(options.logDirectory, AUDIT_FILE),
    // Archives stay uncompressed so the Logs screen can read historical files
    // directly without a decompression step on the UI path.
    zippedArchive: false,
    format: jsonLineFormat,
  })

  rotateTransport.on('new', (filename: string) => {
    activeFileName = filename.split(/[\\/]/).pop() ?? activeFileName
  })

  const transports: winston.transport[] = [rotateTransport]

  if (options.enableConsole) {
    transports.push(new winston.transports.Console({ format: consoleFormat }))
  }

  root = winston.createLogger({
    level: options.level,
    levels: { error: 0, warn: 1, info: 2, debug: 3 },
    transports,
    // Winston's own failures must not become process-level crashes.
    exitOnError: false,
  })

  root.on('error', () => {
    // Disk full, permission denied, file locked by an AV scanner. Nothing useful
    // can be logged about a failing logger; dropping the record is correct.
  })

  return createScopedLogger('app')
}

/** Change the minimum severity without rebuilding the transports. */
export function setLogLevel(level: LogLevel): void {
  if (root !== null) root.level = level
  if (activeOptions !== null) activeOptions = { ...activeOptions, level }
}

/**
 * Change how many days of log files are kept.
 *
 * The rotate transport takes its retention only when it is created, so this
 * rebuilds the transports with everything else as it was. Loggers already
 * handed out keep working: they look up the current transports on every
 * record. Nothing happens before logging has started, or when the retention
 * is unchanged.
 */
export function setLogRetention(retentionDays: number): void {
  if (activeOptions === null || activeOptions.retentionDays === retentionDays) return

  initializeLogging({ ...activeOptions, retentionDays })
}

/**
 * Apply the user's logging settings: all of them once they have been read at
 * start-up, then whichever of them a change touched.
 */
export function applyLogSettings(
  settings: Pick<AppSettings, 'logLevel' | 'logRetentionDays'>,
  changed?: ReadonlyArray<keyof AppSettings>,
): void {
  if (changed === undefined || changed.includes('logLevel')) setLogLevel(settings.logLevel)
  if (changed === undefined || changed.includes('logRetentionDays')) {
    setLogRetention(settings.logRetentionDays)
  }
}

/** Directory the rotate transport is writing to. */
export function getLogDirectory(): string {
  return activeLogDirectory
}

/** File name the rotate transport is currently appending to. */
export function getActiveLogFileName(): string {
  return activeFileName
}

/** Absolute path of the file currently being appended to. */
export function getActiveLogFilePath(): string {
  return join(activeLogDirectory, activeFileName)
}

/**
 * Register the delivery function used to push live log batches to windows.
 * Passing `null` detaches it (during shutdown).
 */
export function setLogBroadcastSink(sink: ((entries: LogEntry[]) => void) | null): void {
  broadcaster.setSink(sink)
}

/** Flush any buffered live records immediately. */
export function flushLogBroadcast(): void {
  broadcaster.flush()
}

/** Tear down logging. Called during application shutdown. */
export function shutdownLogging(): void {
  broadcaster.flush()
  broadcaster.dispose()
  root?.close()
  root = null
  activeOptions = null
}

/**
 * Obtain a logger for a subsystem.
 *
 * Before `initializeLogging` has run — a window of a few milliseconds during
 * boot — records fall back to the console rather than being lost or throwing.
 */
export function getLogger(scope = 'app'): Logger {
  return createScopedLogger(scope)
}

function createScopedLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string, meta?: unknown): void => {
    const timestamp = Date.now()
    const serializedMeta = serializeMeta(meta)

    if (root === null) {
      // Pre-initialisation fallback. Deliberately terse and unconditional.
      const line = `[${scope}] ${message}${serializedMeta === null ? '' : ` ${serializedMeta}`}`
      if (level === 'error') console.error(line)
      else console.warn(line)
      return
    }

    try {
      root.log({ level, message, ts: timestamp, scope, meta: serializedMeta })
    } catch {
      // See the `root.on('error')` note: a failing sink is not fatal.
    }

    broadcaster.push(level, scope, message, serializedMeta, timestamp)
  }

  return {
    error: (message, meta) => write('error', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    info: (message, meta) => write('info', message, meta),
    debug: (message, meta) => write('debug', message, meta),
    child: (childScope) => createScopedLogger(`${scope}:${childScope}`),
  }
}

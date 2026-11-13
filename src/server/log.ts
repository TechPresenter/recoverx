/**
 * Structured logging for the licence server.
 *
 * One JSON object per line on stdout. That is the format every container
 * platform, `journald` and log shipper already understands, so the server needs
 * no logging library, no file rotation and no configuration: where the lines go
 * is the platform's decision.
 *
 * Two things never appear in a log line, and the call sites are responsible for
 * that: a full licence key (use `maskKey` / `logSafeKey`) and any token — an
 * activation token or the admin bearer token. Log files are copied, shipped and
 * pasted into tickets far more freely than a database is.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export type LogFields = Readonly<Record<string, unknown>>

export interface Logger {
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export interface JsonLoggerOptions {
  /** Receives one complete line, newline included. Defaults to stdout. */
  readonly write?: (line: string) => void
  readonly clock?: () => number
}

export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const write =
    options.write ??
    ((line: string): void => {
      process.stdout.write(line)
    })
  const clock = options.clock ?? Date.now

  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    const record = {
      time: new Date(clock()).toISOString(),
      level,
      msg: message,
      ...serialiseFields(fields),
    }

    let line: string
    try {
      line = JSON.stringify(record)
    } catch {
      // A circular or BigInt field must not take the request down with it.
      line = JSON.stringify({ time: record.time, level, msg: message, logError: 'unserialisable' })
    }

    write(`${line}\n`)
  }

  return {
    info: (message, fields) => {
      emit('info', message, fields)
    },
    warn: (message, fields) => {
      emit('warn', message, fields)
    },
    error: (message, fields) => {
      emit('error', message, fields)
    },
  }
}

/** A logger that discards everything, for tests and the CLI. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Errors do not survive `JSON.stringify`; give them a shape that does. */
function serialiseFields(fields: LogFields): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(fields)) {
    result[name] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
  }

  return result
}

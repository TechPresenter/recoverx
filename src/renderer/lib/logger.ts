import { IpcChannel } from '@shared/ipc/channels'
import type { LogLevel } from '@shared/types/settings'
import { invoke } from './ipc-client'

/**
 * Renderer logging, forwarded into the main process.
 *
 * The renderer has no filesystem access, so a `console.error` here dies with the
 * window and never appears in a support bundle. Routing records through IPC puts
 * UI failures into the same rotating file as everything else, tagged with a
 * `renderer:` scope so their origin stays obvious.
 *
 * Delivery is fire-and-forget: a logging call must never make a component wait,
 * and a failure to log is not worth reporting to the user.
 */

/** Metadata is bounded before it leaves the renderer to keep the IPC frame small. */
const MAX_META_LENGTH = 8192

function write(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  void invoke(IpcChannel.LogsWrite, {
    level,
    scope: scope.slice(0, 64),
    message: message.slice(0, 4096),
    meta: serialize(meta),
  })
}

function serialize(meta: unknown): string | null {
  if (meta === undefined || meta === null) return null

  try {
    const serialized = JSON.stringify(meta, replacer)
    if (serialized === undefined) return null
    return serialized.length > MAX_META_LENGTH ? serialized.slice(0, MAX_META_LENGTH) : serialized
  } catch {
    return null
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '[Function]'
  return value
}

export interface RendererLogger {
  error(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  debug(message: string, meta?: unknown): void
}

/** Create a logger bound to a UI area, e.g. `createLogger('settings')`. */
export function createLogger(scope: string): RendererLogger {
  return {
    error: (message, meta) => write('error', scope, message, meta),
    warn: (message, meta) => write('warn', scope, message, meta),
    info: (message, meta) => write('info', scope, message, meta),
    debug: (message, meta) => write('debug', scope, message, meta),
  }
}

/** Default logger for code that has no more specific scope. */
export const log = createLogger('ui')

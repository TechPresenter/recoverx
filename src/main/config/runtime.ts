import { app } from 'electron'
import { LogLevelSchema, type LogLevel } from '@shared/types/settings'

/**
 * Runtime environment resolution.
 *
 * Environment variables are honoured only in unpackaged (development) builds.
 * A shipped installation must behave identically for every user regardless of
 * their environment — otherwise a stray variable could, for example, redirect
 * the update feed of a customer's install.
 */

export interface RuntimeConfig {
  readonly isDevelopment: boolean
  readonly isPackaged: boolean
  /** Renderer dev-server URL injected by electron-vite, or `null` in production. */
  readonly rendererDevServerUrl: string | null
  /** Bootstrap log level, before user settings have been read. */
  readonly bootLogLevel: LogLevel
  readonly openDevToolsOnStart: boolean
  readonly userDataOverride: string | undefined
  readonly updateFeedOverride: string | undefined
  readonly channel: 'latest' | 'beta' | 'alpha'
}

let cached: RuntimeConfig | null = null

export function resolveRuntimeConfig(): RuntimeConfig {
  if (cached !== null) return cached

  const isPackaged = app.isPackaged
  const isDevelopment = !isPackaged

  // electron-vite sets this only while `electron-vite dev` is running.
  const devServerUrl = process.env.ELECTRON_RENDERER_URL

  cached = {
    isDevelopment,
    isPackaged,
    rendererDevServerUrl:
      isDevelopment && devServerUrl !== undefined && devServerUrl.length > 0 ? devServerUrl : null,
    bootLogLevel: readLogLevel(isDevelopment),
    openDevToolsOnStart: isDevelopment && readBoolean('RECOVERX_OPEN_DEVTOOLS', false),
    userDataOverride: isDevelopment ? readString('RECOVERX_USER_DATA_DIR') : undefined,
    updateFeedOverride: isDevelopment ? readString('RECOVERX_UPDATE_FEED_URL') : undefined,
    channel: readChannel(),
  }

  return cached
}

/** Reset the cache. Used by tests. */
export function resetRuntimeCache(): void {
  cached = null
}

// --- internals -------------------------------------------------------------

function readString(name: string): string | undefined {
  const value = process.env[name]
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = readString(name)?.toLowerCase()
  if (value === undefined) return fallback
  return value === '1' || value === 'true' || value === 'yes'
}

function readLogLevel(isDevelopment: boolean): LogLevel {
  const parsed = LogLevelSchema.safeParse(readString('RECOVERX_LOG_LEVEL'))
  if (parsed.success) return parsed.data
  return isDevelopment ? 'debug' : 'info'
}

/**
 * Update channel, derived from the version's pre-release tag so a beta build
 * cannot accidentally publish to the stable feed.
 */
function readChannel(): 'latest' | 'beta' | 'alpha' {
  const version = app.getVersion()
  if (version.includes('-alpha')) return 'alpha'
  if (version.includes('-beta')) return 'beta'
  return 'latest'
}

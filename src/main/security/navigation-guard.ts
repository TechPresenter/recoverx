import { shell, type WebContents } from 'electron'
import { ALLOWED_EXTERNAL_HOSTS } from '@shared/constants/app'
import { AppError, ErrorCode } from '@shared/utils/errors'
import type { RuntimeConfig } from '../config/runtime'
import type { Logger } from '../logging/logger'
import { APP_ORIGIN } from './app-protocol'

/**
 * Navigation and window-opening policy.
 *
 * The renderer is never allowed to navigate itself away from the application
 * bundle. Without this, a single unescaped string rendered as a link — a
 * recovered file name, say, which comes from a hostile disk image — could
 * replace the application UI with an attacker-controlled page that still holds
 * the preload bridge.
 */

export interface GuardOptions {
  readonly contents: WebContents
  readonly config: RuntimeConfig
  readonly logger: Logger
  /** Notified when the renderer dies, so the crash can be recorded. */
  readonly onRendererGone?: ((reason: string, exitCode: number) => void) | undefined
}

export function guardWebContents({ contents, config, logger, onRendererGone }: GuardOptions): void {
  const allowedPrefixes = buildAllowedPrefixes(config)

  contents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url, allowedPrefixes)) return

    event.preventDefault()
    logger.warn('Blocked in-place navigation away from the application', { url: truncate(url) })
  })

  // Covers `window.open`, `target="_blank"` and `window.location` assignments
  // that Chromium routes through the window-open path.
  contents.setWindowOpenHandler(({ url }) => {
    void handleExternalOpen(url, logger)
    return { action: 'deny' }
  })

  // `<webview>` is disabled at the BrowserWindow level; this is the backstop in
  // case a future window is created without that option.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    logger.warn('Blocked attempt to attach a <webview> element')
  })

  contents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process terminated unexpectedly', {
      reason: details.reason,
      exitCode: details.exitCode,
    })

    // The window is gone, so nothing in the renderer can report this. Recording
    // it here is the only way a user who saw the screen go blank finds out why.
    onRendererGone?.(details.reason, details.exitCode)
  })
}

/**
 * Open a URL in the user's default browser, if it is on the allowlist.
 *
 * Both the scheme and the host are checked. Restricting to `https` blocks
 * `file:` (which would launch a local executable through the shell) and custom
 * schemes registered by other installed applications.
 */
export async function openExternalUrl(rawUrl: string, logger: Logger): Promise<void> {
  const target = parseAllowedExternalUrl(rawUrl)

  if (target === null) {
    logger.warn('Refused to open a URL outside the allowlist', { url: truncate(rawUrl) })
    throw new AppError(ErrorCode.SecurityViolation, 'This link is not allowed to be opened', {
      details: truncate(rawUrl),
      retryable: false,
    })
  }

  logger.info('Opening external URL', { url: target })
  await shell.openExternal(target)
}

/**
 * Validate a URL against the external allowlist.
 * Returns the normalised URL, or `null` when it must not be opened.
 */
export function parseAllowedExternalUrl(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:') return null

  // Credentials in a URL are a phishing primitive (`https://trusted@evil.test`)
  // and are never legitimate for a link the application itself emits.
  if (parsed.username.length > 0 || parsed.password.length > 0) return null

  const host = parsed.hostname.toLowerCase()
  if (!ALLOWED_EXTERNAL_HOSTS.includes(host)) return null

  return parsed.toString()
}

// --- internals -------------------------------------------------------------

function buildAllowedPrefixes(config: RuntimeConfig): readonly string[] {
  const prefixes = [APP_ORIGIN]

  if (config.rendererDevServerUrl !== null) {
    prefixes.push(config.rendererDevServerUrl)
  }

  return prefixes
}

function isInternalUrl(url: string, allowedPrefixes: readonly string[]): boolean {
  return allowedPrefixes.some((prefix) => url === prefix || url.startsWith(prefix))
}

async function handleExternalOpen(url: string, logger: Logger): Promise<void> {
  try {
    await openExternalUrl(url, logger)
  } catch {
    // `openExternalUrl` has already logged the refusal. A blocked popup must
    // not surface as an unhandled rejection in the main process.
  }
}

function truncate(url: string): string {
  return url.length > 200 ? `${url.slice(0, 200)}…` : url
}

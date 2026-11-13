import type { Session } from 'electron'
import type { Logger } from '../logging/logger'
import type { RuntimeConfig } from '../config/runtime'
import { APP_ORIGIN } from './app-protocol'

/**
 * Session-level hardening.
 *
 * RecoverX runs with an Administrator token and reads raw block devices. A
 * renderer compromise therefore has a far higher ceiling than in an ordinary
 * desktop app, so the renderer is treated as untrusted throughout: no Node
 * integration, no remote content, no device access, and a Content Security
 * Policy applied by the network layer rather than by a `<meta>` tag the page
 * itself could omit.
 */

export interface HardenSessionOptions {
  readonly session: Session
  readonly config: RuntimeConfig
  readonly logger: Logger
}

export function hardenSession({ session, config, logger }: HardenSessionOptions): void {
  applyContentSecurityPolicy(session, config)
  denyDevicePermissions(session, logger)
  blockRemoteResourceLoads(session, config, logger)

  logger.debug('Session hardening applied', { development: config.isDevelopment })
}

/**
 * Compose the Content Security Policy.
 *
 * Exported because it is applied in two places. `webRequest.onHeadersReceived`
 * covers the development server, but it does not fire for responses produced by
 * a `protocol.handle` handler — so the `app://` handler sets this header on its
 * own responses. Both paths share this one definition to guarantee the packaged
 * build is not running a weaker policy than development.
 */
export function buildContentSecurityPolicy(config: RuntimeConfig): string {
  const devServer = config.rendererDevServerUrl
  const devOrigin = devServer === null ? null : safeOrigin(devServer)

  const directives: string[] = [
    "default-src 'self'",
    // No remote code, ever. In development Vite serves ES modules and the HMR
    // client from its own origin, which has to be allowed explicitly.
    devOrigin === null ? "script-src 'self'" : `script-src 'self' ${devOrigin}`,
    // Tailwind emits a static stylesheet, but React still sets inline `style`
    // attributes for progress bars and virtual-list offsets, which CSP counts
    // as inline styles.
    "style-src 'self' 'unsafe-inline'",
    // `blob:` covers generated preview thumbnails; `data:` covers inlined icons.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    devOrigin === null
      ? "connect-src 'self'"
      : `connect-src 'self' ${devOrigin} ${devOrigin.replace(/^http/, 'ws')}`,
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].filter((directive) => directive.length > 0)

  return directives.join('; ')
}

/** Attach the policy to every response that passes through the network stack. */
function applyContentSecurityPolicy(session: Session, config: RuntimeConfig): void {
  const policy = buildContentSecurityPolicy(config)

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
        'X-Content-Type-Options': ['nosniff'],
      },
    })
  })
}

/**
 * Refuse every optional web capability.
 *
 * A data recovery tool needs no camera, microphone, geolocation, notifications,
 * USB, HID or serial access. Denying by default means a future dependency
 * cannot quietly acquire one.
 */
function denyDevicePermissions(session: Session, logger: Logger): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    logger.warn('Denied renderer permission request', { permission })
    callback(false)
  })

  // Deliberately silent. Chromium probes this speculatively — several times per
  // navigation for capabilities the page never asked for — so logging each one
  // buries genuine records. An actual *request* is the interesting event, and
  // that is warned about above.
  session.setPermissionCheckHandler(() => false)

  session.setDevicePermissionHandler(() => false)

  session.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: false })
  })
}

/**
 * Block any subresource request that is not served by the application itself.
 *
 * This is the backstop behind CSP: even if a policy directive is mis-specified,
 * no request can leave the machine, so a malicious file name or metadata string
 * rendered into the UI cannot be used to beacon out.
 */
function blockRemoteResourceLoads(session: Session, config: RuntimeConfig, logger: Logger): void {
  const devOrigin =
    config.rendererDevServerUrl === null ? null : safeOrigin(config.rendererDevServerUrl)

  session.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedResourceUrl(details.url, devOrigin)) {
      callback({ cancel: false })
      return
    }

    logger.warn('Blocked outbound renderer request', {
      url: truncateUrl(details.url),
      resourceType: details.resourceType,
    })
    callback({ cancel: true })
  })
}

function isAllowedResourceUrl(url: string, devOrigin: string | null): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`) || url === APP_ORIGIN) return true
  if (url.startsWith('devtools://') || url.startsWith('chrome-extension://')) return true
  if (url.startsWith('blob:') || url.startsWith('data:')) return true

  if (devOrigin !== null) {
    if (url.startsWith(devOrigin)) return true
    if (url.startsWith(devOrigin.replace(/^http/, 'ws'))) return true
  }

  return false
}

function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin
  } catch {
    return rawUrl
  }
}

function truncateUrl(url: string): string {
  return url.length > 200 ? `${url.slice(0, 200)}…` : url
}

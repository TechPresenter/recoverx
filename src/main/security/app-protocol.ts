import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import type { RuntimeConfig } from '../config/runtime'
import type { Logger } from '../logging/logger'
import { buildContentSecurityPolicy } from './session-hardening'

/**
 * Custom `app://` scheme for the packaged renderer.
 *
 * Loading the renderer from `file://` is the common shortcut and a poor one:
 * file URLs have an opaque origin, so `default-src 'self'` in a Content Security
 * Policy matches nothing useful, `fetch` is restricted, and any path that
 * reaches the loader can address the entire filesystem.
 *
 * Serving from a registered standard scheme gives the renderer a real, unique
 * origin (`app://recoverx`), makes CSP meaningful, and confines every asset
 * request to the bundle directory through the traversal check below.
 */

export const APP_SCHEME = 'app'
export const APP_HOST = 'recoverx'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`

/**
 * Declare the scheme's privileges.
 *
 * Must be called before `app.whenReady()`: Chromium reads the scheme registry
 * once, while the network service is being created, and a later call is ignored.
 */
export function registerAppProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        // `standard` gives the scheme a parseable origin, which is what makes
        // CSP, localStorage and IndexedDB behave normally.
        standard: true,
        // Marks the origin as trustworthy, so the renderer is not treated as
        // insecure content and the async Clipboard API stays available.
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/**
 * Install the request handler that serves the built renderer.
 *
 * @param rendererRoot Absolute path of the directory holding `index.html`.
 */
export function registerAppProtocolHandler(
  rendererRoot: string,
  config: RuntimeConfig,
  logger: Logger,
): void {
  const root = resolve(rendererRoot)
  const csp = buildContentSecurityPolicy(config)

  protocol.handle(APP_SCHEME, async (request): Promise<Response> => {
    let requestUrl: URL
    try {
      requestUrl = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    // Only the canonical host is served. Anything else is a malformed or
    // injected URL and must not reach the filesystem.
    if (requestUrl.hostname !== APP_HOST) {
      logger.warn('Blocked app:// request for an unexpected host', { url: request.url })
      return new Response('Not found', { status: 404 })
    }

    const relativePath = decodeRequestPath(requestUrl.pathname)
    const absolutePath = resolve(join(root, relativePath))

    // Traversal guard. `resolve` has already collapsed any `..` segments, so a
    // path that no longer sits under the bundle root was an escape attempt.
    if (absolutePath !== root && !absolutePath.startsWith(root + sep)) {
      logger.warn('Blocked app:// path traversal attempt', {
        requested: requestUrl.pathname,
        resolved: absolutePath,
      })
      return new Response('Forbidden', { status: 403 })
    }

    try {
      const stats = await stat(absolutePath)
      if (!stats.isFile()) return new Response('Not found', { status: 404 })

      /*
       * The file is streamed straight from disk rather than fetched back
       * through `net.fetch(file://…)`.
       *
       * That indirection is the documented shortcut, but it emits a real
       * `file://` request into the network stack — which the outbound request
       * filter in session-hardening then cancels, because its whole purpose is
       * to allow nothing but this origin. Reading directly keeps that filter
       * absolutely strict and removes a round trip from every asset load.
       */
      const stream = Readable.toWeb(createReadStream(absolutePath)) as ReadableStream<Uint8Array>

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': contentTypeFor(absolutePath),
          'Content-Length': String(stats.size),
          // `protocol.handle` responses bypass `webRequest.onHeadersReceived`,
          // so the policy has to be attached here or the packaged build would
          // silently run without one.
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          // Assets are content-hashed by the bundler; the entry document is not
          // and must be revalidated so an update is picked up after install.
          'Cache-Control': relativePath === 'index.html' ? 'no-cache' : 'public, max-age=31536000',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  logger.debug('Registered app:// protocol handler', { root })
}

/**
 * Normalise a URL pathname into a bundle-relative filesystem path.
 * An empty or root path resolves to the SPA entry document.
 */
function decodeRequestPath(pathname: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // Malformed percent-encoding: fall back to the raw value, which the
    // traversal check still evaluates.
    decoded = pathname
  }

  const trimmed = decoded.replace(/^\/+/, '')
  if (trimmed.length === 0) return 'index.html'

  // Strip any NUL bytes before they reach a filesystem call.
  return normalize(trimmed.replace(/\0/g, ''))
}

/**
 * Content type by extension.
 *
 * Explicit rather than sniffed. `text/javascript` on `.js` is load-bearing:
 * Chromium refuses to evaluate an ES module served with any other type, and the
 * whole renderer is ES modules.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

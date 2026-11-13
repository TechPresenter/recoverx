import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { isIP, type AddressInfo } from 'node:net'
import { z, type ZodType } from 'zod'
import { formatZodIssues, parseJson } from '@shared/utils/json'
import {
  CreateLicensesSchema,
  ExtendLicenseSchema,
  logSafeKey,
  type AuditContext,
  type LicenseAuthority,
} from './authority'
import { isDatabaseBusy, isLicenseError } from './errors'
import type { Logger } from './log'
import { CustomerMessages } from './messages'
import type { RateLimiter } from './rate-limit'

/**
 * The licence server's HTTP surface.
 *
 * Plain `node:http` rather than a framework. The whole API is a dozen routes
 * with JSON in and JSON out, and every concern a framework would supply —
 * routing, body limits, content negotiation, error shaping — is a few lines
 * here that can be read in one sitting. It also means the deployed bundle has
 * exactly one dependency (zod) and nothing between a request and the rules
 * that could change behaviour on a minor upgrade.
 *
 * TLS is not handled here. The server listens on loopback by default and is
 * meant to sit behind a reverse proxy that terminates HTTPS; see
 * docs/LICENSE-SERVER.md.
 *
 * Every error response is `{ "error": "<sentence>" }`. On the public routes the
 * desktop application shows that sentence to the customer verbatim.
 */

/** Largest request body accepted. Real requests are a few hundred bytes. */
export const MAX_BODY_BYTES = 16 * 1024

/** Retry hint sent with a 503 when the database is momentarily locked. */
const BUSY_RETRY_SECONDS = 2

export interface HttpServerOptions {
  readonly authority: LicenseAuthority
  readonly logger: Logger
  /** `null` disables the admin API: its routes answer 404 as if absent. */
  readonly adminToken: string | null
  /** Take the client address from the first `X-Forwarded-For` hop. */
  readonly trustProxy: boolean
  readonly rateLimiter: RateLimiter
  /** Throws when the server cannot serve; typically `store.ping`. */
  readonly healthCheck?: () => void
}

interface Reply {
  readonly status: number
  readonly body: unknown
  readonly headers?: Readonly<Record<string, string>>
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly ip: string
  /** Captured path segments of the matched route. */
  readonly params: readonly string[]
  /** Extra fields for this request's log line. Never a full key or a token. */
  readonly log: Record<string, unknown>
}

type Handler = (context: RequestContext) => Promise<Reply> | Reply

type Scope = 'health' | 'public' | 'admin'

interface Route {
  readonly name: string
  readonly pattern: RegExp
  readonly scope: Scope
  readonly methods: Readonly<Partial<Record<'GET' | 'POST', Handler>>>
}

/** A refusal decided by the transport layer rather than by the licensing rules. */
class HttpRefusal extends Error {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>

  constructor(status: number, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message)
    this.name = 'HttpRefusal'
    this.status = status
    this.headers = headers
  }
}

// --- request bodies ---------------------------------------------------------

const ActivationBodySchema = z.object({
  key: z.string().max(200),
  machineId: z.string().max(200),
  product: z.string().max(100),
})

const DeactivationBodySchema = z.object({
  token: z.string().min(1).max(4096),
})

const RevokeBodySchema = z.strictObject({
  reason: z.string().max(500).nullish(),
})

const MachineBodySchema = z.strictObject({
  machineId: z.string().min(1).max(200),
})

const EmptyBodySchema = z.strictObject({})

const ListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  search: z.string().max(200).optional(),
  orderRef: z.string().max(200).optional(),
  edition: z.enum(['professional', 'business', 'technician', 'enterprise']).optional(),
})

interface BodyOptions {
  /** An absent body is read as `{}` — for admin actions with nothing to say. */
  readonly optional?: boolean
  /** Who reads a validation failure: a customer gets one plain sentence. */
  readonly audience: 'customer' | 'operator'
}

/**
 * Read, size-check, decode and validate a JSON body.
 *
 * The checks run cheapest first, and the size limit is enforced both against
 * the declared `Content-Length` (so an honest oversized request is refused
 * before a byte of it is read) and while streaming (so a dishonest one is cut
 * off at the limit rather than buffered).
 */
async function readJson<T>(
  context: RequestContext,
  schema: ZodType<T>,
  options: BodyOptions,
): Promise<T> {
  const { req } = context
  const declared = declaredLength(req.headers)
  const chunked = req.headers['transfer-encoding'] !== undefined

  if (options.optional === true && !chunked && (declared === null || declared === 0)) {
    return validate({}, schema, options)
  }

  const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new HttpRefusal(415, CustomerMessages.wrongContentType)
  }

  if (declared !== null && declared > MAX_BODY_BYTES) {
    throw new HttpRefusal(413, CustomerMessages.bodyTooLarge, { connection: 'close' })
  }

  const raw = await readRaw(req)

  const decoded = parseJson(raw.toString('utf8'), z.unknown())
  if (!decoded.ok) throw new HttpRefusal(400, CustomerMessages.unreadableRequest)

  return validate(decoded.data, schema, options)
}

/**
 * Collect a request body up to the size limit.
 *
 * Event listeners rather than `for await`: leaving a `for await` loop early
 * destroys the stream, and with it the socket, so the client would see a
 * connection reset instead of the 413 explaining why. Here the listeners are
 * simply detached; the rest of the body is discarded as it arrives and the
 * `Connection: close` on the reply ends the exchange.
 */
function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0

    const detach = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onFailure)
      req.off('close', onClose)
    }

    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      received += buffer.length

      if (received > MAX_BODY_BYTES) {
        detach()
        reject(new HttpRefusal(413, CustomerMessages.bodyTooLarge, { connection: 'close' }))
        return
      }

      chunks.push(buffer)
    }

    const onEnd = (): void => {
      detach()
      resolve(Buffer.concat(chunks))
    }

    const onFailure = (): void => {
      detach()
      reject(new HttpRefusal(400, CustomerMessages.unreadableRequest))
    }

    const onClose = (): void => {
      // `close` without `end` means the client went away mid-body.
      if (!req.complete) onFailure()
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onFailure)
    req.on('close', onClose)
  })
}

function validate<T>(value: unknown, schema: ZodType<T>, options: BodyOptions): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data

  throw new HttpRefusal(
    400,
    options.audience === 'customer'
      ? CustomerMessages.incompleteRequest
      : `The request body is invalid: ${formatZodIssues(parsed.error.issues)}`,
  )
}

function declaredLength(headers: IncomingHttpHeaders): number | null {
  const raw = headers['content-length']
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

// --- handlers ---------------------------------------------------------------

function routeKey(context: RequestContext): string {
  const raw = context.params[0] ?? ''
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new HttpRefusal(400, 'The licence key in the address is not readable.')
  }
}

function buildRoutes(options: HttpServerOptions): readonly Route[] {
  const { authority } = options

  const customer = (context: RequestContext): AuditContext => ({
    actor: 'customer',
    ip: context.ip,
  })
  const operator = (context: RequestContext): AuditContext => ({
    actor: 'admin-api',
    ip: context.ip,
  })

  const licence = (suffix: string): RegExp =>
    new RegExp(`^/v1/admin/licenses/([^/]+)${suffix}$`, 'u')

  return [
    {
      name: 'healthz',
      pattern: /^\/healthz$/u,
      scope: 'health',
      methods: {
        GET: () => {
          options.healthCheck?.()
          return { status: 200, body: { ok: true } }
        },
      },
    },
    {
      name: 'activate',
      pattern: /^\/v1\/activate$/u,
      scope: 'public',
      methods: {
        POST: async (context) => {
          const body = await readJson(context, ActivationBodySchema, { audience: 'customer' })
          context.log.key = logSafeKey(body.key)
          context.log.machine = body.machineId

          const result = authority.activate(body, customer(context))
          context.log.reused = result.reused
          context.log.edition = result.claims.edition

          return { status: 200, body: { token: result.token } }
        },
      },
    },
    {
      // 200 `{ released }` when the seat was freed or already free. A 409 is
      // the self-service allowance refusing the move: the seat is still held,
      // and the desktop client reads that status as "keep the licence", so
      // `errors.ts` maps nothing else on this route to it.
      name: 'deactivate',
      pattern: /^\/v1\/deactivate$/u,
      scope: 'public',
      methods: {
        POST: async (context) => {
          const body = await readJson(context, DeactivationBodySchema, { audience: 'customer' })
          const result = authority.deactivate(body.token, customer(context))

          context.log.key = logSafeKey(result.key)
          context.log.machine = result.machineId
          context.log.released = result.released

          return { status: 200, body: { released: result.released } }
        },
      },
    },
    {
      name: 'admin.licenses',
      pattern: /^\/v1\/admin\/licenses$/u,
      scope: 'admin',
      methods: {
        GET: (context) => {
          const query = validate(Object.fromEntries(context.url.searchParams), ListQuerySchema, {
            audience: 'operator',
          })
          return { status: 200, body: { licenses: authority.list(query) } }
        },
        POST: async (context) => {
          const body = await readJson(context, CreateLicensesSchema, { audience: 'operator' })
          const result = authority.createLicenses(body, operator(context))

          context.log.created = result.created ? result.licenses.length : 0
          context.log.edition = body.edition

          return {
            // A replayed order is answered 200 with the original licences, so a
            // webhook handler can tell "minted now" from "already minted".
            status: result.created ? 201 : 200,
            body: result,
          }
        },
      },
    },
    {
      name: 'admin.license',
      pattern: licence(''),
      scope: 'admin',
      methods: {
        GET: (context) => {
          const key = routeKey(context)
          context.log.key = logSafeKey(key)
          return { status: 200, body: authority.show(key) }
        },
      },
    },
    {
      name: 'admin.license.revoke',
      pattern: licence('/revoke'),
      scope: 'admin',
      methods: {
        POST: async (context) => {
          const key = routeKey(context)
          context.log.key = logSafeKey(key)
          const body = await readJson(context, RevokeBodySchema, {
            audience: 'operator',
            optional: true,
          })
          const license = authority.revoke(key, body.reason ?? null, operator(context))
          return { status: 200, body: { license } }
        },
      },
    },
    {
      name: 'admin.license.restore',
      pattern: licence('/restore'),
      scope: 'admin',
      methods: {
        POST: async (context) => {
          const key = routeKey(context)
          context.log.key = logSafeKey(key)
          await readJson(context, EmptyBodySchema, { audience: 'operator', optional: true })
          return { status: 200, body: { license: authority.restore(key, operator(context)) } }
        },
      },
    },
    {
      name: 'admin.license.extend',
      pattern: licence('/extend'),
      scope: 'admin',
      methods: {
        POST: async (context) => {
          const key = routeKey(context)
          context.log.key = logSafeKey(key)
          const body = await readJson(context, ExtendLicenseSchema, { audience: 'operator' })
          return { status: 200, body: { license: authority.extend(key, body, operator(context)) } }
        },
      },
    },
    {
      name: 'admin.license.reset',
      pattern: licence('/reset'),
      scope: 'admin',
      methods: {
        POST: async (context) => {
          const key = routeKey(context)
          context.log.key = logSafeKey(key)
          await readJson(context, EmptyBodySchema, { audience: 'operator', optional: true })
          return {
            status: 200,
            body: { released: authority.resetSeats(key, operator(context)) },
          }
        },
      },
    },
    {
      name: 'admin.license.release',
      pattern: licence('/release'),
      scope: 'admin',
      methods: {
        POST: async (context) => {
          const key = routeKey(context)
          context.log.key = logSafeKey(key)
          const body = await readJson(context, MachineBodySchema, { audience: 'operator' })
          context.log.machine = body.machineId
          return {
            status: 200,
            body: { released: authority.release(key, body.machineId, operator(context)) },
          }
        },
      },
    },
    {
      name: 'admin.license.offline',
      pattern: licence('/offline'),
      scope: 'admin',
      methods: {
        POST: async (context) => {
          const key = routeKey(context)
          context.log.key = logSafeKey(key)
          const body = await readJson(context, MachineBodySchema, { audience: 'operator' })
          const result = authority.issueOffline(key, body.machineId, operator(context))
          context.log.machine = result.claims.machine
          return { status: 200, body: { token: result.token, claims: result.claims } }
        },
      },
    },
  ]
}

// --- request pipeline -------------------------------------------------------

/**
 * Build the request listener.
 *
 * Exported separately from the server so tests can drive it on an ephemeral
 * port without the process-level concerns of the entry point.
 */
export function createRequestHandler(
  options: HttpServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = buildRoutes(options)
  const { logger, rateLimiter } = options
  const adminDigest = options.adminToken === null ? null : digest(options.adminToken)

  return async (req, res) => {
    const started = performance.now()
    const requestId = randomUUID()
    const ip = clientAddress(req, options.trustProxy)
    const log: Record<string, unknown> = {}
    let routeName = 'unmatched'
    let reply: Reply

    try {
      const url = new URL(req.url ?? '/', 'http://licence-server.invalid')
      const route = routes.find((candidate) => candidate.pattern.test(url.pathname))

      if (route === undefined) throw new HttpRefusal(404, CustomerMessages.notFound)
      routeName = route.name

      if (route.scope === 'admin') {
        // A disabled admin API is indistinguishable from an absent one, so a
        // scanner learns nothing from probing it.
        if (adminDigest === null) throw new HttpRefusal(404, CustomerMessages.notFound)
        authorise(req.headers, adminDigest, ip, rateLimiter)
      }

      // HEAD is answered like GET; Node drops the body from the response.
      const method = req.method === 'HEAD' ? 'GET' : req.method
      const handler = method === 'GET' || method === 'POST' ? route.methods[method] : undefined

      if (handler === undefined) {
        const allowed = Object.keys(route.methods)
        if (allowed.includes('GET')) allowed.push('HEAD')
        throw new HttpRefusal(405, CustomerMessages.methodNotAllowed, { allow: allowed.join(', ') })
      }

      if (route.scope === 'public') {
        const decision = rateLimiter.take(ip)
        if (!decision.allowed) {
          throw new HttpRefusal(429, CustomerMessages.rateLimited, {
            'retry-after': String(decision.retryAfterSeconds),
          })
        }
      }

      const match = route.pattern.exec(url.pathname)
      reply = await handler({ req, url, ip, params: match?.slice(1) ?? [], log })
    } catch (error) {
      reply = replyForError(error, log)

      if (reply.status >= 500) {
        logger.error('Request failed', { requestId, route: routeName, error })
      }
    }

    send(res, reply, requestId)

    res.once('finish', () => {
      const fields = {
        requestId,
        method: req.method,
        route: routeName,
        status: reply.status,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        ip,
        ...log,
      }

      if (reply.status >= 500) logger.warn('request', fields)
      else logger.info('request', fields)
    })
  }
}

function replyForError(error: unknown, log: Record<string, unknown>): Reply {
  if (error instanceof HttpRefusal) {
    return { status: error.status, body: { error: error.message }, headers: error.headers }
  }

  if (isLicenseError(error)) {
    log.refusal = error.refusal

    // A deactivation learns its key and machine from the verified token, after
    // the handler could note them; the refusal carries them out instead.
    if (error.subject !== undefined) {
      log.key ??= logSafeKey(error.subject.key)
      log.machine ??= error.subject.machineId
    }

    return { status: error.status, body: { error: error.message } }
  }

  if (isDatabaseBusy(error)) {
    return {
      status: 503,
      body: { error: CustomerMessages.busy },
      headers: { 'retry-after': String(BUSY_RETRY_SECONDS) },
    }
  }

  return { status: 500, body: { error: CustomerMessages.internal } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.headersSent) {
    res.end()
    return
  }

  const payload = JSON.stringify(reply.body)

  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    // Tokens and licence details must not sit in an intermediary's cache.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
    ...reply.headers,
  })
  res.end(payload)
}

/**
 * Check the admin bearer token.
 *
 * Both sides are hashed before comparison so `timingSafeEqual` always compares
 * equal lengths — comparing the raw strings would leak the token's length
 * through the early return on a mismatch. Failures are rate limited in their
 * own bucket, so a correct token is never throttled by someone else guessing.
 *
 * The token is read as one run of non-space characters; `config.ts` refuses a
 * LICENSE_ADMIN_TOKEN that could not be presented that way.
 */
function authorise(
  headers: IncomingHttpHeaders,
  expected: Buffer,
  ip: string,
  rateLimiter: RateLimiter,
): void {
  const header = headers.authorization ?? ''
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(header)
  const presented = match?.[1]

  if (presented !== undefined && timingSafeEqual(digest(presented), expected)) return

  const decision = rateLimiter.take(ip, 'admin-auth')
  if (!decision.allowed) {
    throw new HttpRefusal(429, CustomerMessages.rateLimited, {
      'retry-after': String(decision.retryAfterSeconds),
    })
  }

  throw new HttpRefusal(401, CustomerMessages.unauthorized, {
    'www-authenticate': 'Bearer realm="recoverx-licensing"',
  })
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * The address a request came from.
 *
 * Behind a reverse proxy every connection comes from the proxy, so the client
 * is read from `X-Forwarded-For` — but only when the operator says a proxy is
 * there. Trusting that header on a directly exposed server would let any client
 * choose its own address and walk straight past the rate limit. The proxy must
 * overwrite the header rather than append to it; docs/LICENSE-SERVER.md shows
 * how for Caddy and nginx.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for']
    const value = Array.isArray(header) ? header[0] : header
    const first = value?.split(',')[0]?.trim()

    if (first !== undefined && isIP(first) !== 0) return first
  }

  return req.socket.remoteAddress ?? 'unknown'
}

// --- server lifecycle -------------------------------------------------------

export function createLicenseHttpServer(options: HttpServerOptions): Server {
  const handler = createRequestHandler(options)

  const server = createServer(
    {
      // Bound how long a slow or stalled client can hold a connection. A real
      // activation request is a few hundred bytes and completes in milliseconds.
      requestTimeout: 15_000,
      headersTimeout: 10_000,
    },
    (req, res) => {
      handler(req, res).catch((error: unknown) => {
        // `handler` replies to every error itself; reaching here means the
        // response could not be written at all.
        options.logger.error('Response could not be sent', { error })
        res.destroy()
      })
    },
  )

  server.keepAliveTimeout = 5_000
  return server
}

export interface RunningServer {
  readonly server: Server
  /** Base URL, e.g. `http://127.0.0.1:8787`. */
  readonly url: string
  readonly port: number
  /**
   * Stop accepting connections, let in-flight requests finish, and force the
   * rest closed after `graceMs`.
   */
  close(graceMs?: number): Promise<void>
}

export function listen(server: Server, port: number, host: string): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }

    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)

      const address = server.address() as AddressInfo
      const hostPart = address.family === 'IPv6' ? `[${address.address}]` : address.address

      resolve({
        server,
        url: `http://${hostPart}:${address.port}`,
        port: address.port,
        close: (graceMs = 10_000) =>
          new Promise<void>((done, fail) => {
            const timer = setTimeout(() => {
              server.closeAllConnections()
            }, graceMs)
            timer.unref()

            server.close((error) => {
              clearTimeout(timer)
              if (error === undefined) done()
              else fail(error)
            })
            server.closeIdleConnections()
          }),
      })
    })
  })
}

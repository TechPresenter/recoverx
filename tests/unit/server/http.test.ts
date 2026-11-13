import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { verifyToken } from '@main/licensing/activation-token'
import { generateKey } from '@shared/utils/license-key'
import { readConfig } from '@server/config'
import { MAX_BODY_BYTES } from '@server/http'
import { createJsonLogger } from '@server/log'
import { startServer, type StartedServer } from '@server/runtime'
import {
  DAY,
  FakeClock,
  MACHINE_A,
  MACHINE_B,
  MACHINE_C,
  MACHINE_D,
  NOW,
  PRODUCT_ID,
  freshKeyPair,
  tempDir,
  type KeyPair,
  type TempDir,
} from './fixtures'

/**
 * The licence server over real HTTP, on an ephemeral loopback port.
 *
 * Started through `startServer`, the same assembly the deployed entry point
 * uses, so what is tested here is what runs in production — configuration
 * parsing, the signing-key check, the database, the router and the rate
 * limiter together.
 */

const ADMIN_TOKEN = 'test-admin-token-0123456789-abcdefghijklmnop'

interface Harness {
  readonly started: StartedServer
  readonly keys: KeyPair
  readonly clock: FakeClock
  readonly logs: string[]
  readonly dir: TempDir
  readonly url: (path: string) => string
  stop(): Promise<void>
}

async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const dir = tempDir('recoverx-licence-http-')
  const keys = freshKeyPair()
  const clock = new FakeClock()
  const logs: string[] = []

  const config = readConfig({
    LICENSE_SIGNING_KEY: keys.pem,
    LICENSE_DB_FILE: join(dir.path, 'nested', 'licences.db'),
    HOST: '127.0.0.1',
    PORT: '0',
    LICENSE_ADMIN_TOKEN: ADMIN_TOKEN,
    LICENSE_RATE_LIMIT_BURST: '1000',
    RECOVERX_LICENSE_PUBLIC_KEY: keys.publicKey,
    ...env,
  })

  const started = await startServer(
    config,
    createJsonLogger({ write: (line) => logs.push(line), clock: clock.now }),
    { clock: clock.now },
  )

  return {
    started,
    keys,
    clock,
    logs,
    dir,
    url: (path) => `${started.running.url}${path}`,
    stop: async () => {
      await started.stop(100)
      dir.cleanup()
    },
  }
}

interface Response {
  readonly status: number
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

async function request(
  harness: Harness,
  method: string,
  path: string,
  options: {
    json?: unknown
    body?: string
    headers?: Record<string, string>
    admin?: boolean
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  let body: string | undefined = options.body

  if (options.json !== undefined) {
    body = JSON.stringify(options.json)
    headers['content-type'] ??= 'application/json'
  }
  if (options.admin === true) headers.authorization = `Bearer ${ADMIN_TOKEN}`

  const response = await fetch(harness.url(path), {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  })
  const text = await response.text()

  return {
    status: response.status,
    headers: response.headers,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  }
}

async function mint(harness: Harness, json: Record<string, unknown>): Promise<string> {
  const response = await request(harness, 'POST', '/v1/admin/licenses', { json, admin: true })
  expect(response.status).toBe(201)
  const licenses = response.body.licenses as Array<{ key: string }>
  return licenses[0]?.key ?? ''
}

function activate(harness: Harness, key: string, machineId: string): Promise<Response> {
  return request(harness, 'POST', '/v1/activate', {
    json: { key, machineId, product: PRODUCT_ID },
  })
}

describe('licence server over HTTP', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await startHarness()
  })

  afterAll(async () => {
    await harness.stop()
  })

  it('reports health, for GET and HEAD', async () => {
    const get = await request(harness, 'GET', '/healthz')
    expect(get.status).toBe(200)
    expect(get.body).toEqual({ ok: true })
    expect(get.headers.get('cache-control')).toBe('no-store')
    expect(get.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)

    const head = await request(harness, 'HEAD', '/healthz')
    expect(head.status).toBe(200)
    expect(head.body).toEqual({})
  })

  it('activates, deactivates, and moves the licence to another machine', async () => {
    const key = await mint(harness, { edition: 'professional', registeredTo: 'Jane Doe' })

    const first = await activate(harness, key, MACHINE_A)
    expect(first.status).toBe(200)
    const token = first.body.token as string

    const verified = verifyToken(token, {
      publicKey: harness.keys.publicKey,
      machineId: MACHINE_A,
      expectedKey: key,
      now: NOW,
    })
    expect(verified.ok && verified.claims.registeredTo).toBe('Jane Doe')

    const blocked = await activate(harness, key, MACHINE_B)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toMatch(/already active on another computer/u)

    const released = await request(harness, 'POST', '/v1/deactivate', { json: { token } })
    expect(released).toMatchObject({ status: 200, body: { released: true } })

    const moved = await activate(harness, key, MACHINE_B)
    expect(moved.status).toBe(200)

    const again = await request(harness, 'POST', '/v1/deactivate', { json: { token } })
    expect(again).toMatchObject({ status: 200, body: { released: false } })
  })

  it('re-issues a token to a machine that already holds the seat', async () => {
    const key = await mint(harness, { edition: 'professional' })

    expect((await activate(harness, key, MACHINE_A)).status).toBe(200)
    expect((await activate(harness, key, MACHINE_A)).status).toBe(200)
  })

  it('answers each refusal with its status and a customer-readable sentence', async () => {
    const unknown = await activate(
      harness,
      generateKey(() => 9),
      MACHINE_A,
    )
    expect(unknown.status).toBe(404)
    expect(Object.keys(unknown.body)).toEqual(['error'])
    expect(unknown.body.error).toMatch(/could not find that licence key/u)

    const revokedKey = await mint(harness, { edition: 'professional' })
    await request(harness, 'POST', `/v1/admin/licenses/${revokedKey}/revoke`, {
      json: { reason: 'refund' },
      admin: true,
    })
    const revoked = await activate(harness, revokedKey, MACHINE_A)
    expect(revoked.status).toBe(403)
    expect(revoked.body.error).toMatch(/no longer valid/u)

    const termKey = await mint(harness, { edition: 'professional', days: 30 })
    harness.clock.advance(31 * DAY)
    try {
      const expired = await activate(harness, termKey, MACHINE_A)
      expect(expired.status).toBe(403)
      expect(expired.body.error).toMatch(/^This licence ended on 12 December 2026\./u)
    } finally {
      harness.clock.advance(-31 * DAY)
    }

    const typo = await activate(harness, 'RECX-AAAAA-AAAAA-AAAAA-AAAAB', MACHINE_A)
    expect(typo.status).toBe(400)
    expect(typo.body.error).toMatch(/typing error/u)

    const product = await request(harness, 'POST', '/v1/activate', {
      json: { key: revokedKey, machineId: MACHINE_A, product: 'something-else' },
    })
    expect(product.status).toBe(400)

    const incomplete = await request(harness, 'POST', '/v1/activate', { json: { key: 'x' } })
    expect(incomplete.status).toBe(400)
    expect(incomplete.body.error).toMatch(/Update RecoverX/u)

    const unreadable = await request(harness, 'POST', '/v1/activate', {
      body: '{"key": ',
      headers: { 'content-type': 'application/json' },
    })
    expect(unreadable.status).toBe(400)

    const garbageToken = await request(harness, 'POST', '/v1/deactivate', {
      json: { token: 'not-a-token' },
    })
    expect(garbageToken.status).toBe(400)
  })

  it('refuses the wrong content type, an oversized body, the wrong method and unknown paths', async () => {
    const wrongType = await request(harness, 'POST', '/v1/activate', {
      body: 'key=RECX',
      headers: { 'content-type': 'text/plain' },
    })
    expect(wrongType.status).toBe(415)

    // A charset parameter is fine.
    const withCharset = await request(harness, 'POST', '/v1/activate', {
      json: { key: 'x' },
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    expect(withCharset.status).toBe(400)

    const tooLarge = await request(harness, 'POST', '/v1/activate', {
      json: { key: 'x'.repeat(MAX_BODY_BYTES), machineId: MACHINE_A, product: PRODUCT_ID },
    })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body.error).toMatch(/too large/u)

    const wrongMethod = await request(harness, 'GET', '/v1/activate')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const missing = await request(harness, 'GET', '/v1/nothing-here')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toEqual(expect.any(String))
  })

  it('never lets two simultaneous requests share the last seats', async () => {
    const key = await mint(harness, { edition: 'business' })
    const machines = [
      MACHINE_A,
      MACHINE_B,
      MACHINE_C,
      MACHINE_D,
      'MNOP-QRST-VWXY-Z012-3456-789A',
      'BBBB-CCCC-DDDD-EEEE-FFFF-GGGG',
    ]

    const results = await Promise.all(machines.map((machine) => activate(harness, key, machine)))
    const statuses = results.map((result) => result.status).sort()

    expect(statuses).toEqual([200, 200, 200, 409, 409, 409])
  })

  it('never writes a full licence key or a token to the log', async () => {
    const key = await mint(harness, { edition: 'professional' })
    const { body } = await activate(harness, key, MACHINE_A)
    await request(harness, 'GET', `/v1/admin/licenses/${key}`, { admin: true })
    await request(harness, 'POST', '/v1/deactivate', { json: { token: body.token } })

    const log = harness.logs.join('')
    expect(log).toContain('"route":"activate"')
    expect(log).toContain(key.slice(-5))
    expect(log).not.toContain(key)
    expect(log).not.toContain(body.token as string)
    expect(log).not.toContain(ADMIN_TOKEN)

    for (const line of harness.logs) {
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    }
  })
})

describe('admin API', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await startHarness()
  })

  afterAll(async () => {
    await harness.stop()
  })

  it('requires the bearer token', async () => {
    const missing = await request(harness, 'GET', '/v1/admin/licenses')
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/u)

    const wrong = await request(harness, 'GET', '/v1/admin/licenses', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}x` },
    })
    expect(wrong.status).toBe(401)

    const basic = await request(harness, 'GET', '/v1/admin/licenses', {
      headers: { authorization: `Basic ${Buffer.from(`admin:${ADMIN_TOKEN}`).toString('base64')}` },
    })
    expect(basic.status).toBe(401)

    const right = await request(harness, 'GET', '/v1/admin/licenses', { admin: true })
    expect(right.status).toBe(200)
  })

  it('mints licences idempotently per order, as a payment webhook needs', async () => {
    const json = {
      edition: 'business',
      count: 2,
      days: 365,
      registeredTo: 'Contoso Ltd',
      email: 'it@contoso.example',
      orderRef: 'stripe:cs_test_123',
    }

    const created = await request(harness, 'POST', '/v1/admin/licenses', { json, admin: true })
    expect(created.status).toBe(201)
    expect(created.body.created).toBe(true)

    const replay = await request(harness, 'POST', '/v1/admin/licenses', { json, admin: true })
    expect(replay.status).toBe(200)
    expect(replay.body.created).toBe(false)
    const keysOf = (body: Record<string, unknown>): string[] =>
      (body.licenses as Array<{ key: string }>).map((license) => license.key).sort()
    expect(keysOf(replay.body)).toEqual(keysOf(created.body))

    const listed = await request(
      harness,
      'GET',
      '/v1/admin/licenses?orderRef=stripe%3Acs_test_123',
      { admin: true },
    )
    expect((listed.body.licenses as unknown[]).length).toBe(2)
  })

  it('validates admin input and explains what is wrong', async () => {
    const free = await request(harness, 'POST', '/v1/admin/licenses', {
      json: { edition: 'free' },
      admin: true,
    })
    expect(free.status).toBe(400)
    expect(free.body.error).toMatch(/Free edition/u)

    const typo = await request(harness, 'POST', '/v1/admin/licenses', {
      json: { edition: 'professional', registered_to: 'Jane' },
      admin: true,
    })
    expect(typo.status).toBe(400)
    expect(typo.body.error).toMatch(/registered_to/u)

    const badQuery = await request(harness, 'GET', '/v1/admin/licenses?limit=zero', {
      admin: true,
    })
    expect(badQuery.status).toBe(400)

    const notFound = await request(harness, 'GET', `/v1/admin/licenses/${generateKey(() => 4)}`, {
      admin: true,
    })
    expect(notFound.status).toBe(404)
  })

  it('shows, revokes, restores, extends, releases and resets', async () => {
    const key = await mint(harness, { edition: 'business', days: 30, orderRef: 'INV-77' })
    await activate(harness, key, MACHINE_A)
    await activate(harness, key, MACHINE_B)

    const shown = await request(harness, 'GET', `/v1/admin/licenses/${key}`, { admin: true })
    expect(shown.status).toBe(200)
    expect(shown.body).toMatchObject({ standing: 'active', activeSeats: 2 })

    const revoked = await request(harness, 'POST', `/v1/admin/licenses/${key}/revoke`, {
      admin: true,
    })
    expect(revoked.body).toMatchObject({ license: { revokedAt: NOW } })

    const restored = await request(harness, 'POST', `/v1/admin/licenses/${key}/restore`, {
      admin: true,
    })
    expect(restored.body).toMatchObject({ license: { revokedAt: null } })

    const extended = await request(harness, 'POST', `/v1/admin/licenses/${key}/extend`, {
      json: { days: 365 },
      admin: true,
    })
    expect(extended.body).toMatchObject({ license: { expiresAt: NOW + 395 * DAY } })

    const release = await request(harness, 'POST', `/v1/admin/licenses/${key}/release`, {
      json: { machineId: MACHINE_A },
      admin: true,
    })
    expect(release.body).toEqual({ released: true })

    const reset = await request(harness, 'POST', `/v1/admin/licenses/${key}/reset`, {
      admin: true,
    })
    expect(reset.body).toEqual({ released: 1 })
  })

  it('issues an offline activation', async () => {
    const key = await mint(harness, { edition: 'professional' })

    const offline = await request(harness, 'POST', `/v1/admin/licenses/${key}/offline`, {
      json: { machineId: MACHINE_C.toLowerCase() },
      admin: true,
    })

    expect(offline.status).toBe(200)
    expect(
      verifyToken(offline.body.token as string, {
        publicKey: harness.keys.publicKey,
        machineId: MACHINE_C,
        expectedKey: key,
        now: NOW,
      }).ok,
    ).toBe(true)
  })
})

describe('self-service release allowance over HTTP', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await startHarness({ LICENSE_SELF_RELEASE_LIMIT: '2' })
  })

  afterAll(async () => {
    await harness.stop()
  })

  function deactivate(token: string): Promise<Response> {
    return request(harness, 'POST', '/v1/deactivate', { json: { token } })
  }

  async function tokenFor(key: string, machineId: string): Promise<string> {
    const response = await activate(harness, key, machineId)
    expect(response.status).toBe(200)
    return response.body.token as string
  }

  async function show(key: string): Promise<Record<string, unknown>> {
    return (await request(harness, 'GET', `/v1/admin/licenses/${key}`, { admin: true })).body
  }

  it('answers 409 with the customer sentence and keeps the seat', async () => {
    const key = await mint(harness, { edition: 'professional' })

    for (let move = 0; move < 2; move += 1) {
      const released = await deactivate(await tokenFor(key, MACHINE_A))
      expect(released).toMatchObject({ status: 200, body: { released: true } })
    }

    const held = await tokenFor(key, MACHINE_A)
    const refused = await deactivate(held)

    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({
      error:
        'This licence has already been moved between computers twice in the last 12 months. ' +
        'It is still active on this computer. To move it again, contact info@appsgain.in with your licence key.',
    })

    // Asking again gets the same answer: the seat is still held, so this is
    // not the idempotent "already free" case.
    expect((await deactivate(held)).status).toBe(409)

    expect(await show(key)).toMatchObject({
      activeSeats: 1,
      selfReleases: { recent: 2, limit: 2, windowDays: 365 },
    })
    const blocked = await activate(harness, key, MACHINE_B)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toMatch(/already active on another computer/u)

    // The request log names the refusal, with the key masked.
    const line = harness.logs.find(
      (entry) => entry.includes('"route":"deactivate"') && entry.includes('"status":409'),
    )
    expect(line).toContain('"refusal":"self-release-limit"')
    expect(line).toContain(`"machine":"${MACHINE_A}"`)
    expect(line).not.toContain(key)
  })

  it('lets the admin API release and reset past it, without counting either', async () => {
    const key = await mint(harness, { edition: 'business' })
    await deactivate(await tokenFor(key, MACHINE_A))
    await deactivate(await tokenFor(key, MACHINE_A))
    const held = await tokenFor(key, MACHINE_A)
    expect((await deactivate(held)).status).toBe(409)

    const release = await request(harness, 'POST', `/v1/admin/licenses/${key}/release`, {
      json: { machineId: MACHINE_A },
      admin: true,
    })
    expect(release.body).toEqual({ released: true })

    // The old computer's own release now finds the seat free and is told so.
    expect(await deactivate(held)).toMatchObject({ status: 200, body: { released: false } })

    await tokenFor(key, MACHINE_B)
    await tokenFor(key, MACHINE_C)
    const reset = await request(harness, 'POST', `/v1/admin/licenses/${key}/reset`, {
      admin: true,
    })
    expect(reset.body).toEqual({ released: 2 })

    expect(await show(key)).toMatchObject({
      activeSeats: 0,
      selfReleases: { recent: 2, limit: 2 },
    })
  })

  it('is enforced from the first release when the limit is 0', async () => {
    const strict = await startHarness({ LICENSE_SELF_RELEASE_LIMIT: '0' })
    try {
      const key = await mint(strict, { edition: 'professional' })
      const first = await activate(strict, key, MACHINE_A)

      const refused = await request(strict, 'POST', '/v1/deactivate', {
        json: { token: first.body.token },
      })
      expect(refused.status).toBe(409)
      expect(refused.body.error).toMatch(
        /^This licence can only be moved to another computer by our support team\. It is still active on this computer\./u,
      )
    } finally {
      await strict.stop()
    }
  })
})

describe('restarting the server', () => {
  it('keeps the self-service release count, which lives in the database', async () => {
    const dir = tempDir('recoverx-licence-restart-')
    const keys = freshKeyPair()
    const clock = new FakeClock()
    const config = readConfig({
      LICENSE_SIGNING_KEY: keys.pem,
      LICENSE_DB_FILE: join(dir.path, 'licences.db'),
      PORT: '0',
      LICENSE_ADMIN_TOKEN: ADMIN_TOKEN,
      LICENSE_SELF_RELEASE_LIMIT: '1',
    })
    const start = (): Promise<StartedServer> =>
      startServer(config, createJsonLogger({ write: () => undefined }), { clock: clock.now })
    const post = async (
      server: StartedServer,
      path: string,
      json: unknown,
      admin = false,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`${server.running.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(admin ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
        },
        body: JSON.stringify(json),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }
    const activation = { machineId: MACHINE_A, product: PRODUCT_ID }

    try {
      let key = ''
      const before = await start()
      try {
        const created = await post(before, '/v1/admin/licenses', { edition: 'professional' }, true)
        key = (created.body.licenses as Array<{ key: string }>)[0]?.key ?? ''

        const first = await post(before, '/v1/activate', { key, ...activation })
        const released = await post(before, '/v1/deactivate', { token: first.body.token })
        expect(released).toEqual({ status: 200, body: { released: true } })
      } finally {
        await before.stop(100)
      }

      const after = await start()
      try {
        const second = await post(after, '/v1/activate', { key, ...activation })
        const refused = await post(after, '/v1/deactivate', { token: second.body.token })
        expect(refused.status).toBe(409)
        expect(refused.body.error).toMatch(/moved between computers once in the last 12 months/u)
      } finally {
        await after.stop(100)
      }
    } finally {
      dir.cleanup()
    }
  })
})

describe('renewal by re-activation over HTTP', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await startHarness()
  })

  afterAll(async () => {
    await harness.stop()
  })

  it('re-issues the same machine a token with the extended end date', async () => {
    const key = await mint(harness, { edition: 'business', days: 30, registeredTo: 'Contoso' })
    const before = await activate(harness, key, MACHINE_A)

    const extended = await request(harness, 'POST', `/v1/admin/licenses/${key}/extend`, {
      json: { days: 365 },
      admin: true,
    })
    expect(extended.status).toBe(200)

    const after = await activate(harness, key, MACHINE_A)
    expect(after.status).toBe(200)

    const options = {
      publicKey: harness.keys.publicKey,
      machineId: MACHINE_A,
      expectedKey: key,
      now: NOW + 31 * DAY,
    }
    expect(verifyToken(before.body.token as string, options)).toEqual({
      ok: false,
      failure: 'expired',
    })

    const renewed = verifyToken(after.body.token as string, options)
    expect(renewed.ok && renewed.claims).toMatchObject({
      edition: 'business',
      expiresAt: NOW + 395 * DAY,
      registeredTo: 'Contoso',
    })
    expect(
      await request(harness, 'GET', `/v1/admin/licenses/${key}`, { admin: true }),
    ).toMatchObject({ body: { activeSeats: 1 } })
  })
})

describe('admin token characters', () => {
  it('authenticates every token the configuration accepts, punctuation included', async () => {
    // config.ts admits any printable ASCII without spaces; this is the other
    // half of that promise — the header parser must read all of it back.
    const token = `${'Z'.repeat(16)}!#$%&'*+-./~^_|=0`
    const harness = await startHarness({ LICENSE_ADMIN_TOKEN: token })

    try {
      const response = await request(harness, 'GET', '/v1/admin/licenses', {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
    } finally {
      await harness.stop()
    }
  })
})

describe('starting without a database path', () => {
  it('refuses, instead of creating one relative to the working directory', async () => {
    const keys = freshKeyPair()
    const config = readConfig({ LICENSE_SIGNING_KEY: keys.pem, PORT: '0' })

    await expect(startServer(config, createJsonLogger({ write: () => undefined }))).rejects.toThrow(
      /LICENSE_DB_FILE is not set/u,
    )
  })
})

describe('admin API disabled', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await startHarness({ LICENSE_ADMIN_TOKEN: '' })
  })

  afterAll(async () => {
    await harness.stop()
  })

  it('is indistinguishable from an absent one, whatever token is sent', async () => {
    for (const headers of [{}, { authorization: `Bearer ${ADMIN_TOKEN}` }]) {
      const response = await request(harness, 'GET', '/v1/admin/licenses', { headers })
      expect(response.status).toBe(404)
    }

    const create = await request(harness, 'POST', '/v1/admin/licenses', {
      json: { edition: 'professional' },
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(create.status).toBe(404)
  })

  it('still serves the public routes', async () => {
    expect((await request(harness, 'GET', '/healthz')).status).toBe(200)
  })
})

describe('rate limiting', () => {
  let harness: Harness

  afterEach(async () => {
    await harness.stop()
  })

  it('answers 429 with Retry-After once a client’s burst is spent', async () => {
    harness = await startHarness({
      LICENSE_RATE_LIMIT_BURST: '2',
      LICENSE_RATE_LIMIT_PER_MINUTE: '6',
    })
    const key = generateKey(() => 1)

    expect((await activate(harness, key, MACHINE_A)).status).toBe(404)
    expect((await activate(harness, key, MACHINE_A)).status).toBe(404)

    const limited = await activate(harness, key, MACHINE_A)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('10')
    expect(limited.body.error).toMatch(/Wait a minute/u)

    // Health checks are never throttled.
    expect((await request(harness, 'GET', '/healthz')).status).toBe(200)

    harness.clock.advance(10_000)
    expect((await activate(harness, key, MACHINE_A)).status).toBe(404)
  })

  it('throttles repeated admin token guesses separately from activations', async () => {
    harness = await startHarness({ LICENSE_RATE_LIMIT_BURST: '2' })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const guess = await request(harness, 'GET', '/v1/admin/licenses', {
        headers: { authorization: 'Bearer guess-guess-guess-guess-guess-guess' },
      })
      expect(guess.status).toBe(401)
    }

    const throttled = await request(harness, 'GET', '/v1/admin/licenses', {
      headers: { authorization: 'Bearer guess-guess-guess-guess-guess-guess' },
    })
    expect(throttled.status).toBe(429)

    // The holder of the real token is not locked out by someone else guessing.
    expect((await request(harness, 'GET', '/v1/admin/licenses', { admin: true })).status).toBe(200)
  })

  it('uses the first X-Forwarded-For hop only when told a proxy is in front', async () => {
    harness = await startHarness({ LICENSE_TRUST_PROXY: 'true', LICENSE_RATE_LIMIT_BURST: '1' })
    const key = await mint(harness, { edition: 'technician' })

    const viaProxy = (address: string): Promise<Response> =>
      request(harness, 'POST', '/v1/activate', {
        json: { key, machineId: MACHINE_A, product: PRODUCT_ID },
        headers: { 'x-forwarded-for': `${address}, 10.0.0.1` },
      })

    expect((await viaProxy('198.51.100.9')).status).toBe(200)
    expect((await viaProxy('198.51.100.9')).status).toBe(429)
    // A different client behind the same proxy has its own budget.
    expect((await viaProxy('198.51.100.10')).status).toBe(200)

    const shown = await request(harness, 'GET', `/v1/admin/licenses/${key}`, { admin: true })
    const events = shown.body.events as Array<{ type: string; ip: string | null }>
    expect(events.find((event) => event.type === 'activated')?.ip).toBe('198.51.100.9')
  })
})

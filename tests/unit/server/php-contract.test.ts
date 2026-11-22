import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createPrivateKey, createPublicKey, randomInt, sign } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyToken } from '@main/licensing/activation-token'
import { SUPPORT_EMAIL, WEBSITE_URL } from '@shared/constants/app'
import { KEY_PREFIX } from '@shared/types/license'
import {
  KEY_ALPHABET,
  completeKey,
  formatKey,
  generateKey,
  maskKey,
  normalizeKeyInput,
  validateKey,
} from '@shared/utils/license-key'
import { LicenseError } from '@server/errors'
import { parseExpiryDate } from '@server/expiry'
import { CustomerMessages, describeKeyProblem, formatCustomerDate } from '@server/messages'
import { clientBucketId } from '@server/rate-limit'
import { EventRetention } from '@server/retention'
import { fingerprintOf } from '@server/signing'
import { LicenseStore } from '@server/store'
import {
  DAY,
  MACHINE_A,
  MACHINE_B,
  MACHINE_C,
  MACHINE_D,
  PRODUCT_ID,
  freshKeyPair,
  picksFor,
  type KeyPair,
} from './fixtures'

/**
 * Contract parity between the PHP licence server (server-php/) and the
 * reference Node server (src/server/).
 *
 * The PHP server is a second implementation of the same HTTP contract, for
 * shared hosting. The desktop client must not be able to tell the two apart,
 * so this file runs the reference's HTTP scenarios (tests/unit/server/
 * http.test.ts) against the real PHP code: each harness copies app/ and
 * public/ into a throwaway tree laid out like the Hostinger site, provisions
 * it with app/bin/provision.php (the same Installer /setup/ uses), and serves
 * it with `php -S` and tests/support/router.php, which stands in for the
 * .htaccess rewrites.
 *
 * Every token the PHP server issues is verified with the desktop client's own
 * `verifyToken`; keys, dates, client addresses and customer sentences are
 * compared with the TypeScript implementations on shared corpora.
 *
 * Skipped — not failed — when no PHP 8.1+ with sodium and pdo_sqlite is found
 * (RECOVERX_PHP_BIN, then `php` on the PATH, then C:/xampp/php/php.exe), so
 * CI without PHP stays green.
 */

interface Php {
  readonly bin: string
  readonly args: readonly string[]
}

function findPhp(): Php | null {
  const candidates = [process.env.RECOVERX_PHP_BIN, 'php', 'C:/xampp/php/php.exe'].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  )
  const check =
    "echo (extension_loaded('sodium') ? 1 : 0), ' ', (extension_loaded('pdo_sqlite') ? 1 : 0), ' ', PHP_VERSION_ID;"

  for (const bin of candidates) {
    for (const args of [[], ['-d', 'extension=sodium']]) {
      const result = spawnSync(bin, [...args, '-d', 'display_startup_errors=0', '-r', check], {
        encoding: 'utf8',
        timeout: 15_000,
      })
      if (result.error !== undefined) break
      if (result.status !== 0) continue

      const [sodium, sqlite, id] = result.stdout.trim().split(/\s+/u).slice(-3)
      if (sodium === '1' && sqlite === '1' && Number(id) >= 80100) return { bin, args }
    }
  }

  return null
}

const PHP = findPhp()

const SERVER_PHP = resolve(__dirname, '../../../server-php')
const ROUTER = join(SERVER_PHP, 'tests', 'support', 'router.php')
const PROBE = join(SERVER_PHP, 'tests', 'support', 'probe.php')

const ADMIN_TOKEN = 'test-admin-token-0123456789-abcdefghijklmnop'
const ADMIN_PASSWORD = 'correct horse battery staple'

/** The PHP deployment's support address and website, named in its customer sentences. */
const SUPPORT = 'info@appsgain.in'
const WEBSITE = 'https://recoverx.snapkio.com'

/**
 * A reference sentence as the PHP deployment says it: the reference's own
 * support address and website (src/shared/constants/app.ts) mapped to the
 * deployment's. A no-op once the two agree, and still right if they diverge.
 */
function deployed(sentence: string): string {
  return sentence.replaceAll(SUPPORT_EMAIL, SUPPORT).replaceAll(WEBSITE_URL, WEBSITE)
}

const HOOK_TIMEOUT = 60_000
const TEST_TIMEOUT = 60_000

function php(): Php {
  if (PHP === null) throw new Error('PHP is not available')
  return PHP
}

/** Ask the PHP implementation, through tests/support/probe.php. */
function probe(requests: ReadonlyArray<Record<string, unknown>>): unknown[] {
  const output = execFileSync(php().bin, [...php().args, PROBE], {
    input: JSON.stringify(requests),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(output) as unknown[]
}

// --- the harness --------------------------------------------------------------------

interface HarnessOptions {
  /** Overrides of the server settings (Config::DEFAULTS), as provision.php --set. */
  readonly settings?: Readonly<Record<string, string | number | boolean>>
  /** `null` leaves the admin API off. */
  readonly apiToken?: string | null
  /** A PKCS#8 PEM to import instead of generating a key on the server. */
  readonly importPem?: string
  /** Skip provisioning, to drive /setup/ itself. */
  readonly provision?: boolean
}

interface Harness {
  readonly root: string
  readonly dataDir: string
  /** SPKI DER base64, as a desktop build embeds it. */
  readonly publicKey: string
  url(path: string): string
  /** Run something against the licence database directly (to stand in for the passage of time). */
  db<T>(work: (db: DatabaseSync) => T): T
  logs(): string
  stop(): Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        done(port)
      })
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'recoverx-php-'))
  const installDir = join(root, 'recoverx-licensing')
  cpSync(join(SERVER_PHP, 'app'), join(installDir, 'app'), { recursive: true })
  cpSync(join(SERVER_PHP, 'public'), join(root, 'public_html'), { recursive: true })

  let publicKey = ''
  if (options.provision !== false) {
    const args = [`--password=${ADMIN_PASSWORD}`, '--site-url=http://127.0.0.1']
    const token = options.apiToken === undefined ? ADMIN_TOKEN : options.apiToken
    if (token !== null) args.push(`--api-token=${token}`)
    if (options.importPem !== undefined) {
      const pemFile = join(root, 'import.pem')
      writeFileSync(pemFile, options.importPem)
      args.push(`--import-pem=${pemFile}`)
    }
    for (const [name, value] of Object.entries(options.settings ?? {})) {
      args.push(`--set=${name}=${String(value)}`)
    }

    const output = execFileSync(
      php().bin,
      [...php().args, join(installDir, 'app', 'bin', 'provision.php'), ...args],
      { encoding: 'utf8' },
    )
    publicKey = (JSON.parse(output) as { publicKey: string }).publicKey
  }

  const port = await freePort()
  const child: ChildProcess = spawn(
    php().bin,
    [
      ...php().args,
      '-d',
      'display_errors=0',
      '-S',
      `127.0.0.1:${port}`,
      '-t',
      join(root, 'public_html'),
      ROUTER,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let serverOutput = ''
  child.stdout?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString('utf8')))
  const exited = new Promise<void>((done) => child.once('exit', () => done()))

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      await fetch(`${base}/healthz`)
      break
    } catch {
      if (Date.now() > deadline || child.exitCode !== null) {
        child.kill()
        throw new Error(`php -S did not start:\n${serverOutput}`)
      }
      await delay(100)
    }
  }

  const dataDir = join(installDir, 'data')

  return {
    root,
    dataDir,
    publicKey,
    url: (path) => `${base}${path}`,
    db: (work) => {
      const db = new DatabaseSync(join(dataDir, 'licences.db'), { timeout: 5000 })
      try {
        return work(db)
      } finally {
        db.close()
      }
    },
    logs: () => {
      const directory = join(dataDir, 'logs')
      if (!existsSync(directory)) return ''
      return readdirSync(directory)
        .filter((name) => name.endsWith('.log'))
        .map((name) => readFileSync(join(directory, name), 'utf8'))
        .join('')
    },
    stop: async () => {
      if (child.exitCode === null) {
        child.kill()
        await exited
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

      // The server logs its own failures privately, so anything PHP itself
      // printed — a warning, a notice, a deprecation — is a defect.
      const problems = serverOutput
        .split('\n')
        .filter((line) => /PHP (?:Deprecated|Warning|Notice|Fatal error)|deprecated:/iu.test(line))
      expect(problems).toEqual([])
    },
  }
}

interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly body: Record<string, unknown>
  readonly text: string
}

interface RequestOptions {
  readonly json?: unknown
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly admin?: boolean
}

async function request(
  harness: Harness,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers }
  let body = options.body

  if (options.json !== undefined) {
    body = JSON.stringify(options.json)
    headers['content-type'] ??= 'application/json'
  }
  if (options.admin === true) headers.authorization = `Bearer ${ADMIN_TOKEN}`

  const response = await fetch(harness.url(path), {
    method,
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body }),
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  if (text.length > 0 && (response.headers.get('content-type') ?? '').includes('json')) {
    parsed = JSON.parse(text) as Record<string, unknown>
  }

  return { status: response.status, headers: response.headers, body: parsed, text }
}

async function mint(harness: Harness, json: Record<string, unknown>): Promise<string> {
  const response = await request(harness, 'POST', '/v1/admin/licenses', { json, admin: true })
  expect(response.status).toBe(201)
  const licenses = response.body.licenses as Array<{ key: string }>
  return licenses[0]?.key ?? ''
}

function activate(harness: Harness, key: string, machineId: string): Promise<Reply> {
  return request(harness, 'POST', '/v1/activate', {
    json: { key, machineId, product: PRODUCT_ID },
  })
}

function deactivate(harness: Harness, token: unknown): Promise<Reply> {
  return request(harness, 'POST', '/v1/deactivate', { json: { token } })
}

async function show(harness: Harness, key: string): Promise<Record<string, unknown>> {
  const response = await request(harness, 'GET', `/v1/admin/licenses/${key}`, { admin: true })
  expect(response.status).toBe(200)
  return response.body
}

async function licenseOf(harness: Harness, key: string): Promise<Record<string, unknown>> {
  return (await show(harness, key)).license as Record<string, unknown>
}

/** Verify a PHP-issued token with the desktop client's own verifier. */
function clientVerify(
  harness: Harness,
  token: unknown,
  machineId: string,
  expectedKey?: string,
  now = Date.now(),
): ReturnType<typeof verifyToken> {
  expect(typeof token).toBe('string')
  return verifyToken(token as string, {
    publicKey: harness.publicKey,
    machineId,
    expectedKey,
    now,
  })
}

/** A token in the documented format, signed here rather than by the server. */
function signToken(keys: KeyPair, claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const signature = sign(null, Buffer.from(payload, 'utf8'), keys.privateKey).toString('base64url')
  return `${payload}.${signature}`
}

/**
 * The prefix as a customer might mistype it, through the same confusions the
 * key body allows (license-key.ts). `RECX` has none, so this is the prefix
 * itself; the corpus below stays meaningful for a prefix that has some.
 */
const CONFUSABLE: Readonly<Record<string, string>> = { I: '1', L: '1', O: '0', U: 'V' }
const MISTYPED_PREFIX = [...KEY_PREFIX]
  .map((character) => CONFUSABLE[character] ?? character)
  .join('')

interface RetentionCase {
  readonly now: number
  readonly days: number
  readonly windowDays: number
  readonly events: readonly number[]
}

/** The reference's retention pass (retention.ts) over a throwaway database. */
function nodeRetention(scenario: RetentionCase): unknown {
  const directory = mkdtempSync(join(tmpdir(), 'recoverx-retention-'))
  const store = LicenseStore.open(join(directory, 'licences.db'))
  try {
    for (const at of scenario.events) {
      store.recordEvent({
        at,
        type: 'activated',
        key: null,
        machineId: null,
        ip: null,
        detail: null,
      })
    }

    let retention: EventRetention
    try {
      retention = new EventRetention({
        store,
        days: scenario.days,
        selfReleaseWindowDays: scenario.windowDays,
        clock: () => scenario.now,
      })
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }

    const result = retention.prune()
    const remaining = store.db
      .prepare('SELECT at FROM events ORDER BY at, id')
      .all()
      .map((row) => Number(row.at))
    return { ok: true, cutoff: result.cutoff, deleted: result.deleted, remaining }
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Insert an event straight into a harness's database, as if recorded at `at`. */
function insertEvent(harness: Harness, at: number): void {
  harness.db((db) =>
    db
      .prepare(
        "INSERT INTO events (at, type, key, machine_id, ip, detail) VALUES (?, 'activated', NULL, NULL, '203.0.113.9', NULL)",
      )
      .run(at),
  )
}

// --- the suite --------------------------------------------------------------------------

describe.skipIf(PHP === null)(
  'PHP licence server: contract parity with the reference',
  { timeout: TEST_TIMEOUT },
  () => {
    describe('formats shared with the desktop client', () => {
      it(
        'keys generated by PHP pass the client validateKey, and TypeScript keys validate in PHP',
        () => {
          const [phpKeys] = probe([{ op: 'generateKeys', count: 500 }]) as [string[]]
          expect(phpKeys).toHaveLength(500)
          for (const key of phpKeys) {
            expect(validateKey(key)).toEqual({ ok: true, key, problem: null })
          }

          const tsKeys = Array.from({ length: 500 }, () => generateKey((max) => randomInt(max)))
          const answers = probe(tsKeys.map((input) => ({ op: 'validateKey', input })))
          answers.forEach((answer, index) => {
            expect(answer).toEqual({ ok: true, key: tsKeys[index], problem: null })
          })
        },
        TEST_TIMEOUT,
      )

      it('generates a body that begins like the prefix exactly as generateKey does', () => {
        const picks = picksFor(`${MISTYPED_PREFIX}BCDEFGHJKMNPQRSTVWXYZ`.slice(0, 19), KEY_ALPHABET)
        let index = 0
        const tsKey = generateKey(() => picks[index++] ?? 0)

        const [phpKey] = probe([{ op: 'generateKeyFromPicks', picks }])
        expect(phpKey).toBe(tsKey)
        expect(tsKey.startsWith(`${KEY_PREFIX}-${MISTYPED_PREFIX}`)).toBe(true)
      })

      it('normalises, validates, formats, masks and completes like license-key.ts', () => {
        const prefix = KEY_PREFIX
        const lower = KEY_PREFIX.toLowerCase()
        const sample = generateKey((max) => randomInt(max))
        const body = sample.slice(prefix.length + 1).replaceAll('-', '')
        const flipped = sample.replace(/.$/u, (last) => (last === '0' ? '1' : '0'))
        const corpus = [
          '',
          ' ',
          '-',
          '---',
          prefix,
          lower,
          MISTYPED_PREFIX,
          MISTYPED_PREFIX.toLowerCase(),
          `${prefix.slice(0, -1)}L`,
          `${prefix.slice(0, 2)} ${prefix.slice(2)}`,
          `${prefix}${prefix}`,
          sample,
          sample.toLowerCase(),
          sample.replaceAll('-', ''),
          ` ${sample}\t`,
          sample.replaceAll('-', ' '),
          `${MISTYPED_PREFIX}${body}`,
          `${MISTYPED_PREFIX.toLowerCase()}-${body.toLowerCase()}`,
          `${prefix}\u00a0${body}\u3000`,
          `${prefix}\ufeff${body}\u2028`,
          `${prefix}\u0085${body}`,
          `${prefix}--${body}`,
          `${prefix}${prefix}${body.slice(prefix.length)}`,
          body,
          `ABCD-${body}`,
          sample.slice(0, -1),
          `${sample}0`,
          flipped,
          `${prefix}-IIIII-OOOOO-LLLLL-UUUUU`,
          `${lower}-iiiii-ooooo-lllll-uuuuu`,
          `${prefix}-1234é-12345-12345-12345`,
          `${prefix}${'A'.repeat(19)}é`,
          `${prefix}${'A'.repeat(19)}😀`,
          `${prefix}-ABCDE-FGHJK-12345-MNPQR`,
          `${lower}ı`,
          `${lower}ß`,
          'ſ',
          'ﬀ',
          `${prefix}${body.slice(0, 10)}ß${body.slice(10)}`,
          `${prefix}-AAAAA-AAAAA-AAAAA-AAAAB`,
          `${prefix}_AAAAA`,
          `${prefix}\tABCDE\nFGHJK\r12345\v`,
          '0123456789ABCDEFGHJ',
          `${prefix}0123456789ABCDEFGHJ`,
          `${lower}-01234-56789-abcde-fghj`,
        ]

        const requests = corpus.flatMap((input) => [
          { op: 'validateKey', input },
          { op: 'normalizeKeyInput', input },
          { op: 'formatKey', input },
          { op: 'completeKey', input },
          { op: 'maskKey', input },
        ])
        const answers = probe(requests)

        // JavaScript groups a key for display by UTF-16 unit, so an astral
        // character (an emoji) is split into two lone surrogates there, which
        // UTF-8 PHP cannot represent; display formatting of such input is the
        // one place the two may differ. Validation never does.
        const astral = /[\u{10000}-\u{10FFFF}]/u

        corpus.forEach((input, index) => {
          const [validation, normalized, formatted, completed, masked] = answers.slice(
            index * 5,
            index * 5 + 5,
          )
          const label = JSON.stringify(input)
          expect(validation, label).toEqual(validateKey(input))
          expect(normalized, label).toBe(normalizeKeyInput(input))
          expect(completed, label).toBe(completeKey(input))
          if (!astral.test(input)) {
            expect(formatted, label).toBe(formatKey(input))
            expect(masked, label).toBe(maskKey(input))
          }
        })
      })

      it('reads expiry dates exactly like expiry.ts, refusals included', () => {
        const corpus = [
          '2027-03-31',
          ' 2027-03-31 ',
          '2028-02-29',
          '2027-02-29',
          '2027-13-01',
          '2027-00-10',
          '0099-01-01',
          '0100-01-01',
          '2027-3-31',
          '20270331',
          'next tuesday',
          '',
          '2027-03-31T12:00:00Z',
          '2027-03-31T12:00+05:30',
          '2027-03-31T12:00:00.5Z',
          '2027-03-31T12:00:00.12Z',
          '2027-03-31T12:00:00.123-08:00',
          '2027-03-31T12:00:00',
          '2027-03-31T24:00:00Z',
          '2027-03-31T24:00:00.000Z',
          '2027-03-31T24:00:01Z',
          '2027-03-31T24:01Z',
          '2027-03-31T25:00:00Z',
          '2027-03-31T23:60Z',
          '2027-03-31T23:59:60Z',
          '2027-03-31T12:00+23:59',
          '2027-03-31T12:00+24:00',
          '2027-03-31T12:00+23:60',
          '2027-03-31T12:00-99:00',
          '2027-02-30T12:00:00Z',
          '2027-04-31T23:59:59Z',
          '2028-02-29T23:59:59Z',
          '9999-12-31T23:59:59.999+00:00',
          '2027-03-31t12:00:00z',
        ]

        const answers = probe(corpus.map((input) => ({ op: 'parseExpiry', input })))

        corpus.forEach((input, index) => {
          let expected: unknown
          try {
            expected = { ok: true, value: parseExpiryDate(input) }
          } catch (error) {
            expect(error).toBeInstanceOf(LicenseError)
            expected = { ok: false, error: (error as LicenseError).message }
          }
          expect(answers[index], JSON.stringify(input)).toEqual(expected)
        })
      })

      it('groups rate-limit clients like rate-limit.ts', () => {
        const corpus = [
          '192.0.2.7',
          '::ffff:192.0.2.7',
          '::FFFF:192.0.2.7',
          '2001:db8:aa:bb:1:2:3:4',
          '2001:db8:aa:bb::9',
          '2001:0db8:00aa::',
          '::1',
          '::',
          '1::',
          'fe80::1%eth0',
          '2001:db8::1.2.3.4',
          '1:2:3:4:5:6:7:8',
          'unknown',
          '01.2.3.4',
          '1.2.3.256',
        ]
        const answers = probe(corpus.map((input) => ({ op: 'clientBucketId', input })))
        expect(answers).toEqual(corpus.map((input) => clientBucketId(input)))
      })

      it('says every customer sentence of messages.ts, with this deployment’s address', () => {
        const [answer] = probe([{ op: 'messages' }]) as [
          {
            static: Record<string, string>
            expired: string
            seatsExhausted: string[]
            selfReleaseLimit: string[]
            keyProblems: string[]
          },
        ]

        const camel = (name: string): string =>
          name.toLowerCase().replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
        const phpStatic = Object.fromEntries(
          Object.entries(answer.static).map(([name, value]) => [camel(name), value]),
        )
        const nodeStatic = Object.fromEntries(
          Object.entries(CustomerMessages)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([name, value]) => [name, deployed(value)]),
        )

        expect(phpStatic).toEqual(nodeStatic)
        expect(answer.expired).toBe(deployed(CustomerMessages.expired('12 December 2026')))
        expect(answer.seatsExhausted).toEqual([
          deployed(CustomerMessages.seatsExhausted(1)),
          deployed(CustomerMessages.seatsExhausted(3)),
        ])
        expect(answer.selfReleaseLimit).toEqual(
          [
            [1, 365],
            [2, 730],
            [3, 30],
            [4, 1],
          ].map(([moves, days]) =>
            deployed(CustomerMessages.selfReleaseLimit(moves ?? 0, days ?? 0)),
          ),
        )
        expect(answer.keyProblems).toEqual(
          (
            [null, 'empty', 'wrong-product', 'wrong-length', 'bad-character', 'checksum'] as const
          ).map((problem) => describeKeyProblem(problem)),
        )
        expect(answer.expired).toContain(WEBSITE)
        expect(answer.static.UNKNOWN_KEY).toContain(SUPPORT)
      })

      it('formats customer dates like Intl en-GB in UTC', () => {
        const instants = [
          Date.UTC(2026, 11, 12, 12),
          Date.UTC(2027, 0, 1),
          Date.UTC(2027, 0, 1) - 1,
          Date.UTC(2028, 1, 29, 23, 59, 59, 999),
          Date.UTC(2100, 5, 5),
        ]
        const answers = probe(instants.map((input) => ({ op: 'formatCustomerDate', input })))
        expect(answers).toEqual(instants.map((instant) => formatCustomerDate(instant)))
      })

      it('reads the signing-key PEM Node writes, and writes the same PEM back', () => {
        const keys = freshKeyPair()
        const [answer] = probe([{ op: 'keyFromPem', pem: keys.pem }])
        expect(answer).toEqual({
          publicKey: keys.publicKey,
          fingerprint: fingerprintOf(keys.publicKey),
          pem: keys.pem,
        })
      })

      it('prunes the event log at the same cutoff as retention.ts, and refuses the same retentions', () => {
        const now = Date.UTC(2026, 10, 12, 12)
        const cutoff = now - 395 * DAY
        const events = [cutoff - DAY, cutoff - 1, cutoff, cutoff + 1, now - 365 * DAY, now]
        const scenarios: RetentionCase[] = [
          { now, days: 395, windowDays: 365, events },
          { now, days: 365, windowDays: 365, events },
          { now: now + 7, days: 30, windowDays: 30, events },
          { now, days: 364, windowDays: 365, events },
          { now, days: 0, windowDays: 0, events: [] },
        ]

        const answers = probe(scenarios.map((scenario) => ({ op: 'retention', ...scenario })))
        scenarios.forEach((scenario, index) => {
          expect(answers[index], JSON.stringify(scenario)).toEqual(nodeRetention(scenario))
        })
        expect(answers[0]).toMatchObject({
          deleted: 2,
          remaining: [cutoff, cutoff + 1, now - 365 * DAY, now],
        })
      })
    })

    describe('over HTTP, with a key imported from npm run licensing:keys', () => {
      let harness: Harness
      const keys = freshKeyPair()

      beforeAll(async () => {
        harness = await startHarness({
          importPem: keys.pem,
          settings: { rate_limit_burst: 1000 },
        })
      }, HOOK_TIMEOUT)

      afterAll(async () => {
        await harness.stop()
      }, HOOK_TIMEOUT)

      it('serves the public key the build embeds', () => {
        expect(harness.publicKey).toBe(keys.publicKey)
      })

      it('reports health, for GET and HEAD, with the reference headers', async () => {
        const get = await request(harness, 'GET', '/healthz')
        expect(get.status).toBe(200)
        expect(get.body).toEqual({ ok: true })
        expect(get.headers.get('content-type')).toBe('application/json; charset=utf-8')
        expect(get.headers.get('cache-control')).toBe('no-store')
        expect(get.headers.get('x-content-type-options')).toBe('nosniff')
        expect(get.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)

        const head = await request(harness, 'HEAD', '/healthz')
        expect(head.status).toBe(200)
        expect(head.text).toBe('')
      })

      it('activates, deactivates, and moves the licence to another machine', async () => {
        const key = await mint(harness, { edition: 'professional', registeredTo: 'Jane Doe' })

        const first = await activate(harness, key, MACHINE_A)
        expect(first.status).toBe(200)
        expect(Object.keys(first.body)).toEqual(['token'])
        const verified = clientVerify(harness, first.body.token, MACHINE_A, key)
        expect(verified.ok && verified.claims).toMatchObject({
          v: 1,
          edition: 'professional',
          key,
          machine: MACHINE_A,
          expiresAt: null,
          registeredTo: 'Jane Doe',
        })

        const blocked = await activate(harness, key, MACHINE_B)
        expect(blocked.status).toBe(409)
        expect(blocked.body).toEqual({ error: deployed(CustomerMessages.seatsExhausted(1)) })

        const released = await deactivate(harness, first.body.token)
        expect(released).toMatchObject({ status: 200, body: { released: true } })

        const moved = await activate(harness, key, MACHINE_B)
        expect(moved.status).toBe(200)
        expect(clientVerify(harness, moved.body.token, MACHINE_B, key).ok).toBe(true)
        expect(clientVerify(harness, moved.body.token, MACHINE_A, key)).toEqual({
          ok: false,
          failure: 'wrong-machine',
        })

        const again = await deactivate(harness, first.body.token)
        expect(again).toMatchObject({ status: 200, body: { released: false } })
      })

      it('re-issues a token to a machine that already holds the seat', async () => {
        const key = await mint(harness, { edition: 'professional' })
        const typed = key.toLowerCase().replaceAll('-', '')
        const clientKey = validateKey(typed).key ?? ''

        const first = await activate(harness, clientKey, MACHINE_A)
        const second = await activate(harness, clientKey, MACHINE_A)
        expect([first.status, second.status]).toEqual([200, 200])
        expect(clientVerify(harness, second.body.token, MACHINE_A, clientKey).ok).toBe(true)
        expect((await show(harness, key)).activeSeats).toBe(1)
      })

      it('answers each refusal with its status and the reference sentence', async () => {
        const unknown = await activate(
          harness,
          generateKey(() => 9),
          MACHINE_A,
        )
        expect(unknown).toMatchObject({
          status: 404,
          body: { error: deployed(CustomerMessages.unknownKey) },
        })
        expect(Object.keys(unknown.body)).toEqual(['error'])

        const revokedKey = await mint(harness, { edition: 'professional' })
        await request(harness, 'POST', `/v1/admin/licenses/${revokedKey}/revoke`, {
          json: { reason: 'refund' },
          admin: true,
        })
        expect(await activate(harness, revokedKey, MACHINE_A)).toMatchObject({
          status: 403,
          body: { error: deployed(CustomerMessages.revoked) },
        })

        // The PHP server keeps real time, so the term is ended in the database.
        const termKey = await mint(harness, { edition: 'professional', days: 30 })
        const ended = Date.now() - DAY
        harness.db((db) =>
          db.prepare('UPDATE licenses SET expires_at = ? WHERE key = ?').run(ended, termKey),
        )
        expect(await activate(harness, termKey, MACHINE_A)).toMatchObject({
          status: 403,
          body: { error: deployed(CustomerMessages.expired(formatCustomerDate(ended))) },
        })

        expect(
          await activate(harness, `${KEY_PREFIX}-AAAAA-AAAAA-AAAAA-AAAAB`, MACHINE_A),
        ).toMatchObject({
          status: 400,
          body: { error: CustomerMessages.keyChecksum },
        })
        expect(await activate(harness, 'ABCD-12345', MACHINE_A)).toMatchObject({
          status: 400,
          body: { error: CustomerMessages.keyWrongProduct },
        })
        expect(await activate(harness, revokedKey, 'not-a-machine')).toMatchObject({
          status: 400,
          body: { error: CustomerMessages.invalidMachine },
        })

        const product = await request(harness, 'POST', '/v1/activate', {
          json: { key: revokedKey, machineId: MACHINE_A, product: 'something-else' },
        })
        expect(product).toMatchObject({
          status: 400,
          body: { error: CustomerMessages.wrongProduct },
        })

        const incomplete = await request(harness, 'POST', '/v1/activate', { json: { key: 'x' } })
        expect(incomplete).toMatchObject({
          status: 400,
          body: { error: CustomerMessages.incompleteRequest },
        })

        const unreadable = await request(harness, 'POST', '/v1/activate', {
          body: '{"key": ',
          headers: { 'content-type': 'application/json' },
        })
        expect(unreadable).toMatchObject({
          status: 400,
          body: { error: CustomerMessages.unreadableRequest },
        })

        expect(await deactivate(harness, 'not-a-token')).toMatchObject({
          status: 400,
          body: { error: CustomerMessages.tokenUnreadable },
        })

        const claims = {
          v: 1,
          edition: 'professional',
          key: revokedKey,
          machine: MACHINE_A,
          issuedAt: Date.now(),
          expiresAt: null,
          registeredTo: null,
        }
        expect(await deactivate(harness, signToken(freshKeyPair(), claims))).toMatchObject({
          status: 403,
          body: { error: CustomerMessages.tokenForged },
        })

        const orphan = signToken(keys, { ...claims, key: generateKey(() => 3) })
        expect(await deactivate(harness, orphan)).toMatchObject({
          status: 404,
          body: { error: deployed(CustomerMessages.tokenLicenceMissing) },
        })
      })

      it('releases the seat named in a token signed the documented way, outside the server', async () => {
        const key = await mint(harness, { edition: 'professional' })
        expect((await activate(harness, key, MACHINE_A)).status).toBe(200)

        const token = signToken(keys, {
          v: 1,
          edition: 'professional',
          key,
          machine: MACHINE_A,
          issuedAt: Date.now(),
          expiresAt: null,
          registeredTo: null,
        })
        expect(await deactivate(harness, token)).toMatchObject({
          status: 200,
          body: { released: true },
        })
      })

      it('refuses the wrong content type, an oversized body, the wrong method and unknown paths', async () => {
        const wrongType = await request(harness, 'POST', '/v1/activate', {
          body: `key=${KEY_PREFIX}`,
          headers: { 'content-type': 'text/plain' },
        })
        expect(wrongType).toMatchObject({
          status: 415,
          body: { error: CustomerMessages.wrongContentType },
        })

        const withCharset = await request(harness, 'POST', '/v1/activate', {
          json: { key: 'x' },
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
        expect(withCharset.status).toBe(400)

        const tooLarge = await request(harness, 'POST', '/v1/activate', {
          json: { key: 'x'.repeat(16 * 1024), machineId: MACHINE_A, product: PRODUCT_ID },
        })
        expect(tooLarge).toMatchObject({
          status: 413,
          body: { error: CustomerMessages.bodyTooLarge },
        })

        const wrongMethod = await request(harness, 'GET', '/v1/activate')
        expect(wrongMethod).toMatchObject({
          status: 405,
          body: { error: CustomerMessages.methodNotAllowed },
        })
        expect(wrongMethod.headers.get('allow')).toBe('POST')
        expect((await request(harness, 'POST', '/healthz')).headers.get('allow')).toBe('GET, HEAD')

        const missing = await request(harness, 'GET', '/v1/nothing-here')
        expect(missing).toMatchObject({ status: 404, body: { error: CustomerMessages.notFound } })
      })

      // `php -S` answers one request at a time, so these six queue rather than
      // race: this checks the seat count across requests. Two connections
      // overlapping inside the count-then-claim transaction, as PHP-FPM can
      // make them, are tested in server-php/tests/unit/AuthorityTest.php
      // ("two requests at once").
      it('never lets queued requests share the last seats', async () => {
        const key = await mint(harness, { edition: 'business' })
        const machines = [
          MACHINE_A,
          MACHINE_B,
          MACHINE_C,
          MACHINE_D,
          'MNOP-QRST-VWXY-Z012-3456-789A',
          'BBBB-CCCC-DDDD-EEEE-FFFF-GGGG',
        ]

        const results = await Promise.all(
          machines.map((machine) => activate(harness, key, machine)),
        )
        expect(results.map((result) => result.status).sort()).toEqual([
          200, 200, 200, 409, 409, 409,
        ])
      })

      it('mints idempotently per order, validates admin input, and requires the bearer token', async () => {
        const missing = await request(harness, 'GET', '/v1/admin/licenses')
        expect(missing.status).toBe(401)
        expect(missing.body).toEqual({ error: CustomerMessages.unauthorized })
        expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/u)

        const wrong = await request(harness, 'GET', '/v1/admin/licenses', {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}x` },
        })
        expect(wrong.status).toBe(401)
        const basic = await request(harness, 'GET', '/v1/admin/licenses', {
          headers: {
            authorization: `Basic ${Buffer.from(`admin:${ADMIN_TOKEN}`).toString('base64')}`,
          },
        })
        expect(basic.status).toBe(401)

        const json = {
          edition: 'business',
          count: 2,
          days: 365,
          registeredTo: 'Contoso Ltd',
          email: 'it@contoso.example',
          orderRef: 'razorpay:pay_test_123',
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
        for (const key of keysOf(created.body)) {
          expect(validateKey(key)).toEqual({ ok: true, key, problem: null })
        }

        const first = (created.body.licenses as Array<Record<string, unknown>>)[0]
        expect(Object.keys(first ?? {})).toEqual([
          'key',
          'edition',
          'registeredTo',
          'email',
          'maxActivations',
          'expiresAt',
          'createdAt',
          'revokedAt',
          'revokeReason',
          'orderRef',
          'notes',
        ])
        expect(first).toMatchObject({ maxActivations: 3, registeredTo: 'Contoso Ltd' })
        expect(first?.expiresAt).toBe((first?.createdAt as number) + 365 * DAY)

        const listed = await request(
          harness,
          'GET',
          '/v1/admin/licenses?orderRef=razorpay%3Apay_test_123',
          { admin: true },
        )
        expect((listed.body.licenses as unknown[]).length).toBe(2)

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
        expect(typo.body.error).toBe(
          'The request body is invalid: <root>: Unrecognized key: "registered_to"',
        )

        const badQuery = await request(harness, 'GET', '/v1/admin/licenses?limit=zero', {
          admin: true,
        })
        expect(badQuery.status).toBe(400)

        const notFound = await request(
          harness,
          'GET',
          `/v1/admin/licenses/${generateKey(() => 4)}`,
          { admin: true },
        )
        expect(notFound.status).toBe(404)
      })

      it('shows, revokes, restores, extends, releases, resets and issues offline activations', async () => {
        const key = await mint(harness, { edition: 'business', days: 30, orderRef: 'INV-77' })
        await activate(harness, key, MACHINE_A)
        await activate(harness, key, MACHINE_B)

        const shown = await show(harness, key)
        expect(Object.keys(shown)).toEqual([
          'license',
          'standing',
          'activeSeats',
          'selfReleases',
          'activations',
          'events',
        ])
        expect(shown).toMatchObject({
          standing: 'active',
          activeSeats: 2,
          selfReleases: { recent: 0, limit: 4, windowDays: 365 },
        })
        const before = shown.license as { expiresAt: number }

        const revoked = await request(harness, 'POST', `/v1/admin/licenses/${key}/revoke`, {
          admin: true,
        })
        expect(typeof (revoked.body.license as { revokedAt: unknown }).revokedAt).toBe('number')

        const restored = await request(harness, 'POST', `/v1/admin/licenses/${key}/restore`, {
          admin: true,
        })
        expect(restored.body).toMatchObject({ license: { revokedAt: null } })

        const extended = await request(harness, 'POST', `/v1/admin/licenses/${key}/extend`, {
          json: { days: 365 },
          admin: true,
        })
        expect(extended.body).toMatchObject({
          license: { expiresAt: before.expiresAt + 365 * DAY },
        })

        const release = await request(harness, 'POST', `/v1/admin/licenses/${key}/release`, {
          json: { machineId: MACHINE_A },
          admin: true,
        })
        expect(release.body).toEqual({ released: true })

        const reset = await request(harness, 'POST', `/v1/admin/licenses/${key}/reset`, {
          admin: true,
        })
        expect(reset.body).toEqual({ released: 1 })

        const offline = await request(harness, 'POST', `/v1/admin/licenses/${key}/offline`, {
          json: { machineId: MACHINE_C.toLowerCase() },
          admin: true,
        })
        expect(offline.status).toBe(200)
        expect(clientVerify(harness, offline.body.token, MACHINE_C, key).ok).toBe(true)
        expect(offline.body.claims).toMatchObject({ machine: MACHINE_C, key, edition: 'business' })
      })

      it('re-issues the same machine a token with the extended end date', async () => {
        const key = await mint(harness, { edition: 'business', days: 30, registeredTo: 'Contoso' })
        const before = await activate(harness, key, MACHINE_A)
        const ends = (await licenseOf(harness, key)).expiresAt as number

        const extended = await request(harness, 'POST', `/v1/admin/licenses/${key}/extend`, {
          json: { days: 365 },
          admin: true,
        })
        expect(extended.status).toBe(200)

        const after = await activate(harness, key, MACHINE_A)
        expect(after.status).toBe(200)

        const later = ends + DAY
        expect(clientVerify(harness, before.body.token, MACHINE_A, key, later)).toEqual({
          ok: false,
          failure: 'expired',
        })
        const renewed = clientVerify(harness, after.body.token, MACHINE_A, key, later)
        expect(renewed.ok && renewed.claims).toMatchObject({
          edition: 'business',
          expiresAt: ends + 365 * DAY,
          registeredTo: 'Contoso',
        })
        expect((await show(harness, key)).activeSeats).toBe(1)
      })

      it('never writes a full licence key, a token or the admin token to the log', async () => {
        const key = await mint(harness, { edition: 'professional' })
        const { body } = await activate(harness, key, MACHINE_A)
        await request(harness, 'GET', `/v1/admin/licenses/${key}`, { admin: true })
        await deactivate(harness, body.token)

        const log = harness.logs()
        expect(log).toContain('"route":"activate"')
        expect(log).toContain(key.slice(-5))
        expect(log).not.toContain(key)
        expect(log).not.toContain(body.token as string)
        expect(log).not.toContain(ADMIN_TOKEN)
        for (const line of log.trim().split('\n')) {
          expect(() => JSON.parse(line) as unknown).not.toThrow()
        }
      })

      it('keeps /setup/ locked once the server is set up', async () => {
        const setup = await request(harness, 'GET', '/setup/')
        expect(setup.status).toBe(404)
        expect(setup.text).toContain('Already set up')
      })

      it('deletes history older than 395 days after the first request of a day, and only then', async () => {
        const now = Date.now()
        const old = now - 396 * DAY
        const recent = now - 394 * DAY
        insertEvent(harness, old)
        insertEvent(harness, recent)
        // The other rows named after an address: a rate-limit bucket long since
        // refilled, and a failed admin sign-in from two days ago.
        harness.db((db) => {
          db.prepare(
            "INSERT INTO rate_limits (id, tokens, updated_at) VALUES ('public|192.0.2.77', 0, ?)",
          ).run(now - 3_600_000)
          db.prepare("INSERT INTO login_attempts (client, at) VALUES ('192.0.2.78', ?)").run(
            now - 2 * DAY,
          )
        })
        const addressRows = (): number =>
          harness.db((db) =>
            Number(
              db
                .prepare(
                  "SELECT (SELECT COUNT(*) FROM rate_limits WHERE id = 'public|192.0.2.77') + (SELECT COUNT(*) FROM login_attempts WHERE client = '192.0.2.78') AS n",
                )
                .get()?.n,
            ),
          )
        const left = (): number[] =>
          harness.db((db) =>
            db
              .prepare('SELECT at FROM events WHERE at IN (?, ?) ORDER BY at')
              .all(old, recent)
              .map((row) => Number(row.at)),
          )

        // php -S serves one request at a time, so a second request starts
        // only after the first has finished the work it does once answered.
        const settle = async (): Promise<void> => {
          expect((await request(harness, 'GET', '/healthz')).status).toBe(200)
          expect((await request(harness, 'GET', '/healthz')).status).toBe(200)
        }

        // The harness's own first request made today's pass.
        await settle()
        expect(left()).toEqual([old, recent])
        expect(addressRows()).toBe(2)

        // Moving the last pass back a day stands in for waiting one.
        harness.db((db) =>
          db
            .prepare(
              "UPDATE housekeeping SET last_run_at = last_run_at - ? WHERE task = 'prune-events'",
            )
            .run(DAY),
        )
        await settle()
        expect(left()).toEqual([recent])
        expect(addressRows()).toBe(0)
        expect(harness.logs()).toMatch(
          /"msg":"Pruned the event log","via":"daily","deleted":1,"retentionDays":395,"cutoff":"[0-9T:.-]+Z","logFiles":0,"rateLimits":\d+,"loginAttempts":1/u,
        )
      })

      describe('admin panel', () => {
        const jar = new Map<string, string>()

        async function browse(
          method: 'GET' | 'POST',
          path: string,
          form?: Record<string, string>,
        ): Promise<Reply> {
          const headers: Record<string, string> = {}
          if (jar.size > 0) {
            headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
          }
          const options: RequestOptions =
            form === undefined
              ? { headers }
              : {
                  headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams(form).toString(),
                }
          const reply = await request(harness, method, path, options)
          for (const cookie of reply.headers.getSetCookie()) {
            const [pair] = cookie.split(';')
            const [name, ...value] = (pair ?? '').split('=')
            if (name !== undefined) jar.set(name.trim(), value.join('='))
          }
          return reply
        }

        function csrfOf(reply: Reply): string {
          const match = /name="csrf" value="([0-9a-f]{64})"/u.exec(reply.text)
          expect(match).not.toBeNull()
          return match?.[1] ?? ''
        }

        it('signs in with a fresh session, refuses forms without the CSRF token, creates and revokes', async () => {
          const login = await browse('GET', '/admin/')
          expect(login.status).toBe(200)
          expect(login.text).toContain('Sign in')
          const cookie = login.headers.getSetCookie().find((line) => line.startsWith('RXLICADMIN='))
          expect(cookie).toMatch(/; path=\/admin\/; HttpOnly; SameSite=Strict/iu)
          expect(login.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
          expect(login.headers.get('x-frame-options')).toBe('DENY')
          const anonymous = jar.get('RXLICADMIN')

          const forged = await browse('POST', '/admin/', {
            action: 'login',
            password: ADMIN_PASSWORD,
          })
          expect(forged.status).toBe(403)

          const wrong = await browse('POST', '/admin/', {
            action: 'login',
            csrf: csrfOf(forged),
            password: 'not the password',
          })
          expect(wrong.status).toBe(401)

          const signedIn = await browse('POST', '/admin/', {
            action: 'login',
            csrf: csrfOf(wrong),
            password: ADMIN_PASSWORD,
          })
          expect(signedIn.status).toBe(303)
          expect(jar.get('RXLICADMIN')).not.toBe(anonymous)

          const dashboard = await browse('GET', '/admin/')
          expect(dashboard.status).toBe(200)
          expect(dashboard.text).toContain('<h1>Dashboard</h1>')
          const csrf = csrfOf(dashboard)

          const countBefore = (
            (await request(harness, 'GET', '/v1/admin/licenses?limit=1000', { admin: true })).body
              .licenses as unknown[]
          ).length
          const unprotected = await browse('POST', '/admin/', {
            action: 'create',
            edition: 'business',
            term: 'days',
            days: '365',
          })
          expect(unprotected.status).toBe(403)
          const countAfter = (
            (await request(harness, 'GET', '/v1/admin/licenses?limit=1000', { admin: true })).body
              .licenses as unknown[]
          ).length
          expect(countAfter).toBe(countBefore)

          const created = await browse('POST', '/admin/', {
            action: 'create',
            csrf,
            edition: 'business',
            registeredTo: '<script>alert(1)</script> Ltd',
            email: 'buyer@example.com',
            seats: '',
            term: 'days',
            days: '365',
            count: '1',
            orderRef: 'panel-order-1',
            notes: '',
          })
          expect(created.status).toBe(303)
          expect(created.headers.get('location')).toBe('?page=created')

          const shownOnce = await browse('GET', '/admin/?page=created')
          expect(shownOnce.status).toBe(200)
          const key =
            new RegExp(`${KEY_PREFIX}(?:-[0-9A-Z]{5}){4}`, 'u').exec(shownOnce.text)?.[0] ?? ''
          expect(validateKey(key)).toEqual({ ok: true, key, problem: null })
          expect((await browse('GET', '/admin/?page=created')).status).toBe(303)

          const licence = await licenseOf(harness, key)
          expect(licence).toMatchObject({
            edition: 'business',
            registeredTo: '<script>alert(1)</script> Ltd',
            email: 'buyer@example.com',
            maxActivations: 3,
            orderRef: 'panel-order-1',
          })
          expect(licence.expiresAt).toBe((licence.createdAt as number) + 365 * DAY)

          const page = await browse('GET', `/admin/?page=licence&key=${key}`)
          expect(page.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Ltd')
          expect(page.text).not.toContain('<script>alert(1)')

          const activated = await activate(harness, key, MACHINE_D)
          expect(clientVerify(harness, activated.body.token, MACHINE_D, key).ok).toBe(true)

          const revoked = await browse('POST', '/admin/', {
            action: 'revoke',
            csrf,
            key,
            reason: 'refund via panel',
          })
          expect(revoked.status).toBe(303)
          expect(await licenseOf(harness, key)).toMatchObject({ revokeReason: 'refund via panel' })
          expect((await activate(harness, key, MACHINE_D)).status).toBe(403)

          const out = await browse('POST', '/admin/', { action: 'logout', csrf })
          expect(out.status).toBe(303)
          jar.clear()
          expect((await browse('GET', '/admin/')).text).toContain('Sign in')
        })

        it('deletes old history from the Backup page, only with the CSRF token', async () => {
          const login = await browse('GET', '/admin/')
          const signedIn = await browse('POST', '/admin/', {
            action: 'login',
            csrf: csrfOf(login),
            password: ADMIN_PASSWORD,
          })
          expect(signedIn.status).toBe(303)

          insertEvent(harness, Date.now() - 400 * DAY)
          const past = (): number =>
            harness.db((db) =>
              Number(
                db
                  .prepare('SELECT COUNT(*) AS n FROM events WHERE at < ?')
                  .get(Date.now() - 395 * DAY)?.n,
              ),
            )
          expect(past()).toBe(1)

          const backup = await browse('GET', '/admin/?page=backup')
          expect(backup.text).toContain('<h2>Activation history</h2>')
          expect(backup.text).toContain(
            '<dt>Older than 395 days now</dt><dd>1 event (recorded before ',
          )

          const forged = await browse('POST', '/admin/', { action: 'prune-events' })
          expect(forged.status).toBe(403)
          expect(past()).toBe(1)

          const pruned = await browse('POST', '/admin/', {
            action: 'prune-events',
            csrf: csrfOf(backup),
          })
          expect(pruned.status).toBe(303)
          expect(pruned.headers.get('location')).toBe('?page=backup')
          expect(past()).toBe(0)

          const after = await browse('GET', '/admin/?page=backup')
          expect(after.text).toMatch(/1 event recorded before \d{4}-\d{2}-\d{2} deleted\./u)
          expect(after.text).toContain('<dt>Older than 395 days now</dt><dd>0 events')
          expect(harness.logs()).toContain('"msg":"Pruned the event log","via":"admin","deleted":1')
        })

        it('corrects and erases a customer’s personal details, as the privacy policy promises', async () => {
          const login = await browse('GET', '/admin/')
          expect(
            (
              await browse('POST', '/admin/', {
                action: 'login',
                csrf: csrfOf(login),
                password: ADMIN_PASSWORD,
              })
            ).status,
          ).toBe(303)

          const key = await mint(harness, {
            edition: 'business',
            registeredTo: 'Jane Dough',
            email: 'jane@example.com',
            notes: 'asked for an invoice',
            orderRef: 'panel-privacy-1',
          })
          expect((await activate(harness, key, MACHINE_A)).status).toBe(200)

          const page = await browse('GET', `/admin/?page=licence&key=${key}`)
          expect(page.text).toContain('<h2>Personal details</h2>')
          const csrf = csrfOf(page)

          const corrected = await browse('POST', '/admin/', {
            action: 'details',
            csrf,
            key,
            registeredTo: 'Jane Doe',
            email: 'jane.doe@example.com',
            notes: '',
          })
          expect(corrected.status).toBe(303)
          expect(await licenseOf(harness, key)).toMatchObject({
            registeredTo: 'Jane Doe',
            email: 'jane.doe@example.com',
            notes: null,
          })
          const token = (await activate(harness, key, MACHINE_A)).body.token
          expect(clientVerify(harness, token, MACHINE_A, key)).toMatchObject({ ok: true })
          expect(
            JSON.parse(
              Buffer.from(String(token).split('.')[0] ?? '', 'base64url').toString('utf8'),
            ),
          ).toMatchObject({ registeredTo: 'Jane Doe' })

          const refused = await browse('POST', '/admin/', {
            action: 'details',
            csrf,
            key,
            registeredTo: 'Jane Doe',
            email: 'not an address',
            notes: '',
          })
          expect(refused.status).toBe(303)
          expect((await browse('GET', `/admin/?page=licence&key=${key}`)).text).toContain(
            'Invalid email address',
          )
          expect((await licenseOf(harness, key)).email).toBe('jane.doe@example.com')

          const forged = await browse('POST', '/admin/', { action: 'erase', key })
          expect(forged.status).toBe(403)
          expect((await licenseOf(harness, key)).email).toBe('jane.doe@example.com')

          const erased = await browse('POST', '/admin/', { action: 'erase', csrf, key })
          expect(erased.status).toBe(303)
          const shown = await show(harness, key)
          expect(shown.license).toMatchObject({
            registeredTo: null,
            email: null,
            notes: null,
            orderRef: 'panel-privacy-1',
          })
          const events = shown.events as Array<{ ip: string | null }>
          expect(events.length).toBeGreaterThan(2)
          expect(events.filter((event) => event.ip !== null)).toEqual([])
          expect(shown.activeSeats).toBe(1)
          expect((await browse('GET', `/admin/?page=licence&key=${key}`)).text).toMatch(
            /Personal details erased: the name, e-mail and notes, and \d+ recorded addresses\./u,
          )

          const logs = harness.logs()
          expect(logs).toContain('"msg":"Licence details corrected"')
          expect(logs).toContain('"msg":"Personal details erased"')
          expect(logs).not.toContain('Jane Doe')
          expect(logs).not.toContain(key)
        })

        it('stores website orders for the Orders page, follows them up, creates their licences and deletes them', async () => {
          interface OrderRow {
            id: number
            ref: string
            status: string
            name: string
            phone: string
            phone_country: string
            notes: string | null
            mailed_at: number | null
          }
          const orders = (): OrderRow[] =>
            harness.db(
              (db) => db.prepare('SELECT * FROM orders ORDER BY id').all() as unknown as OrderRow[],
            )
          const order = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
            request(harness, 'POST', '/order/', {
              headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams(fields).toString(),
            })
          const fields = {
            edition: 'technician',
            quantity: '3',
            name: '<b>Jane</b> & Co',
            email: 'jane.order@example.com',
            phoneCountry: 'IN',
            phone: '98765 43210',
            registerTo: '',
            gstin: '',
            message: 'Line one\n<script>alert(2)</script>',
            nectar: '',
          }

          // A post from another site's page, and one without the mobile number, store nothing.
          const foreign = await order(fields, { origin: 'https://evil.example' })
          expect(foreign.status).toBe(303)
          expect(foreign.headers.get('location')).toBe('/buy/error/')
          const noMobile = await order({ ...fields, phone: '' })
          expect(noMobile.headers.get('location')).toBe('/buy/error/')
          expect(orders()).toEqual([])

          // E-mail is off in this harness: the order is stored, and that counts as sent.
          const sent = await order(fields)
          expect(sent.status).toBe(303)
          expect(sent.headers.get('location')).toBe('/buy/sent/')
          const [stored] = orders()
          expect(stored).toMatchObject({
            status: 'new',
            name: '<b>Jane</b> & Co',
            phone: '+91 9876543210',
            phone_country: 'IN',
            mailed_at: null,
          })
          const ref = stored?.ref ?? ''
          const id = stored?.id ?? 0
          expect(ref).toMatch(/^RX-[0-9A-F]{8}$/u)

          const login = await browse('GET', '/admin/')
          expect(
            (
              await browse('POST', '/admin/', {
                action: 'login',
                csrf: csrfOf(login),
                password: ADMIN_PASSWORD,
              })
            ).status,
          ).toBe(303)

          const dashboard = await browse('GET', '/admin/')
          expect(dashboard.text).toContain('Orders (1)</a>')
          expect(dashboard.text).toContain('<strong>1 new order</strong>')

          const list = await browse('GET', '/admin/?page=orders')
          expect(list.status).toBe(200)
          expect(list.text).toContain(`<a href="?page=order&amp;id=${id}">${ref}</a>`)
          expect(list.text).toContain('&lt;b&gt;Jane&lt;/b&gt; &amp; Co')
          expect(list.text).not.toContain('<b>Jane</b>')
          expect(list.text).toContain('+91 9876543210')
          expect((await browse('GET', '/admin/?page=orders&q=jane.order')).text).toContain(ref)
          expect((await browse('GET', '/admin/?page=orders&q=98765+43210')).text).toContain(ref)
          expect((await browse('GET', '/admin/?page=orders&status=paid')).text).not.toContain(ref)

          const page = await browse('GET', `/admin/?page=order&id=${id}`)
          expect(page.status).toBe(200)
          expect(page.text).toContain(`<h1>Order ${ref}</h1>`)
          expect(page.text).toContain('&lt;b&gt;Jane&lt;/b&gt; &amp; Co')
          expect(page.text).toContain('Line one<br />\n&lt;script&gt;alert(2)&lt;/script&gt;')
          expect(page.text).not.toContain('<script>alert(2)')
          expect(page.text).toContain('href="tel:+919876543210"')
          expect(page.text).toContain('href="mailto:jane.order@example.com"')
          expect(page.text).toContain('not e-mailed')
          expect(page.text).toContain(`href="?page=create&amp;order=${id}"`)
          const csrf = csrfOf(page)

          const forged = await browse('POST', '/admin/', {
            action: 'order-update',
            id: String(id),
            status: 'paid',
            notes: '',
          })
          expect(forged.status).toBe(403)
          expect(orders()[0]?.status).toBe('new')

          const updated = await browse('POST', '/admin/', {
            action: 'order-update',
            csrf,
            id: String(id),
            status: 'contacted',
            notes: 'Called <them> back',
          })
          expect(updated.status).toBe(303)
          expect(updated.headers.get('location')).toBe(`?page=order&id=${id}`)
          expect(orders()[0]).toMatchObject({ status: 'contacted', notes: 'Called <them> back' })
          const afterUpdate = await browse('GET', `/admin/?page=order&id=${id}`)
          expect(afterUpdate.text).toContain(`Saved: ${ref} is now “Contacted”.`)
          expect(afterUpdate.text).toContain('Called &lt;them&gt; back')
          expect(afterUpdate.text).not.toContain('Called <them>')

          const badStatus = await browse('POST', '/admin/', {
            action: 'order-update',
            csrf,
            id: String(id),
            status: 'shipped',
            notes: '',
          })
          expect(badStatus.status).toBe(303)
          expect(orders()[0]?.status).toBe('contacted')
          expect((await browse('GET', `/admin/?page=order&id=${id}`)).text).toContain(
            'Choose one of the listed statuses.',
          )

          // "Create licence for this order" fills in the create form.
          const prefilled = await browse('GET', `/admin/?page=create&order=${id}`)
          expect(prefilled.status).toBe(200)
          expect(prefilled.text).toContain('<option value="technician" selected>')
          expect(prefilled.text).toContain(
            'name="registeredTo" maxlength="200" value="&lt;b&gt;Jane&lt;/b&gt; &amp; Co"',
          )
          expect(prefilled.text).toContain('value="jane.order@example.com"')
          expect(prefilled.text).toContain('name="count" inputmode="numeric" value="3"')
          expect(prefilled.text).toContain(`name="orderRef" maxlength="200" value="${ref}"`)
          expect(prefilled.text).toContain(`Website order ${ref}</textarea>`)

          const created = await browse('POST', '/admin/', {
            action: 'create',
            csrf,
            edition: 'technician',
            registeredTo: '<b>Jane</b> & Co',
            email: 'jane.order@example.com',
            seats: '',
            term: 'days',
            days: '365',
            count: '3',
            orderRef: ref,
            notes: `Website order ${ref}; mobile +91 9876543210`,
          })
          expect(created.status).toBe(303)
          expect(created.headers.get('location')).toBe('?page=created')
          const keys =
            (await browse('GET', '/admin/?page=created')).text.match(
              new RegExp(`${KEY_PREFIX}(?:-[0-9A-Z]{5}){4}`, 'gu'),
            ) ?? []
          expect(new Set(keys).size).toBe(3)
          expect(orders()[0]?.status).toBe('licensed')
          const licensed = await browse('GET', `/admin/?page=order&id=${id}`)
          expect(licensed.text).toContain('Licence sent')
          for (const key of keys) expect(licensed.text).toContain(key)

          // Deleting needs the box ticked; the licences stay.
          const unticked = await browse('POST', '/admin/', {
            action: 'order-delete',
            csrf,
            id: String(id),
          })
          expect(unticked.status).toBe(303)
          expect(unticked.headers.get('location')).toBe(`?page=order&id=${id}`)
          expect(orders()).toHaveLength(1)
          expect((await browse('GET', `/admin/?page=order&id=${id}`)).text).toContain(
            'Nothing was deleted.',
          )

          const deleted = await browse('POST', '/admin/', {
            action: 'order-delete',
            csrf,
            id: String(id),
            confirm: '1',
          })
          expect(deleted.status).toBe(303)
          expect(deleted.headers.get('location')).toBe('?page=orders')
          expect(orders()).toEqual([])
          expect((await browse('GET', '/admin/?page=orders')).text).toContain(
            `Order ${ref} deleted.`,
          )
          const gone = await browse('GET', `/admin/?page=order&id=${id}`)
          expect(gone.status).toBe(404)
          expect(gone.text).toContain('<a href="?page=orders">Back to the orders</a>')
          expect(
            (await request(harness, 'GET', `/v1/admin/licenses?orderRef=${ref}`, { admin: true }))
              .body.licenses,
          ).toHaveLength(3)

          const logs = harness.logs()
          expect(logs).toContain('"msg":"Order stored but not e-mailed')
          expect(logs).toContain(`"msg":"Order deleted","ref":"${ref}"`)
          expect(logs).not.toContain('jane.order@example.com')
          expect(logs).not.toContain('9876543210')
          expect(logs).not.toContain('Jane</b>')
        })
      })
    })

    describe('self-service release cap, with a key generated on the PHP server', () => {
      let harness: Harness

      beforeAll(async () => {
        harness = await startHarness({
          settings: { self_release_limit: 2, rate_limit_burst: 1000 },
        })
      }, HOOK_TIMEOUT)

      afterAll(async () => {
        await harness.stop()
      }, HOOK_TIMEOUT)

      async function tokenFor(key: string, machineId: string): Promise<string> {
        const response = await activate(harness, key, machineId)
        expect(response.status).toBe(200)
        expect(clientVerify(harness, response.body.token, machineId, key).ok).toBe(true)
        return response.body.token as string
      }

      it('writes a signing key Node can load, matching the public key it reports', () => {
        const pem = readFileSync(join(harness.dataDir, 'signing.key'), 'utf8')
        const spki = createPublicKey(createPrivateKey(pem))
          .export({ format: 'der', type: 'spki' })
          .toString('base64')
        expect(spki).toBe(harness.publicKey)
      })

      it('answers 409 with the customer sentence and keeps the seat', async () => {
        const key = await mint(harness, { edition: 'professional' })

        for (let move = 0; move < 2; move += 1) {
          const released = await deactivate(harness, await tokenFor(key, MACHINE_A))
          expect(released).toMatchObject({ status: 200, body: { released: true } })
        }

        const held = await tokenFor(key, MACHINE_A)
        const refused = await deactivate(harness, held)
        expect(refused.status).toBe(409)
        expect(refused.body).toEqual({
          error:
            'This licence has already been moved between computers twice in the last 12 months. ' +
            'It is still active on this computer. To move it again, contact info@appsgain.in with your licence key.',
        })
        expect(refused.body.error).toBe(deployed(CustomerMessages.selfReleaseLimit(2, 365)))

        // Asking again gets the same answer: the seat is still held.
        expect((await deactivate(harness, held)).status).toBe(409)

        expect(await show(harness, key)).toMatchObject({
          activeSeats: 1,
          selfReleases: { recent: 2, limit: 2, windowDays: 365 },
        })
        expect((await activate(harness, key, MACHINE_B)).status).toBe(409)

        const line = harness
          .logs()
          .split('\n')
          .find((entry) => entry.includes('"route":"deactivate"') && entry.includes('"status":409'))
        expect(line).toContain('"refusal":"self-release-limit"')
        expect(line).toContain(`"machine":"${MACHINE_A}"`)
        expect(line).not.toContain(key)
      })

      it('lets the admin API release and reset past it, without counting either', async () => {
        const key = await mint(harness, { edition: 'business' })
        await deactivate(harness, await tokenFor(key, MACHINE_A))
        await deactivate(harness, await tokenFor(key, MACHINE_A))
        const held = await tokenFor(key, MACHINE_A)
        expect((await deactivate(harness, held)).status).toBe(409)

        const release = await request(harness, 'POST', `/v1/admin/licenses/${key}/release`, {
          json: { machineId: MACHINE_A },
          admin: true,
        })
        expect(release.body).toEqual({ released: true })
        expect(await deactivate(harness, held)).toMatchObject({
          status: 200,
          body: { released: false },
        })

        await tokenFor(key, MACHINE_B)
        await tokenFor(key, MACHINE_C)
        const reset = await request(harness, 'POST', `/v1/admin/licenses/${key}/reset`, {
          admin: true,
        })
        expect(reset.body).toEqual({ released: 2 })

        expect(await show(harness, key)).toMatchObject({
          activeSeats: 0,
          selfReleases: { recent: 2, limit: 2 },
        })
      })

      it('never limits a licence with unlimited seats, but counts its moves', async () => {
        const technician = await mint(harness, { edition: 'technician' })
        const unlimited = await mint(harness, { edition: 'professional', seats: null })

        for (const key of [technician, unlimited]) {
          for (let move = 0; move < 3; move += 1) {
            const released = await deactivate(harness, await tokenFor(key, MACHINE_A))
            expect(released).toMatchObject({ status: 200, body: { released: true } })
          }
          expect((await show(harness, key)).selfReleases).toEqual({
            recent: 3,
            limit: null,
            windowDays: 365,
          })
        }
      })
    })

    describe('with self-service release switched off (limit 0)', () => {
      let harness: Harness

      beforeAll(async () => {
        harness = await startHarness({ settings: { self_release_limit: 0 } })
      }, HOOK_TIMEOUT)

      afterAll(async () => {
        await harness.stop()
      }, HOOK_TIMEOUT)

      it('refuses from the first release, except for unlimited seats', async () => {
        const key = await mint(harness, { edition: 'professional' })
        const first = await activate(harness, key, MACHINE_A)
        const refused = await deactivate(harness, first.body.token)
        expect(refused).toMatchObject({
          status: 409,
          body: { error: deployed(CustomerMessages.selfReleaseDisabled) },
        })

        const enterprise = await mint(harness, { edition: 'enterprise' })
        const token = (await activate(harness, enterprise, MACHINE_A)).body.token
        expect(await deactivate(harness, token)).toMatchObject({
          status: 200,
          body: { released: true },
        })
        expect((await show(harness, enterprise)).selfReleases).toEqual({
          recent: 1,
          limit: null,
          windowDays: 365,
        })
      })
    })

    describe('admin token characters', () => {
      it(
        'authenticates every token the reference accepts, punctuation included',
        async () => {
          const token = `${'Z'.repeat(16)}!#$%&'*+-./~^_|=0`
          const harness = await startHarness({ apiToken: token })
          try {
            const response = await request(harness, 'GET', '/v1/admin/licenses', {
              headers: { authorization: `Bearer ${token}` },
            })
            expect(response.status).toBe(200)
          } finally {
            await harness.stop()
          }
        },
        TEST_TIMEOUT,
      )
    })

    describe('admin API disabled', () => {
      let harness: Harness

      beforeAll(async () => {
        harness = await startHarness({ apiToken: null })
      }, HOOK_TIMEOUT)

      afterAll(async () => {
        await harness.stop()
      }, HOOK_TIMEOUT)

      it('is indistinguishable from an absent one, whatever token is sent', async () => {
        for (const headers of [{}, { authorization: `Bearer ${ADMIN_TOKEN}` }]) {
          const response = await request(harness, 'GET', '/v1/admin/licenses', { headers })
          expect(response).toMatchObject({
            status: 404,
            body: { error: CustomerMessages.notFound },
          })
        }

        const create = await request(harness, 'POST', '/v1/admin/licenses', {
          json: { edition: 'professional' },
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        })
        expect(create.status).toBe(404)
        expect((await request(harness, 'GET', '/healthz')).status).toBe(200)
      })

      it('throttles repeated failed admin sign-ins', async () => {
        const page = await fetch(harness.url('/admin/'))
        const cookie = (page.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
        const csrf = /name="csrf" value="([0-9a-f]{64})"/u.exec(await page.text())?.[1] ?? ''

        const attempt = async (password: string): Promise<number> => {
          const response = await fetch(harness.url('/admin/'), {
            method: 'POST',
            redirect: 'manual',
            headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ action: 'login', csrf, password }).toString(),
          })
          await response.text()
          return response.status
        }

        const statuses: number[] = []
        for (let index = 0; index < 5; index += 1) statuses.push(await attempt('wrong password'))
        expect(statuses).toEqual([401, 401, 401, 401, 401])
        expect(await attempt('wrong password')).toBe(429)
        // Throttled means throttled: the right password waits too.
        expect(await attempt(ADMIN_PASSWORD)).toBe(429)
      })
    })

    describe('rate limiting', () => {
      let harness: Harness

      beforeAll(async () => {
        harness = await startHarness({
          settings: { rate_limit_burst: 2, rate_limit_per_minute: 6 },
        })
      }, HOOK_TIMEOUT)

      afterAll(async () => {
        await harness.stop()
      }, HOOK_TIMEOUT)

      it('answers 429 with Retry-After once a client’s burst is spent, in buckets that persist', async () => {
        const key = generateKey(() => 1)

        expect((await activate(harness, key, MACHINE_A)).status).toBe(404)
        expect((await activate(harness, key, MACHINE_A)).status).toBe(404)

        const limited = await activate(harness, key, MACHINE_A)
        expect(limited).toMatchObject({
          status: 429,
          body: { error: CustomerMessages.rateLimited },
        })
        // Ten seconds per token at six a minute, less whatever real time has
        // passed between the requests (the PHP server keeps real time).
        const retryAfter = Number(limited.headers.get('retry-after'))
        expect(retryAfter).toBeGreaterThanOrEqual(1)
        expect(retryAfter).toBeLessThanOrEqual(10)

        expect((await request(harness, 'GET', '/healthz')).status).toBe(200)

        // Every PHP request is a new process, so the bucket lives in SQLite;
        // moving it ten seconds into the past stands in for waiting.
        harness.db((db) =>
          db.prepare('UPDATE rate_limits SET updated_at = updated_at - 10000').run(),
        )
        expect((await activate(harness, key, MACHINE_A)).status).toBe(404)
      })

      it('throttles repeated admin token guesses separately from activations', async () => {
        const guess = { authorization: 'Bearer guess-guess-guess-guess-guess-guess' }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(
            (await request(harness, 'GET', '/v1/admin/licenses', { headers: guess })).status,
          ).toBe(401)
        }
        const throttled = await request(harness, 'GET', '/v1/admin/licenses', { headers: guess })
        expect(throttled.status).toBe(429)
        expect(throttled.headers.get('retry-after')).not.toBeNull()

        // The holder of the real token is not locked out by someone else guessing.
        expect((await request(harness, 'GET', '/v1/admin/licenses', { admin: true })).status).toBe(
          200,
        )
      })
    })

    describe('behind a proxy', () => {
      let harness: Harness

      beforeAll(async () => {
        harness = await startHarness({
          settings: { trust_proxy: true, rate_limit_burst: 1, rate_limit_per_minute: 1 },
        })
      }, HOOK_TIMEOUT)

      afterAll(async () => {
        await harness.stop()
      }, HOOK_TIMEOUT)

      // The reference reads the first X-Forwarded-For entry and requires its
      // proxy to overwrite the header (docs/LICENSE-SERVER.md). A CDN in front
      // of shared hosting cannot be configured, and the usual ones append, so
      // this server reads the entry the proxy added: the last. Where the
      // header has one entry — what an overwriting proxy sends — both agree.
      it('uses the X-Forwarded-For entry the proxy added, only when told a proxy is in front', async () => {
        const key = await mint(harness, { edition: 'technician' })
        const viaProxy = (forwarded: string): Promise<Reply> =>
          request(harness, 'POST', '/v1/activate', {
            json: { key, machineId: MACHINE_A, product: PRODUCT_ID },
            headers: { 'x-forwarded-for': forwarded },
          })

        expect((await viaProxy('198.51.100.9')).status).toBe(200)
        expect((await viaProxy('198.51.100.9')).status).toBe(429)
        expect((await viaProxy('198.51.100.10')).status).toBe(200)
        // What a visitor writes before the proxy's entry buys no fresh budget…
        expect((await viaProxy('192.0.2.1, 198.51.100.9')).status).toBe(429)
        expect((await viaProxy('192.0.2.2, 198.51.100.9')).status).toBe(429)

        const events = (await show(harness, key)).events as Array<{
          type: string
          ip: string | null
        }>
        // …and is never recorded as the customer's address.
        expect(events.filter((event) => event.type !== 'license-created').map((e) => e.ip)).toEqual(
          ['198.51.100.10', '198.51.100.9'],
        )
      })

      interface Browser {
        get(path: string): Promise<Reply>
        post(form: Record<string, string>): Promise<Reply>
      }

      /** A browser behind the proxy at `address`, keeping its admin session cookie. */
      function browserAt(address: string): Browser {
        let cookie = ''
        const send = async (method: string, path: string, body?: string): Promise<Reply> => {
          const headers: Record<string, string> = { 'x-forwarded-for': address }
          if (cookie !== '') headers.cookie = cookie
          if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded'
          const reply = await request(harness, method, path, {
            headers,
            ...(body === undefined ? {} : { body }),
          })
          const set = reply.headers.getSetCookie().find((line) => line.startsWith('RXLICADMIN='))
          if (set !== undefined) cookie = set.split(';')[0] ?? ''
          return reply
        }

        return {
          get: (path) => send('GET', path),
          post: (form) => send('POST', '/admin/', new URLSearchParams(form).toString()),
        }
      }

      function csrfIn(reply: Reply): string {
        return /name="csrf" value="([0-9a-f]{64})"/u.exec(reply.text)?.[1] ?? ''
      }

      async function signIn(browser: Browser): Promise<Reply> {
        const form = await browser.get('/admin/')
        return browser.post({ action: 'login', csrf: csrfIn(form), password: ADMIN_PASSWORD })
      }

      it('lets an address with no failures of its own sign in, however many failed elsewhere', async () => {
        // A hundred wrong passwords in the last minute from twenty addresses,
        // as someone guessing from many addresses leaves them.
        harness.db((db) => {
          const insert = db.prepare('INSERT INTO login_attempts (client, at) VALUES (?, ?)')
          for (let index = 0; index < 100; index += 1) {
            insert.run(`198.51.100.${index % 20}`, Date.now() - 60_000)
          }
        })

        try {
          const guesser = browserAt('198.51.100.3')
          expect((await signIn(guesser)).status).toBe(429)

          // An address that fails now waits too, from its first failure…
          const typist = browserAt('203.0.113.51')
          const form = await typist.get('/admin/')
          const attempt = (password: string): Promise<Reply> =>
            typist.post({ action: 'login', csrf: csrfIn(form), password })
          expect((await attempt('not the password')).status).toBe(401)
          expect((await attempt(ADMIN_PASSWORD)).status).toBe(429)

          // …but the vendor, with no failures of their own, signs in.
          const vendor = browserAt('203.0.113.50')
          expect((await signIn(vendor)).status).toBe(303)
          expect((await vendor.get('/admin/')).text).toContain('<h1>Dashboard</h1>')
        } finally {
          harness.db((db) => db.prepare('DELETE FROM login_attempts').run())
        }
      })

      it('counts wrong passwords given inside a session, and signs the session out at the fifth', async () => {
        const browser = browserAt('203.0.113.60')
        expect((await signIn(browser)).status).toBe(303)
        const csrf = csrfIn(await browser.get('/admin/?page=backup'))

        const right = await browser.post({ action: 'backup-key', csrf, password: ADMIN_PASSWORD })
        expect(right.status).toBe(200)
        expect(right.text).toContain('-----BEGIN PRIVATE KEY-----')

        for (let guess = 1; guess <= 4; guess += 1) {
          const wrong = await browser.post({
            action: 'backup-key',
            csrf,
            password: `guess ${guess}`,
          })
          expect(wrong.status).toBe(303)
          expect(wrong.text).not.toContain('PRIVATE KEY')
        }
        const fifth = await browser.post({
          action: 'password',
          csrf,
          current: 'guess 5',
          password: 'a brand new admin password',
          confirm: 'a brand new admin password',
        })
        expect(fifth.status).toBe(429)
        expect(fifth.text).toContain('Too many wrong passwords, so you were signed out.')

        // Signed out, and the address waits before it may sign in again.
        expect((await browser.get('/admin/?page=backup')).text).toContain('Sign in')
        expect((await signIn(browser)).status).toBe(429)
        const logs = harness.logs()
        expect(logs).toContain('"msg":"Admin password check failed","for":"signing key download"')
        expect(logs).toContain('"msg":"Admin password check failed","for":"password change"')
        expect(logs).toContain('"msg":"Admin signed out after repeated wrong passwords"')
        harness.db((db) => db.prepare('DELETE FROM login_attempts').run())
      })
    })

    describe('first-run setup over HTTP', () => {
      let harness: Harness

      beforeAll(async () => {
        harness = await startHarness({ provision: false })
      }, HOOK_TIMEOUT)

      afterAll(async () => {
        await harness.stop()
      }, HOOK_TIMEOUT)

      it(
        'needs the one-time code, generates the key on the server, shows the build values and locks itself',
        async () => {
          expect((await request(harness, 'GET', '/healthz')).status).toBe(500)

          const form = await fetch(harness.url('/setup/'))
          const html = await form.text()
          expect(form.status).toBe(200)
          expect(html).toContain('setup-code.txt')
          const cookie = (form.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
          const csrf = /name="csrf" value="([0-9a-f]{64})"/u.exec(html)?.[1] ?? ''
          const code =
            /([0-9A-Z]{5}(?:-[0-9A-Z]{5}){3})/u.exec(
              readFileSync(join(harness.dataDir, 'setup-code.txt'), 'utf8'),
            )?.[1] ?? ''
          expect(code).not.toBe('')

          const submit = (fields: Record<string, string>): Promise<Response> =>
            fetch(harness.url('/setup/'), {
              method: 'POST',
              redirect: 'manual',
              headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ csrf, mode: 'generate', ...fields }).toString(),
            })

          const wrongCode = await submit({
            code: 'AAAAA-BBBBB-CCCCC-DDDDD',
            password: ADMIN_PASSWORD,
            confirm: ADMIN_PASSWORD,
          })
          expect(wrongCode.status).toBe(403)
          expect(existsSync(join(harness.dataDir, 'setup.lock'))).toBe(false)

          const done = await submit({ code, password: ADMIN_PASSWORD, confirm: ADMIN_PASSWORD })
          expect(done.status).toBe(303)
          const session = (done.headers.getSetCookie()[0] ?? cookie).split(';')[0] ?? cookie

          const finished = await fetch(harness.url('/setup/'), { headers: { cookie: session } })
          const page = await finished.text()
          expect(finished.status).toBe(200)
          const publicKey = /RECOVERX_LICENSE_PUBLIC_KEY=([A-Za-z0-9+/=]+)/u.exec(page)?.[1] ?? ''
          expect(page).toContain('RECOVERX_ACTIVATION_URL=http://127.0.0.1')
          expect(page).toContain(fingerprintOf(publicKey))
          expect(existsSync(join(harness.dataDir, 'setup-code.txt'))).toBe(false)

          const downloadCsrf = /name="csrf" value="([0-9a-f]{64})"/u.exec(page)?.[1] ?? ''
          const download = await fetch(harness.url('/setup/'), {
            method: 'POST',
            headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ csrf: downloadCsrf, action: 'download-key' }).toString(),
          })
          expect(download.headers.get('content-disposition')).toContain('license-signing-key.pem')
          const pem = await download.text()
          expect(
            createPublicKey(createPrivateKey(pem))
              .export({ format: 'der', type: 'spki' })
              .toString('base64'),
          ).toBe(publicKey)

          expect((await request(harness, 'GET', '/healthz')).status).toBe(200)
          const again = await request(harness, 'GET', '/setup/')
          expect(again.status).toBe(404)

          // The server is usable: the admin panel accepts the new password.
          const login = await fetch(harness.url('/admin/'))
          const loginCookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
          const loginCsrf =
            /name="csrf" value="([0-9a-f]{64})"/u.exec(await login.text())?.[1] ?? ''
          const signedIn = await fetch(harness.url('/admin/'), {
            method: 'POST',
            redirect: 'manual',
            headers: { cookie: loginCookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              action: 'login',
              csrf: loginCsrf,
              password: ADMIN_PASSWORD,
            }).toString(),
          })
          expect(signedIn.status).toBe(303)
        },
        TEST_TIMEOUT,
      )
    })
  },
)

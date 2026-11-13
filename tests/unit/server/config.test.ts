import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, DEFAULTS, loadSigner, readConfig, requireDatabaseFile } from '@server/config'
import { addDays, parseExpiryDate, resolveExtension, resolveNewExpiry } from '@server/expiry'
import { createJsonLogger } from '@server/log'
import { RateLimiter, clientBucketId } from '@server/rate-limit'
import { LicenseStore, SCHEMA_VERSION } from '@server/store'
import { DAY, NOW, freshKeyPair, tempDir, type TempDir } from './fixtures'

/**
 * Configuration, start-up safety checks, and the small pure pieces the
 * server is built from: expiry arithmetic, rate limiting, logging and the
 * schema version guard.
 */

describe('configuration', () => {
  it('applies defaults, but none for the database path', () => {
    const config = readConfig({}, '/srv/licensing')

    expect(config).toEqual({
      signingKey: null,
      dbFile: null,
      host: '127.0.0.1',
      port: 8787,
      adminToken: null,
      trustProxy: false,
      expectedPublicKey: null,
      rateLimit: { burst: DEFAULTS.rateLimitBurst, perMinute: DEFAULTS.rateLimitPerMinute },
      selfRelease: { limit: 4, windowDays: 365 },
      eventRetentionDays: 395,
    })
  })

  it('treats empty variables as unset, as container tooling produces them', () => {
    const config = readConfig({
      PORT: '',
      LICENSE_ADMIN_TOKEN: '  ',
      LICENSE_TRUST_PROXY: '',
      LICENSE_DB_FILE: ' ',
    })
    expect(config.port).toBe(8787)
    expect(config.adminToken).toBeNull()
    expect(config.trustProxy).toBe(false)
    expect(config.dbFile).toBeNull()
  })

  it('resolves a relative database path against the working directory', () => {
    const config = readConfig({ LICENSE_DB_FILE: 'state/licences.db' }, '/srv/licensing')
    expect(requireDatabaseFile(config)).toBe(resolve('/srv/licensing', 'state/licences.db'))
  })

  it('refuses to pick a database path itself', () => {
    // A default relative to the working directory once put the customer
    // database inside the source checkout, where `git add -A` would commit it.
    const config = readConfig({}, '/srv/licensing')
    expect(() => requireDatabaseFile(config)).toThrow(ConfigError)
    expect(() => requireDatabaseFile(config)).toThrow(
      /LICENSE_DB_FILE is not set.*--db.*outside any source checkout/u,
    )
  })

  it('accepts an admin token made of any printable ASCII', () => {
    const token = `${'a'.repeat(16)}!#$%&'*+-./0~^_|=`
    expect(readConfig({ LICENSE_ADMIN_TOKEN: `  ${token}\n` }).adminToken).toBe(token)
  })

  it('reads every variable', () => {
    const config = readConfig(
      {
        LICENSE_SIGNING_KEY_FILE: 'keys/signing.pem',
        LICENSE_DB_FILE: '/var/lib/licensing/db.sqlite',
        HOST: '0.0.0.0',
        PORT: '9000',
        LICENSE_ADMIN_TOKEN: 'a'.repeat(32),
        LICENSE_TRUST_PROXY: 'yes',
        RECOVERX_LICENSE_PUBLIC_KEY: 'MCowBQYDK2VwAyEA',
        LICENSE_RATE_LIMIT_BURST: '5',
        LICENSE_RATE_LIMIT_PER_MINUTE: '12',
        LICENSE_SELF_RELEASE_LIMIT: '2',
        LICENSE_SELF_RELEASE_WINDOW_DAYS: '90',
        LICENSE_EVENT_RETENTION_DAYS: '120',
      },
      '/srv',
    )

    expect(config).toMatchObject({
      signingKey: { kind: 'file', path: resolve('/srv', 'keys/signing.pem') },
      // Already absolute (on Windows too), so taken as given.
      dbFile: '/var/lib/licensing/db.sqlite',
      host: '0.0.0.0',
      port: 9000,
      adminToken: 'a'.repeat(32),
      trustProxy: true,
      expectedPublicKey: 'MCowBQYDK2VwAyEA',
      rateLimit: { burst: 5, perMinute: 12 },
      selfRelease: { limit: 2, windowDays: 90 },
      eventRetentionDays: 120,
    })
  })

  it('accepts a retention as short as the self-service window, and no shorter', () => {
    expect(
      readConfig({ LICENSE_SELF_RELEASE_WINDOW_DAYS: '730', LICENSE_EVENT_RETENTION_DAYS: '730' }),
    ).toMatchObject({ selfRelease: { windowDays: 730 }, eventRetentionDays: 730 })
    expect(readConfig({ LICENSE_EVENT_RETENTION_DAYS: '365' }).eventRetentionDays).toBe(365)
    expect(readConfig({ LICENSE_EVENT_RETENTION_DAYS: ' ' }).eventRetentionDays).toBe(395)
  })

  it('accepts 0 self-service releases, which sends every move through support', () => {
    // Unlike the rate limits, where 0 would refuse everyone, 0 is a policy here.
    expect(readConfig({ LICENSE_SELF_RELEASE_LIMIT: '0' }).selfRelease).toEqual({
      limit: 0,
      windowDays: 365,
    })
    expect(readConfig({ LICENSE_SELF_RELEASE_LIMIT: ' ' }).selfRelease.limit).toBe(4)
  })

  it.each([
    [{ PORT: 'eighty' }, /PORT: must be a port number/u],
    [{ PORT: '70000' }, /PORT: must be between 0 and 65535/u],
    [{ LICENSE_ADMIN_TOKEN: 'short' }, /LICENSE_ADMIN_TOKEN: must be at least 32 characters/u],
    // A passphrase can never be presented as `Bearer <token>`, which the
    // server reads up to the first space; nor can a non-ASCII character.
    [
      { LICENSE_ADMIN_TOKEN: 'correct horse battery staple tango foxtrot' },
      /LICENSE_ADMIN_TOKEN: must be printable ASCII with no spaces/u,
    ],
    [
      { LICENSE_ADMIN_TOKEN: `${'a'.repeat(32)}é` },
      /LICENSE_ADMIN_TOKEN: must be printable ASCII with no spaces/u,
    ],
    [
      { LICENSE_ADMIN_TOKEN: `${'a'.repeat(16)}\t${'b'.repeat(16)}` },
      /LICENSE_ADMIN_TOKEN: must be printable ASCII with no spaces/u,
    ],
    [{ LICENSE_TRUST_PROXY: 'maybe' }, /LICENSE_TRUST_PROXY: must be true or false/u],
    [{ LICENSE_RATE_LIMIT_BURST: '0' }, /LICENSE_RATE_LIMIT_BURST: must be at least 1/u],
    [{ LICENSE_SELF_RELEASE_LIMIT: '-1' }, /LICENSE_SELF_RELEASE_LIMIT: must be at least 0/u],
    [{ LICENSE_SELF_RELEASE_LIMIT: '2.5' }, /LICENSE_SELF_RELEASE_LIMIT: must be a whole number/u],
    [{ LICENSE_SELF_RELEASE_LIMIT: 'four' }, /LICENSE_SELF_RELEASE_LIMIT: must be a whole number/u],
    [
      { LICENSE_SELF_RELEASE_WINDOW_DAYS: '0' },
      /LICENSE_SELF_RELEASE_WINDOW_DAYS: must be at least 1/u,
    ],
    [
      { LICENSE_SELF_RELEASE_WINDOW_DAYS: '36500' },
      /LICENSE_SELF_RELEASE_WINDOW_DAYS: must be at most 3650/u,
    ],
    [{ LICENSE_EVENT_RETENTION_DAYS: '0' }, /LICENSE_EVENT_RETENTION_DAYS: must be at least 1/u],
    [
      { LICENSE_EVENT_RETENTION_DAYS: '13 months' },
      /LICENSE_EVENT_RETENTION_DAYS: must be a whole number/u,
    ],
    [
      { LICENSE_EVENT_RETENTION_DAYS: '365000' },
      /LICENSE_EVENT_RETENTION_DAYS: must be at most 36500/u,
    ],
    // Moves are counted from the event log, so it must outlive the window.
    [
      { LICENSE_EVENT_RETENTION_DAYS: '364' },
      /LICENSE_EVENT_RETENTION_DAYS \(364\) must be at least LICENSE_SELF_RELEASE_WINDOW_DAYS \(365\)/u,
    ],
    // Lengthening the window alone is the likelier way to get there.
    [
      { LICENSE_SELF_RELEASE_WINDOW_DAYS: '730' },
      /LICENSE_EVENT_RETENTION_DAYS \(395\) must be at least LICENSE_SELF_RELEASE_WINDOW_DAYS \(730\)/u,
    ],
    [{ LICENSE_SIGNING_KEY_FILE: 'a.pem', LICENSE_SIGNING_KEY: 'pem' }, /not both/u],
  ])('refuses %j with a clear message', (env, message) => {
    expect(() => readConfig(env)).toThrow(ConfigError)
    expect(() => readConfig(env)).toThrow(message)
  })

  it('reports every problem at once', () => {
    expect(() => readConfig({ PORT: 'x', LICENSE_ADMIN_TOKEN: 'y' })).toThrow(
      /PORT.*LICENSE_ADMIN_TOKEN/u,
    )
  })
})

describe('loading the signing key', () => {
  let dir: TempDir

  beforeEach(() => {
    dir = tempDir('recoverx-licence-config-')
  })

  afterEach(() => {
    dir.cleanup()
  })

  it('loads a key from a file and from an inline value with escaped newlines', () => {
    const keys = freshKeyPair()
    const file = join(dir.path, 'key.pem')
    writeFileSync(file, keys.pem)

    expect(loadSigner(readConfig({ LICENSE_SIGNING_KEY_FILE: file })).publicKey).toBe(
      keys.publicKey,
    )

    const escaped = keys.pem.trim().replace(/\n/gu, '\\n')
    expect(loadSigner(readConfig({ LICENSE_SIGNING_KEY: escaped })).publicKey).toBe(keys.publicKey)
  })

  it('starts only when the key matches the public key builds embed', () => {
    const keys = freshKeyPair()
    const other = freshKeyPair()

    expect(
      loadSigner(
        readConfig({ LICENSE_SIGNING_KEY: keys.pem, RECOVERX_LICENSE_PUBLIC_KEY: keys.publicKey }),
      ).fingerprint,
    ).toMatch(/^SHA256:/u)

    expect(() =>
      loadSigner(
        readConfig({ LICENSE_SIGNING_KEY: keys.pem, RECOVERX_LICENSE_PUBLIC_KEY: other.publicKey }),
      ),
    ).toThrow(/does not match RECOVERX_LICENSE_PUBLIC_KEY.*would reject/u)
  })

  it.each<[string, () => Record<string, string>, RegExp]>([
    ['no key at all', () => ({}), /No signing key is configured/u],
    [
      'a file that is not there',
      () => ({ LICENSE_SIGNING_KEY_FILE: join(dir.path, 'missing.pem') }),
      /could not be read/u,
    ],
    ['text that is not a PEM key', () => ({ LICENSE_SIGNING_KEY: 'hello' }), /not a readable PEM/u],
    [
      'an RSA key',
      () => ({
        LICENSE_SIGNING_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 })
          .privateKey.export({ format: 'pem', type: 'pkcs8' })
          .toString(),
      }),
      /rsa key.*Ed25519/u,
    ],
  ])('refuses %s', (_label, env, message) => {
    expect(() => loadSigner(readConfig(env()))).toThrow(ConfigError)
    expect(() => loadSigner(readConfig(env()))).toThrow(message)
  })
})

describe('expiry arithmetic', () => {
  it('reads a bare date as the end of that day, UTC', () => {
    expect(parseExpiryDate('2027-03-31')).toBe(Date.UTC(2027, 2, 31, 23, 59, 59, 999))
    expect(parseExpiryDate('2028-02-29')).toBe(Date.UTC(2028, 1, 29, 23, 59, 59, 999))
  })

  it('reads an ISO instant only with an explicit zone', () => {
    expect(parseExpiryDate('2027-03-31T12:00:00Z')).toBe(Date.UTC(2027, 2, 31, 12))
    expect(parseExpiryDate('2027-03-31T12:00+05:30')).toBe(Date.UTC(2027, 2, 31, 6, 30))
    expect(() => parseExpiryDate('2027-03-31T12:00:00')).toThrow(/not a date/u)
  })

  it('refuses dates that do not exist', () => {
    expect(() => parseExpiryDate('2027-02-29')).toThrow(/not a real date/u)
    expect(() => parseExpiryDate('2027-13-01')).toThrow(/not a real date/u)
  })

  it('refuses impossible days in a full ISO time too, which Date.parse would roll forward', () => {
    // V8 reads 2027-02-30T12:00:00Z as 2 March; a webhook sending it must get
    // a 400, not a licence that ends two days after the date it asked for.
    for (const text of [
      '2027-02-30T12:00:00Z',
      '2027-04-31T23:59:59Z',
      '2027-02-29T00:00Z',
      '2027-02-31T00:00:00+14:00',
      '2027-00-10T00:00:00Z',
    ]) {
      expect(() => parseExpiryDate(text), text).toThrow(/not a real date/u)
    }

    expect(parseExpiryDate('2028-02-29T23:59:59Z')).toBe(Date.UTC(2028, 1, 29, 23, 59, 59))
    // ISO 8601's end-of-day midnight is still a real time on a real date.
    expect(parseExpiryDate('2027-03-31T24:00:00Z')).toBe(Date.UTC(2027, 3, 1))
    // An impossible time is refused by the parser itself.
    expect(() => parseExpiryDate('2027-03-31T25:00:00Z')).toThrow(/not a date/u)
  })

  it('resolves new terms and renewals', () => {
    expect(resolveNewExpiry({}, NOW)).toBeNull()
    expect(resolveNewExpiry({ days: 1 }, NOW)).toBe(addDays(NOW, 1))
    expect(() => resolveNewExpiry({ days: 36_501 }, NOW)).toThrow(/36500/u)

    expect(resolveExtension({ days: 10 }, NOW + DAY, NOW)).toBe(NOW + 11 * DAY)
    expect(resolveExtension({ days: 10 }, NOW - DAY, NOW)).toBe(NOW + 10 * DAY)
    expect(resolveExtension({ perpetual: true }, NOW, NOW)).toBeNull()
    expect(() => resolveExtension({ expires: '2001-01-01' }, null, NOW)).toThrow(/past/u)
  })
})

describe('rate limiter', () => {
  it('allows a burst, then refills at the sustained rate', () => {
    let now = 0
    const limiter = new RateLimiter({ burst: 3, perMinute: 60, clock: () => now })

    expect([1, 2, 3].map(() => limiter.take('192.0.2.1').allowed)).toEqual([true, true, true])
    expect(limiter.take('192.0.2.1')).toEqual({ allowed: false, retryAfterSeconds: 1 })
    // Other clients are unaffected.
    expect(limiter.take('192.0.2.2').allowed).toBe(true)

    now += 1000
    expect(limiter.take('192.0.2.1').allowed).toBe(true)
    expect(limiter.take('192.0.2.1').allowed).toBe(false)
  })

  it('keeps scopes apart', () => {
    const limiter = new RateLimiter({ burst: 1, perMinute: 1, clock: () => 0 })

    expect(limiter.take('192.0.2.1').allowed).toBe(true)
    expect(limiter.take('192.0.2.1', 'admin-auth').allowed).toBe(true)
    expect(limiter.take('192.0.2.1').allowed).toBe(false)
  })

  it('groups an IPv6 client by its /64 and unwraps IPv4-mapped addresses', () => {
    expect(clientBucketId('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64')
    expect(clientBucketId('2001:db8:aa:bb::9')).toBe('2001:db8:aa:bb::/64')
    expect(clientBucketId('2001:0db8:00aa::')).toBe('2001:db8:aa:0::/64')
    expect(clientBucketId('::1')).toBe('0:0:0:0::/64')
    expect(clientBucketId('::ffff:192.0.2.7')).toBe('192.0.2.7')
    expect(clientBucketId('192.0.2.7')).toBe('192.0.2.7')
    expect(clientBucketId('unknown')).toBe('unknown')
  })

  it('bounds memory without ever forgetting the client it is charging', () => {
    let now = 0
    const limiter = new RateLimiter({ burst: 2, perMinute: 1, maxClients: 2, clock: () => now })

    limiter.take('192.0.2.1')
    limiter.take('192.0.2.2')

    // A full table with nobody idle: the least recently seen client makes room,
    // and the newcomer's bucket is kept and charged rather than evicted.
    expect(limiter.take('192.0.2.3').allowed).toBe(true)
    expect(limiter.size).toBe(2)
    expect(limiter.take('192.0.2.3').allowed).toBe(true)
    expect(limiter.take('192.0.2.3').allowed).toBe(false)

    // Clients whose buckets have refilled are indistinguishable from new ones
    // and are the first to go.
    now += 10 * 60_000
    limiter.take('192.0.2.4')
    expect(limiter.size).toBe(1)
  })
})

describe('structured log', () => {
  it('writes one JSON object per line, with errors made serialisable', () => {
    const lines: string[] = []
    const logger = createJsonLogger({ write: (line) => lines.push(line), clock: () => NOW })

    logger.info('started', { port: 8787 })
    logger.error('failed', { error: new Error('boom') })

    expect(lines.every((line) => line.endsWith('\n'))).toBe(true)
    expect(JSON.parse(lines[0] ?? '') as unknown).toEqual({
      time: '2026-11-12T12:00:00.000Z',
      level: 'info',
      msg: 'started',
      port: 8787,
    })
    expect(JSON.parse(lines[1] ?? '') as unknown).toMatchObject({
      level: 'error',
      error: { name: 'Error', message: 'boom' },
    })
  })

  it('survives a field that cannot be serialised', () => {
    const lines: string[] = []
    const logger = createJsonLogger({ write: (line) => lines.push(line) })

    logger.warn('odd', { value: 10n })
    expect(JSON.parse(lines[0] ?? '') as unknown).toMatchObject({ logError: 'unserialisable' })
  })
})

describe('database schema version', () => {
  let dir: TempDir

  beforeEach(() => {
    dir = tempDir('recoverx-licence-schema-')
  })

  afterEach(() => {
    dir.cleanup()
  })

  it('migrates a new database and reopens an existing one', () => {
    const file = join(dir.path, 'db.sqlite')

    const first = LicenseStore.open(file)
    expect(first.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    first.close()

    const second = LicenseStore.open(file)
    expect(second.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    second.close()
  })

  it('refuses a database written by a newer server release', () => {
    const file = join(dir.path, 'db.sqlite')
    const store = LicenseStore.open(file)
    store.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    store.close()

    expect(() => LicenseStore.open(file)).toThrow(/newer server release/u)
  })

  it('enforces the paid-edition and seat constraints in the schema itself', () => {
    const store = LicenseStore.open(join(dir.path, 'db.sqlite'))
    const insert = (edition: string, seats: number | null): void => {
      store.db
        .prepare(
          'INSERT INTO licenses (key, edition, max_activations, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(`K-${edition}-${String(seats)}`, edition, seats, NOW)
    }

    try {
      expect(() => insert('free', null)).toThrow(/CHECK constraint/u)
      expect(() => insert('professional', 0)).toThrow(/CHECK constraint/u)
      expect(() => insert('professional', 1)).not.toThrow()
    } finally {
      store.close()
    }
  })
})

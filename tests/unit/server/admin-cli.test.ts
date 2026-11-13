import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyToken } from '@main/licensing/activation-token'
import { validateKey } from '@shared/utils/license-key'
import { COMMAND_NAMES, parseCommandLine, runAdmin, type AdminIo } from '@server/admin-cli'
import { LicenseAuthority } from '@server/authority'
import { createTokenSigner } from '@server/signing'
import { LicenseStore } from '@server/store'
import {
  DAY,
  FakeClock,
  MACHINE_A,
  MACHINE_B,
  NOW,
  PRODUCT_ID,
  freshKeyPair,
  tempDir,
  type KeyPair,
  type TempDir,
} from './fixtures'

/**
 * The admin CLI: argument parsing on its own, then every command end to end
 * against a real database, reading back exactly what an operator would see.
 */

describe('parsing the command line', () => {
  it('prints general help with no arguments, --help, -h or "help"', () => {
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const parsed = parseCommandLine(argv)
      expect(parsed.kind).toBe('help')
      if (parsed.kind !== 'help') continue

      for (const command of COMMAND_NAMES) expect(parsed.text).toContain(command)
    }
  })

  it('prints a command’s own help', () => {
    for (const argv of [
      ['create', '--help'],
      ['create', '-h'],
      ['help', 'create'],
    ]) {
      const parsed = parseCommandLine(argv)
      expect(parsed).toMatchObject({ kind: 'help' })
      expect(parsed.kind === 'help' && parsed.text).toContain('--edition <edition>')
    }
  })

  it('parses a command with options in either form', () => {
    expect(
      parseCommandLine([
        'create',
        '--edition',
        'business',
        '--count=3',
        '--to',
        'Contoso Ltd',
        '--json',
        '--db',
        'x.db',
      ]),
    ).toEqual({
      kind: 'run',
      command: 'create',
      args: [],
      options: {
        edition: 'business',
        count: '3',
        to: 'Contoso Ltd',
        json: true,
        db: 'x.db',
      },
      db: 'x.db',
      json: true,
    })
  })

  it('collects positional arguments in order', () => {
    expect(parseCommandLine(['release', 'RECX-KEY', MACHINE_A])).toMatchObject({
      kind: 'run',
      command: 'release',
      args: ['RECX-KEY', MACHINE_A],
      json: false,
      db: undefined,
    })
  })

  it.each([
    [['frobnicate'], /Unknown command "frobnicate"/u],
    [['create', '--colour', 'red'], /Unknown option '--colour'/u],
    [['show'], /"show" needs <key>, but was given 0/u],
    [['release', 'RECX-KEY'], /needs <key> <machine-id>/u],
    [['list', 'extra'], /takes no arguments/u],
    [['create', '--edition'], /argument missing/u],
    [['extend', 'K', '--perpetual=yes'], /does not take an argument/u],
  ])('reports %j as a usage error', (argv, message) => {
    const parsed = parseCommandLine(argv)
    expect(parsed.kind).toBe('error')
    expect(parsed.kind === 'error' && parsed.message).toMatch(message)
  })
})

describe('running commands', () => {
  let dir: TempDir
  let keys: KeyPair
  let keyFile: string
  let dbFile: string
  let clock: FakeClock
  let out: string[]
  let err: string[]

  beforeEach(() => {
    dir = tempDir('recoverx-licence-cli-')
    keys = freshKeyPair()
    keyFile = join(dir.path, 'license-signing-key.pem')
    writeFileSync(keyFile, keys.pem)
    dbFile = join(dir.path, 'data', 'licences.db')
    clock = new FakeClock()
    out = []
    err = []
  })

  afterEach(() => {
    dir.cleanup()
  })

  function io(env: Record<string, string> = {}): AdminIo {
    return {
      env: { LICENSE_DB_FILE: dbFile, LICENSE_SIGNING_KEY_FILE: keyFile, ...env },
      cwd: dir.path,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      clock: clock.now,
    }
  }

  /** Run a command and return its exit code, clearing the captured output first. */
  function run(argv: string[], env?: Record<string, string>): number {
    out = []
    err = []
    return runAdmin(argv, io(env))
  }

  function json<T>(): T {
    return JSON.parse(out.join('')) as T
  }

  function create(...extra: string[]): string {
    expect(run(['create', '--edition', 'professional', '--json', ...extra])).toBe(0)
    return json<{ licenses: Array<{ key: string }> }>().licenses[0]?.key ?? ''
  }

  it('creates licences, printing the keys for the operator to send', () => {
    expect(
      run([
        'create',
        '--edition',
        'business',
        '--count',
        '2',
        '--days',
        '365',
        '--to',
        'Contoso Ltd',
        '--order',
        'INV-1042',
      ]),
    ).toBe(0)

    const text = out.join('')
    expect(text).toMatch(/Created 2 business licences \(3 computers each, until 2027-11-12/u)
    expect(text).toContain('Registered to: Contoso Ltd')

    const keys = text.match(/RECX(-[0-9A-Z]{5}){4}/gu) ?? []
    expect(keys).toHaveLength(2)
    for (const key of keys) expect(validateKey(key).key).toBe(key)

    // The same order again mints nothing.
    expect(run(['create', '--edition', 'business', '--order', 'INV-1042'])).toBe(0)
    expect(out.join('')).toMatch(/already fulfilled/u)
  })

  it('creates the database directory on first use', () => {
    expect(existsSync(dbFile)).toBe(false)
    create()
    expect(existsSync(dbFile)).toBe(true)
  })

  it('accepts --seats unlimited and refuses the Free edition', () => {
    expect(run(['create', '--edition', 'professional', '--seats', 'unlimited', '--json'])).toBe(0)
    expect(
      json<{ licenses: Array<{ maxActivations: number | null }> }>().licenses[0],
    ).toMatchObject({ maxActivations: null })

    expect(run(['create', '--edition', 'free'])).toBe(1)
    expect(err.join('')).toMatch(/Free edition needs no licence key/u)

    expect(run(['create', '--edition', 'gold'])).toBe(2)
    expect(run(['create', '--edition', 'business', '--count', 'three'])).toBe(2)
    expect(err.join('')).toMatch(/--count must be a whole number/u)
  })

  it('lists, shows, revokes and restores', () => {
    const key = create('--to', 'Jane Doe', '--email', 'jane@example.com')

    expect(run(['list'])).toBe(0)
    expect(out.join('')).toMatch(
      new RegExp(`${key}\\s+professional\\s+0/1\\s+perpetual\\s+active\\s+Jane Doe`, 'u'),
    )

    expect(run(['revoke', key, '--reason', 'refund INV-9'])).toBe(0)
    expect(out.join('')).toBe(`Revoked ${key} (refund INV-9).\n`)

    expect(run(['show', key])).toBe(0)
    const shown = out.join('')
    expect(shown).toMatch(/Status:\s+revoked 2026-11-12 12:00 UTC \(refund INV-9\)/u)
    expect(shown).toMatch(/E-mail:\s+jane@example\.com/u)
    expect(shown).toContain('revoked')
    expect(shown).toContain('license-created')

    expect(run(['restore', key])).toBe(0)
    expect(run(['show', key, '--json'])).toBe(0)
    expect(json<{ standing: string }>().standing).toBe('active')
  })

  it('extends a term and reports the new end date', () => {
    const key = create('--days', '30')

    expect(run(['extend', key, '--days', '365'])).toBe(0)
    expect(out.join('')).toMatch(/now expires 2027-12-12 12:00 UTC/u)

    expect(run(['extend', key, '--perpetual', '--json'])).toBe(0)
    expect(json<{ license: { expiresAt: number | null } }>().license.expiresAt).toBeNull()

    expect(run(['extend', key])).toBe(1)
    expect(err.join('')).toMatch(/exactly one/u)
  })

  it('issues an offline activation the desktop client accepts', () => {
    const key = create()

    expect(run(['offline', key, MACHINE_A.toLowerCase()])).toBe(0)
    const token = out.join('').trim()
    expect(token.split('.')).toHaveLength(2)
    expect(err.join('')).toContain(`on machine ${MACHINE_A}`)

    expect(
      verifyToken(token, {
        publicKey: keys.publicKey,
        machineId: MACHINE_A,
        expectedKey: key,
        now: NOW,
      }).ok,
    ).toBe(true)

    // The seat rules apply: a second machine on a one-seat licence is refused.
    expect(run(['offline', key, MACHINE_B])).toBe(1)
    expect(err.join('')).toMatch(/already active on another computer/u)
  })

  it('writes an offline activation to a file', () => {
    const key = create()
    const file = join(dir.path, 'activation.txt')

    expect(run(['offline', key, MACHINE_A, '--out', file])).toBe(0)
    expect(out.join('')).toContain(`Wrote it to ${file}`)
    expect(readFileSync(file, 'utf8').trim().split('.')).toHaveLength(2)
  })

  it('releases one machine and resets all seats', () => {
    const key = create('--seats', '2')
    run(['offline', key, MACHINE_A])
    run(['offline', key, MACHINE_B])

    expect(run(['release', key, MACHINE_A])).toBe(0)
    expect(out.join('')).toContain(`Released the seat ${MACHINE_A}`)

    expect(run(['reset', key, '--json'])).toBe(0)
    expect(json<{ released: number }>()).toEqual({ released: 1 })

    expect(run(['show', key, '--json'])).toBe(0)
    expect(json<{ activeSeats: number }>().activeSeats).toBe(0)
  })

  it('shows where a licence stands against the self-service move allowance', () => {
    const key = create('--seats', '2')

    // The customer's own moves go through the HTTP route, which the CLI does
    // not have; the authority it delegates to stands in for it here.
    const store = LicenseStore.open(dbFile)
    try {
      const customer = new LicenseAuthority({
        store,
        signer: createTokenSigner(keys.privateKey),
        clock: clock.now,
      })
      for (let move = 0; move < 4; move += 1) {
        const { token } = customer.activate(
          { key, machineId: MACHINE_A, product: PRODUCT_ID },
          { actor: 'customer', ip: '203.0.113.7' },
        )
        customer.deactivate(token, { actor: 'customer' })
      }
    } finally {
      store.close()
    }

    expect(run(['show', key])).toBe(0)
    expect(out.join('')).toMatch(
      /Self-service moves:\s+4 of 4 in the last 365 days — allowance spent; use release or reset/u,
    )

    // Support's release is not counted, whichever route it takes.
    expect(run(['offline', key, MACHINE_B])).toBe(0)
    expect(run(['release', key, MACHINE_B])).toBe(0)
    expect(run(['show', key, '--json'])).toBe(0)
    expect(json<{ selfReleases: unknown }>().selfReleases).toEqual({
      recent: 4,
      limit: 4,
      windowDays: 365,
    })

    // The CLI reports against the server's configured policy.
    expect(run(['show', key], { LICENSE_SELF_RELEASE_LIMIT: '0' })).toBe(0)
    expect(out.join('')).toMatch(/Self-service moves:\s+4 in the last 365 days; .*turned off/u)

    // Unlimited seats are counted but never limited.
    const unlimited = create('--seats', 'unlimited')
    expect(run(['show', unlimited])).toBe(0)
    expect(out.join('')).toMatch(
      /Self-service moves:\s+0 in the last 365 days; not limited \(unlimited seats\)\n/u,
    )
  })

  it('prunes the event log past the retention, with a dry run to look first', () => {
    const key = create()
    clock.advance(400 * DAY)
    create()

    expect(run(['prune-events', '--dry-run'])).toBe(0)
    expect(out.join('')).toBe(
      '1 event recorded before 2026-11-17 12:00 UTC (the retention is 395 days) would be deleted. ' +
        'This was a dry run: nothing was deleted.\n',
    )

    expect(run(['prune-events'])).toBe(0)
    expect(out.join('')).toBe(
      'Deleted 1 event recorded before 2026-11-17 12:00 UTC (the retention is 395 days).\n',
    )
    expect(run(['show', key])).toBe(0)
    expect(out.join('')).toMatch(/Recent events:\n {2}\(none\)/u)

    // A second pass finds nothing, and says so.
    expect(run(['prune-events', '--json'])).toBe(0)
    expect(json<unknown>()).toEqual({
      retentionDays: 395,
      cutoff: NOW + 5 * DAY,
      found: 0,
      deleted: 0,
      dryRun: false,
    })

    // It reads the server's retention, and its guard.
    expect(run(['prune-events', '--dry-run'], { LICENSE_EVENT_RETENTION_DAYS: '365' })).toBe(0)
    expect(out.join('')).toBe(
      '0 events recorded before 2026-12-17 12:00 UTC (the retention is 365 days) would be deleted. ' +
        'This was a dry run: nothing was deleted.\n',
    )
    expect(run(['prune-events'], { LICENSE_EVENT_RETENTION_DAYS: '30' })).toBe(1)
    expect(err.join('')).toMatch(/must be at least LICENSE_SELF_RELEASE_WINDOW_DAYS/u)

    expect(run(['prune-events', 'now'])).toBe(2)
  })

  it('prints the public key in the form a build environment takes', () => {
    expect(run(['public-key'])).toBe(0)
    expect(out.join('')).toContain(`RECOVERX_LICENSE_PUBLIC_KEY=${keys.publicKey}\n`)
    // `public-key` touches no database.
    expect(existsSync(dbFile)).toBe(false)

    expect(run(['public-key', '--json'])).toBe(0)
    expect(json<{ publicKey: string }>().publicKey).toBe(keys.publicKey)
  })

  it('refuses a signing key that does not match the shipped public key', () => {
    const other = freshKeyPair()
    expect(run(['public-key'], { RECOVERX_LICENSE_PUBLIC_KEY: other.publicKey })).toBe(1)
    expect(err.join('')).toMatch(/does not match RECOVERX_LICENSE_PUBLIC_KEY/u)
  })

  it('does not need the signing key for commands that sign nothing', () => {
    expect(run(['create', '--edition', 'professional'], { LICENSE_SIGNING_KEY_FILE: '' })).toBe(0)
    expect(run(['list'], { LICENSE_SIGNING_KEY_FILE: '' })).toBe(0)

    expect(run(['offline', 'RECX-X', MACHINE_A], { LICENSE_SIGNING_KEY_FILE: '' })).toBe(1)
    expect(err.join('')).toMatch(/No signing key is configured/u)
  })

  it('refuses to invent an empty database for anything but create', () => {
    expect(run(['list'])).toBe(1)
    expect(err.join('')).toMatch(/There is no licence database at/u)
    expect(existsSync(dbFile)).toBe(false)
  })

  it('needs a database path, and never invents one in the working directory', () => {
    // The working directory is the repository when run as `npm run
    // licensing:admin`; a default there would put customer data in the tree.
    expect(run(['create', '--edition', 'professional'], { LICENSE_DB_FILE: '' })).toBe(1)
    expect(err.join('')).toMatch(/LICENSE_DB_FILE is not set/u)
    expect(run(['list', '--json'], { LICENSE_DB_FILE: '' })).toBe(1)
    expect((JSON.parse(err.join('')) as { error: string }).error).toMatch(
      /LICENSE_DB_FILE is not set/u,
    )
    expect(readdirSync(dir.path)).toEqual(['license-signing-key.pem'])

    // `public-key` touches no database, so it does not need one.
    expect(run(['public-key'], { LICENSE_DB_FILE: '' })).toBe(0)
  })

  it('honours --db over the environment', () => {
    const other = join(dir.path, 'other.db')
    expect(run(['create', '--edition', 'professional', '--db', other])).toBe(0)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(dbFile)).toBe(false)
  })

  it('distinguishes usage errors (2) from refused operations (1), in text and JSON', () => {
    create()

    expect(run(['show'])).toBe(2)
    expect(err.join('')).toMatch(/^error: "show" needs <key>/u)

    expect(run(['show', 'RECX-00000-00000-00000-00000'])).toBe(1)
    expect(run(['show', 'not-a-key', '--json'])).toBe(1)
    const failure = JSON.parse(err.join('')) as { error: string }
    expect(Object.keys(failure)).toEqual(['error'])
    expect(failure.error).toMatch(/not a well-formed licence key/u)
  })

  it('uses the injected clock for every timestamp it writes', () => {
    clock.advance(10 * DAY)
    const key = create()

    expect(run(['show', key, '--json'])).toBe(0)
    expect(json<{ license: { createdAt: number } }>().license.createdAt).toBe(NOW + 10 * DAY)
  })
})

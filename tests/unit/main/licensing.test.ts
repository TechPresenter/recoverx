import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { decodeTokenClaims, verifyToken } from '@main/licensing/activation-token'
import type * as MachineIdModule from '@main/licensing/machine-id'
import { extractMachineGuid, formatMachineId } from '@main/licensing/machine-id'
import {
  DEACTIVATION_TIMEOUT_MS,
  LicenseService,
  PENDING_RELEASE_FILE,
  RENEWAL_CHECK_TIMEOUT_MS,
  RENEWAL_GRACE_MS,
  RENEWAL_WINDOW_MS,
  improvesOn,
  isDefinitiveRefusal,
  stateFor,
  type LicenseEndpoints,
} from '@main/licensing/license.service'
import type { AppPaths } from '@main/config/paths'
import type { Logger } from '@main/logging/logger'
import { AppError, ErrorCode } from '@shared/utils/errors'
import { ENTITLEMENTS, entitlementsFor, type ActivationClaims } from '@shared/types/license'
import {
  checksumCharacter,
  completeKey,
  formatKey,
  formatKeyAsTyped,
  isPartialKeyPrefix,
  maskKey,
  normalizeKeyInput,
  validateKey,
} from '@shared/utils/license-key'
import { FREE_EDITION_RECOVERY_LIMIT_BYTES, LICENSE_EDITIONS } from '@shared/constants/app'
import type * as LicensingConstants from '@shared/constants/licensing'
import {
  LICENSE_ACTIVATION_URL,
  LICENSE_DEACTIVATION_URL,
  deriveDeactivationUrl,
} from '@shared/constants/licensing'

/**
 * The build's public key and this machine's identifier, overridable per test.
 *
 * Left unset, both are the real thing: no key compiled into the test build,
 * and the identifier read from this computer. Storing an activation is only
 * reachable with both set, because the service verifies every token it keeps
 * against exactly these two values.
 */
const build = vi.hoisted(() => ({
  publicKey: null as string | null,
  machineId: null as string | null,
}))

vi.mock('@shared/constants/licensing', async (importOriginal) => {
  const actual = await importOriginal<typeof LicensingConstants>()
  return {
    ...actual,
    get LICENSE_PUBLIC_KEY(): string {
      return build.publicKey ?? actual.LICENSE_PUBLIC_KEY
    },
  }
})

vi.mock('@main/licensing/machine-id', async (importOriginal) => {
  const actual = await importOriginal<typeof MachineIdModule>()
  return {
    ...actual,
    resolveMachineId: (): Promise<string> =>
      build.machineId === null ? actual.resolveMachineId() : Promise.resolve(build.machineId),
  }
})

/**
 * Licensing.
 *
 * The signing key pair is generated per run rather than committed. A fixture
 * private key in a repository is a private key that eventually ships, and the
 * one thing this scheme genuinely cannot survive is the signing key leaking.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
}

const MACHINE = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX'
const NOW = 1_700_000_000_000

function issue(overrides: Partial<ActivationClaims> = {}, signWith = privateKey): string {
  const claims: ActivationClaims = {
    v: 1,
    edition: 'professional',
    key: 'RECX-AAAAA-AAAAA-AAAAA-AAAAA',
    machine: MACHINE,
    issuedAt: NOW - 1000,
    expiresAt: null,
    registeredTo: null,
    ...overrides,
  }

  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const signature = sign(null, Buffer.from(payload, 'utf8'), signWith).toString('base64url')

  return `${payload}.${signature}`
}

describe('licence key format', () => {
  /** Nineteen alphabet characters: a key body without its checksum. */
  const BODY = 'ABCDEFGHJKMNPQRSTVW'

  it('accepts a key it generated itself', () => {
    const key = completeKey(BODY)

    expect(key).not.toBeNull()
    expect(validateKey(key ?? '').ok).toBe(true)
  })

  it('catches a single mistyped character', () => {
    // Altering the body, not the formatted string, so the prefix is left
    // alone: changing that produces a different failure entirely.
    const broken = completeKey(`B${BODY.slice(1)}`) ?? ''
    const withOriginalChecksum = broken.slice(0, -1) + (completeKey(BODY) ?? '').slice(-1)

    expect(validateKey(withOriginalChecksum).ok).toBe(false)
    expect(validateKey(withOriginalChecksum).problem).toBe('checksum')
  })

  it('catches two transposed characters', () => {
    // The commonest typing error, and the one a plain sum cannot see — which is
    // why the checksum is position-weighted.
    const body = (completeKey(BODY) ?? '').replace(/-/gu, '').slice(4)
    const swapped = `${body[1] ?? ''}${body[0] ?? ''}${body.slice(2)}`

    expect(validateKey(`RECX${swapped}`).ok).toBe(false)
  })

  it('forgives the characters people confuse when copying', () => {
    // O for zero and I for one are what customers actually type off an invoice.
    // Rejecting those is a support ticket; correcting them is a keystroke.
    const key = completeKey('0123456789ABCDEFGHJ') ?? ''
    const asTyped = key.replace(/0/gu, 'O').replace(/1/gu, 'I').toLowerCase()

    expect(validateKey(asTyped).ok).toBe(true)
    expect(validateKey(asTyped).key).toBe(key)
  })

  it('accepts a key pasted with the wrong spacing', () => {
    const key = completeKey(BODY) ?? ''

    expect(validateKey(key.replace(/-/gu, ' ')).ok).toBe(true)
    expect(validateKey(key.replace(/-/gu, '')).ok).toBe(true)
  })

  it("rejects another product's key", () => {
    expect(validateKey('ACME-ABCDE-ABCDE-ABCDE-ABCDE').problem).toBe('wrong-product')
  })

  it('rejects a key of the wrong length', () => {
    expect(validateKey('RECX-ABCDE').problem).toBe('wrong-length')
  })

  it('rejects an empty key without pretending it is malformed', () => {
    expect(validateKey('   ').problem).toBe('empty')
  })

  it('formats a partly typed key without waiting for the whole thing', () => {
    expect(formatKey('RECXABCDEFG')).toBe('RECX-ABCDE-FG')
  })

  describe('in a key field that reformats on every keystroke', () => {
    /** The field after typing `text` one character at a time. */
    function typed(text: string, from = ''): string[] {
      const seen: string[] = []
      let field = from
      for (const character of text) {
        field = formatKeyAsTyped(field + character)
        seen.push(field)
      }
      return seen
    }

    /** The field after pressing Backspace until it stops changing. */
    function backspaced(from: string): string[] {
      const seen: string[] = []
      let field = from
      while (field.length > 0) {
        const next = formatKeyAsTyped(field.slice(0, -1))
        if (next === field) break
        field = next
        seen.push(field)
      }
      return seen
    }

    const key = completeKey(BODY) ?? ''

    it('leaves the prefix alone while it is being typed', () => {
      expect(typed('RECX-AB')).toEqual(['R', 'RE', 'REC', 'RECX', 'RECX', 'RECX-A', 'RECX-AB'])
    })

    it('ends with the key that was typed, character by character from a receipt', () => {
      const seen = typed(key)

      expect(seen.at(-1)).toBe(key)
      expect(validateKey(seen.at(-1) ?? '').ok).toBe(true)
      expect(seen.some((field) => field.startsWith('RECX-RECX'))).toBe(false)
    })

    it('takes lower case and spaces as typed', () => {
      expect(typed('recx abcde f').at(-1)).toBe('RECX-ABCDE-F')
    })

    it('can be emptied with Backspace', () => {
      const seen = backspaced(formatKeyAsTyped('RECX-AB'))

      expect(seen).toEqual(['RECX-A', 'RECX', 'REC', 'RE', 'R', ''])
    })

    it('still puts the prefix on a key body pasted alone', () => {
      expect(formatKeyAsTyped(BODY)).toBe(formatKey(BODY))
      expect(formatKeyAsTyped(BODY).startsWith('RECX-')).toBe(true)
    })

    it('formats a body that only starts like the prefix once it departs from it', () => {
      expect(formatKeyAsTyped('R')).toBe('R')
      expect(formatKeyAsTyped('RQ')).toBe('RECX-RQ')
      expect(formatKeyAsTyped('RECA')).toBe('RECX-RECA')
    })

    it('treats only the start of the prefix, and nothing, as an unfinished prefix', () => {
      for (const input of ['', ' ', '-', 'r', 'RE', 're c']) {
        expect(isPartialKeyPrefix(input), input).toBe(true)
      }
      for (const input of ['RECX', 'RECX-A', 'RQ', 'ABCDE', 'X']) {
        expect(isPartialKeyPrefix(input), input).toBe(false)
      }
    })
  })

  it('normalises input to the key alphabet', () => {
    expect(normalizeKeyInput(' recx-abc de ')).toBe('RECXABCDE')
  })

  it('hides everything but the last group', () => {
    const masked = maskKey('RECX-ABCDE-FGHJK-MNPQR-STVWX')

    expect(masked).toBe('RECX-•••••-•••••-•••••-STVWX')
    expect(masked).not.toContain('ABCDE')
  })

  it('refuses to complete a payload of the wrong length', () => {
    expect(completeKey('ABC')).toBeNull()
  })

  it('refuses to complete a payload with characters outside the alphabet', () => {
    expect(completeKey(`${BODY.slice(0, 18)}!`)).toBeNull()
  })

  it('produces no checksum for an unusable body', () => {
    expect(checksumCharacter('!!!')).toBe('')
  })
})

describe('activation tokens', () => {
  const options = { publicKey: PUBLIC_KEY, machineId: MACHINE, now: NOW }

  it('accepts a token signed by the vendor for this machine', () => {
    const result = verifyToken(issue(), options)

    expect(result.ok).toBe(true)
    expect(result.ok && result.claims.edition).toBe('professional')
  })

  it('rejects a token signed by someone else', () => {
    // The whole scheme rests on this one check.
    const attacker = generateKeyPairSync('ed25519').privateKey
    const result = verifyToken(issue({ edition: 'enterprise' }, attacker), options)

    expect(result).toEqual({ ok: false, failure: 'bad-signature' })
  })

  it('rejects a token whose claims were edited after signing', () => {
    const original = issue({ edition: 'free' })
    const [, signature] = original.split('.')

    const upgraded = Buffer.from(
      JSON.stringify({ ...decodeTokenClaims(original), edition: 'enterprise' }),
      'utf8',
    ).toString('base64url')

    const result = verifyToken(`${upgraded}.${signature ?? ''}`, options)

    expect(result).toEqual({ ok: false, failure: 'bad-signature' })
  })

  it('rejects a token issued for a different machine', () => {
    // What makes a copied licence file worthless on a second computer.
    const result = verifyToken(issue({ machine: 'OTHER-MACHINE' }), options)

    expect(result).toEqual({ ok: false, failure: 'wrong-machine' })
  })

  it('reports expiry separately from invalidity', () => {
    // An expired licence is a renewal conversation. Telling that customer their
    // licence is "invalid" is both wrong and a good way to lose the renewal.
    const result = verifyToken(issue({ expiresAt: NOW - 1 }), options)

    expect(result).toEqual({ ok: false, failure: 'expired' })
    expect(stateFor('expired')).toBe('expired')
  })

  it('accepts a licence that has not expired yet', () => {
    expect(verifyToken(issue({ expiresAt: NOW + 1 }), options).ok).toBe(true)
  })

  it('treats a perpetual licence as never expiring', () => {
    const distantFuture = { ...options, now: NOW + 100 * 365 * 24 * 60 * 60 * 1000 }

    expect(verifyToken(issue({ expiresAt: null }), distantFuture).ok).toBe(true)
  })

  it('rejects a token issued against a different licence key', () => {
    const result = verifyToken(issue(), { ...options, expectedKey: 'RECX-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' })

    expect(result).toEqual({ ok: false, failure: 'wrong-key' })
  })

  it('trusts nothing when the build carries no public key', () => {
    // A build shipped without its key must give the product away to nobody.
    // Defaulting to trust would give it away to everybody.
    const result = verifyToken(issue(), { ...options, publicKey: '' })

    expect(result).toEqual({ ok: false, failure: 'no-public-key' })
    expect(stateFor('no-public-key')).toBe('unverifiable')
  })

  it('rejects a token with no signature at all', () => {
    const payload = issue().split('.')[0] ?? ''

    expect(verifyToken(payload, options).ok).toBe(false)
    expect(verifyToken(`${payload}.`, options).ok).toBe(false)
  })

  it('rejects an unsigned token that names its own algorithm', () => {
    // The JWT `alg: none` failure, which is why the algorithm is fixed in code
    // rather than read from the token.
    const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url')
    const payload = issue().split('.')[0] ?? ''

    expect(verifyToken(`${payload}.${header}`, options).ok).toBe(false)
  })

  it('rejects rubbish', () => {
    expect(verifyToken('not-a-token', options)).toEqual({ ok: false, failure: 'malformed' })
    expect(verifyToken('', options)).toEqual({ ok: false, failure: 'malformed' })
  })

  it('decodes claims without vouching for them', () => {
    // Used only to tell the customer which licence is failing. The separation
    // is deliberate: no entitlement may ever be derived from this.
    const attacker = generateKeyPairSync('ed25519').privateKey
    const forged = issue({ edition: 'enterprise' }, attacker)

    expect(decodeTokenClaims(forged)?.edition).toBe('enterprise')
    expect(verifyToken(forged, options).ok).toBe(false)
  })

  it('returns nothing for claims that are not the expected shape', () => {
    const payload = Buffer.from(JSON.stringify({ v: 9 }), 'utf8').toString('base64url')

    expect(decodeTokenClaims(`${payload}.x`)).toBeNull()
  })
})

describe('entitlements', () => {
  it('caps only the Free edition', () => {
    expect(entitlementsFor('free').recoveryLimitBytes).toBe(FREE_EDITION_RECOVERY_LIMIT_BYTES)

    for (const edition of LICENSE_EDITIONS) {
      if (edition === 'free') continue
      expect(entitlementsFor(edition).recoveryLimitBytes).toBeNull()
    }
  })

  it('defines every edition the product sells', () => {
    expect(Object.keys(ENTITLEMENTS).sort()).toEqual([...LICENSE_EDITIONS].sort())
  })

  it('does not cap activations for a technician licence', () => {
    // A technician licence travels between customer machines; a seat count is
    // the one limit that would make it useless.
    expect(entitlementsFor('technician').activations).toBeNull()
  })

  it('permits commercial use only where it was sold', () => {
    expect(entitlementsFor('free').commercialUse).toBe(false)
    expect(entitlementsFor('professional').commercialUse).toBe(false)
    expect(entitlementsFor('business').commercialUse).toBe(true)
  })
})

describe('machine identifier', () => {
  it('pulls the GUID out of reg query output', () => {
    const output = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
      '    MachineGuid    REG_SZ    4a5f0b2e-7c31-4f6a-9d2b-0e8c1f3a5b7d',
      '',
    ].join('\r\n')

    expect(extractMachineGuid(output)).toBe('4a5f0b2e-7c31-4f6a-9d2b-0e8c1f3a5b7d')
  })

  it('survives the whitespace varying between Windows versions', () => {
    const output = '\tMachineGuid\tREG_SZ\t4a5f0b2e-7c31-4f6a-9d2b-0e8c1f3a5b7d'

    expect(extractMachineGuid(output)).toBe('4a5f0b2e-7c31-4f6a-9d2b-0e8c1f3a5b7d')
  })

  it('reports nothing rather than the type name when the value is missing', () => {
    // Returning "REG_SZ" would be a machine identifier identical on every
    // computer on earth, which is the worst possible failure here.
    expect(extractMachineGuid('    MachineGuid    REG_SZ')).toBeNull()
    expect(extractMachineGuid('no guid here')).toBeNull()
  })

  it('groups the identifier so it can be read aloud', () => {
    expect(formatMachineId('ABCDEFGHIJKL')).toBe('ABCD-EFGH-IJKL')
  })
})

describe('the Free edition ceiling', () => {
  const LIMIT = FREE_EDITION_RECOVERY_LIMIT_BYTES

  function service(): LicenseService {
    const directory = mkdtempSync(join(tmpdir(), 'recoverx-license-'))
    const paths: AppPaths = {
      userData: directory,
      database: join(directory, 'db.sqlite'),
      logs: join(directory, 'logs'),
      temp: join(directory, 'tmp'),
      defaultRecovery: join(directory, 'recovered'),
    }

    return new LicenseService(paths, silentLogger)
  }

  it('runs as Free when nothing has been activated', async () => {
    const status = await service().status(0)

    expect(status.state).toBe('unlicensed')
    expect(status.edition).toBe('free')
    expect(status.recoveryLimitBytes).toBe(LIMIT)
    expect(status.remainingBytes).toBe(LIMIT)
  })

  it('permits a recovery that fits inside what is left', async () => {
    await expect(service().assertRecoveryAllowed(0, LIMIT)).resolves.toBeUndefined()
  })

  it('refuses a recovery larger than the allowance', async () => {
    await expect(service().assertRecoveryAllowed(0, LIMIT + 1)).rejects.toThrow(/Free edition/iu)
  })

  it('counts what has already been recovered against the allowance', async () => {
    // The ceiling is cumulative, not per job. Charging it per job would let
    // anyone recover a disk one file at a time.
    const licensing = service()

    await expect(licensing.assertRecoveryAllowed(LIMIT - 100, 50)).resolves.toBeUndefined()
    await expect(licensing.assertRecoveryAllowed(LIMIT - 100, 200)).rejects.toThrow()
  })

  it('refuses everything once the allowance is spent', async () => {
    const licensing = service()
    const status = await licensing.status(LIMIT)

    expect(status.remainingBytes).toBe(0)
    await expect(licensing.assertRecoveryAllowed(LIMIT, 1)).rejects.toThrow()
  })

  it('never reports a negative remainder', async () => {
    // Recovering a little over the line — the last file straddles it — must not
    // produce a nonsense figure on the licence screen.
    const status = await service().status(LIMIT + 5000)

    expect(status.remainingBytes).toBe(0)
  })

  it('explains the refusal with the numbers behind it', async () => {
    // A bare "not allowed" leaves the user unable to tell whether to buy a
    // licence or to select fewer files.
    try {
      await service().assertRecoveryAllowed(0, LIMIT * 2)
      expect.unreachable('the recovery should have been refused')
    } catch (error) {
      const details = JSON.parse((error as AppError).details ?? '{}') as Record<string, number>

      expect(details.limitBytes).toBe(LIMIT)
      expect(details.requestedBytes).toBe(LIMIT * 2)
      expect(details.remainingBytes).toBe(LIMIT)
    }
  })

  it('reports a machine identifier the user can quote to support', async () => {
    const status = await service().status(0)

    expect(status.machineId.length).toBeGreaterThan(0)
    expect(status.machineId).toMatch(/^[A-Z0-9_-]+$/u)
  })

  it('leaves no licence key on show before one is entered', async () => {
    expect((await service().status(0)).maskedKey).toBeNull()
  })
})

describe('the deactivation endpoint', () => {
  it('sits beside the activation endpoint', () => {
    expect(deriveDeactivationUrl('https://recoverx.snapkio.com/v1/activate')).toBe(
      'https://recoverx.snapkio.com/v1/deactivate',
    )
  })

  it('keeps the port and drops the query string', () => {
    expect(deriveDeactivationUrl('http://localhost:8787/v1/activate?build=1')).toBe(
      'http://localhost:8787/v1/deactivate',
    )
  })

  it('is not configured when activation is not', () => {
    expect(deriveDeactivationUrl('')).toBe('')
  })

  it('is not configured, rather than fatal, when the activation URL is unusable', () => {
    // Computed at import time in both processes: throwing here would turn a
    // typo in a build variable into an application that cannot start.
    expect(deriveDeactivationUrl('recoverx.snapkio.com/v1/activate')).toBe('')
    expect(deriveDeactivationUrl('not a url')).toBe('')
  })

  it('is derived from the build configuration, never configured apart from it', () => {
    expect(LICENSE_DEACTIVATION_URL).toBe(deriveDeactivationUrl(LICENSE_ACTIVATION_URL))
  })
})

// --- a licence service over a real data folder and a stubbed network ---------

const ENDPOINTS: LicenseEndpoints = {
  activationUrl: 'https://licensing.test/v1/activate',
  deactivationUrl: 'https://licensing.test/v1/deactivate',
}

const KEY = 'RECX-AAAAA-AAAAA-AAAAA-AAAAA'
const TOKEN = issue({ key: KEY })

/** The same seat activated earlier: another token for the same key and machine. */
const SAME_SEAT_EARLIER = issue({ key: KEY, issuedAt: NOW - 50_000 })

/** A seat this licence held under the computer's previous identity, before a rename. */
const OLD_IDENTITY = issue({ key: KEY, machine: 'OLD0-MACH-INE0-IDEN-TITY-0000' })

/** What a test puts in the licence file. */
interface StoredFixture {
  readonly token: string
  readonly key: string
}

function resetBuild(): void {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  build.publicKey = null
  build.machineId = null
}

/**
 * A service with a licence already on disk, and a logger that remembers
 * everything it was told so the tests can check what never reaches a log.
 *
 * Unless a test sets `build`, the build under test carries no public key, so
 * the stored licence reads as `unverifiable` locally. That is deliberate rather
 * than incidental for removal: the seat must be released whatever this machine
 * thinks of the token, because the server is the one holding the seat.
 *
 * `stored` is the stored licence (the default one, another, or none);
 * `directory` reopens an earlier service's data folder, which is how these
 * tests restart the application; `pending` seeds releases left over from an
 * earlier removal.
 */
function licensed(
  options: {
    endpoints?: LicenseEndpoints
    stored?: boolean | StoredFixture
    directory?: string
    pending?: readonly string[]
  } = {},
) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'recoverx-license-'))
  const paths: AppPaths = {
    userData: directory,
    database: join(directory, 'db.sqlite'),
    logs: join(directory, 'logs'),
    temp: join(directory, 'tmp'),
    defaultRecovery: join(directory, 'recovered'),
  }

  const file = join(directory, 'license.json')
  const stored = options.stored ?? true
  if (stored !== false) {
    const fixture = stored === true ? { token: TOKEN, key: KEY } : stored
    writeFileSync(file, JSON.stringify({ ...fixture, activatedAt: NOW }), 'utf8')
  }

  const pendingFile = join(directory, PENDING_RELEASE_FILE)
  if (options.pending !== undefined) {
    writeFileSync(pendingFile, JSON.stringify({ tokens: options.pending }), 'utf8')
  }

  const logged: unknown[] = []
  const record = (message: string, meta?: unknown): void => {
    logged.push({ message, meta })
  }
  const logger: Logger = {
    error: record,
    warn: record,
    info: record,
    debug: record,
    child: () => logger,
  }

  const licensing = new LicenseService(paths, logger, options.endpoints ?? ENDPOINTS)
  return { licensing, file, pendingFile, directory, logged }
}

function respond(status: number, body: string) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    ),
  )
}

function offline() {
  return vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')))
}

/** The tokens still waiting to be released, or `null` when nothing is. */
function waiting(pendingFile: string): unknown {
  if (!existsSync(pendingFile)) return null
  return (JSON.parse(readFileSync(pendingFile, 'utf8')) as { tokens: unknown }).tokens
}

/** The token each release request carried, in the order they were sent. */
function sent(stub: Mock<typeof fetch>): unknown[] {
  return stub.mock.calls.map(
    ([, init]) => (JSON.parse(init?.body as string) as { token: unknown }).token,
  )
}

/** The licence file as stored. */
function storedLicence(file: string): { token: string; key: string; activatedAt: number } {
  return JSON.parse(readFileSync(file, 'utf8')) as {
    token: string
    key: string
    activatedAt: number
  }
}

/**
 * The token is a bearer credential for the seat, and the key is what was paid
 * for; a log is something users attach to email.
 */
function expectNothingSecretLogged(logged: unknown[], ...secrets: string[]): void {
  const text = JSON.stringify(logged)

  for (const secret of [TOKEN, KEY, ...secrets]) {
    expect(text).not.toContain(secret)
  }
}

/** A log entry with this message was written. */
function loggedMessage(logged: unknown[], pattern: RegExp): unknown {
  return logged.find((entry) => pattern.test((entry as { message: string }).message))
}

describe('removing a licence', () => {
  afterEach(resetBuild)

  it('starts with the licence in place', async () => {
    const { licensing, file } = licensed()

    expect(existsSync(file)).toBe(true)
    expect((await licensing.status(0)).maskedKey).not.toBeNull()
  })

  it('releases the seat on the server, then removes the licence', async () => {
    const { licensing, file, pendingFile, logged } = licensed()

    // Checked from inside the request: the release must happen while the token
    // still exists, or an interruption would strand the seat.
    let presentDuringRelease: boolean | null = null
    const fetchStub = vi.fn<typeof fetch>(() => {
      presentDuringRelease = existsSync(file)
      return Promise.resolve(new Response(JSON.stringify({ released: true }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchStub)

    const status = await licensing.deactivate(0)

    expect(fetchStub).toHaveBeenCalledOnce()
    const [url, init] = fetchStub.mock.calls[0] ?? []
    expect(url).toBe(ENDPOINTS.deactivationUrl)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(typeof init?.body).toBe('string')
    expect(JSON.parse(init?.body as string)).toEqual({ token: TOKEN })
    expect(init?.signal).toBeInstanceOf(AbortSignal)

    expect(presentDuringRelease).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(waiting(pendingFile)).toBeNull()
    expect(status.state).toBe('unlicensed')
    expect(status.edition).toBe('free')
    expect(status.maskedKey).toBeNull()
    expectNothingSecretLogged(logged)
  })

  it('treats a seat that was already free as released', async () => {
    const { licensing, file, pendingFile } = licensed()
    vi.stubGlobal('fetch', respond(200, JSON.stringify({ released: false })))

    expect((await licensing.deactivate(0)).state).toBe('unlicensed')
    expect(existsSync(file)).toBe(false)
    expect(waiting(pendingFile)).toBeNull()
  })

  it('removes the licence and lets the seat go when the server refuses it for good', async () => {
    const { licensing, file, pendingFile, logged } = licensed()
    vi.stubGlobal('fetch', respond(403, JSON.stringify({ error: 'This licence has been revoked' })))

    const status = await licensing.deactivate(0)

    expect(status.state).toBe('unlicensed')
    expect(existsSync(file)).toBe(false)
    // Asking again would get the same answer.
    expect(waiting(pendingFile)).toBeNull()
    expectNothingSecretLogged(logged)
  })

  it('removes the licence and keeps the seat to release when the server fails outright', async () => {
    const { licensing, file, pendingFile } = licensed()
    vi.stubGlobal('fetch', respond(502, '<html>Bad gateway</html>'))

    expect((await licensing.deactivate(0)).state).toBe('unlicensed')
    expect(existsSync(file)).toBe(false)
    expect(waiting(pendingFile)).toEqual([TOKEN])
  })

  it('removes the licence and keeps the seat to release when the reply is not the server', async () => {
    // A captive portal answers 200 with its own page.
    const { licensing, file, pendingFile } = licensed()
    vi.stubGlobal('fetch', respond(200, 'not json'))

    expect((await licensing.deactivate(0)).state).toBe('unlicensed')
    expect(existsSync(file)).toBe(false)
    expect(waiting(pendingFile)).toEqual([TOKEN])
  })

  it.each([
    // The website's own "page not found": the licensing rules are missing from .htaccess.
    [404, '<!doctype html><title>Page not found</title>'],
    // A firewall's or CDN's challenge page.
    [403, '<html><body>Checking your browser…</body></html>'],
    [400, ''],
    [410, JSON.stringify({ message: 'Gone' })],
  ])(
    'removes the licence and keeps the seat to release when a %i is not the server’s reply',
    async (status, body) => {
      const { licensing, file, pendingFile, logged } = licensed()
      vi.stubGlobal('fetch', respond(status, body))

      expect((await licensing.deactivate(0)).state).toBe('unlicensed')
      expect(existsSync(file)).toBe(false)
      // The seat is still held on the server; only its own answer can drop it.
      expect(waiting(pendingFile)).toEqual([TOKEN])
      expect(loggedMessage(logged, /unusable reply/u)).toMatchObject({ meta: { status } })
      expectNothingSecretLogged(logged)
    },
  )

  it('removes the licence and keeps the seat to release when rate limited', async () => {
    const { licensing, file, pendingFile } = licensed()
    vi.stubGlobal('fetch', respond(429, JSON.stringify({ error: 'Too many activation attempts' })))

    expect((await licensing.deactivate(0)).state).toBe('unlicensed')
    expect(existsSync(file)).toBe(false)
    expect(waiting(pendingFile)).toEqual([TOKEN])
  })

  it('removes the licence on a machine with no network, keeping the seat to release', async () => {
    // The commonest case of all for a recovery tool: the customer is offline.
    const { licensing, file, pendingFile, logged } = licensed()
    vi.stubGlobal('fetch', offline())

    expect((await licensing.deactivate(0)).state).toBe('unlicensed')
    expect(existsSync(file)).toBe(false)
    expect(waiting(pendingFile)).toEqual([TOKEN])
    expectNothingSecretLogged(logged)
  })

  it('stops waiting for a server that never answers', async () => {
    const { licensing, file, pendingFile } = licensed()

    // Resolve the machine identifier on real timers first; only the release
    // itself should run against the fake clock.
    await licensing.status(0)

    let aborted = false
    const fetchStub = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('The operation was aborted'))
          })
        }),
    )
    vi.stubGlobal('fetch', fetchStub)
    vi.useFakeTimers()

    const pending = licensing.deactivate(0)
    await vi.advanceTimersByTimeAsync(DEACTIVATION_TIMEOUT_MS)
    const status = await pending

    expect(fetchStub).toHaveBeenCalledOnce()
    expect(aborted).toBe(true)
    expect(status.state).toBe('unlicensed')
    expect(existsSync(file)).toBe(false)
    expect(waiting(pendingFile)).toEqual([TOKEN])
  })

  it('sends nothing when the build has no licence server', async () => {
    const { licensing, file, pendingFile } = licensed({
      endpoints: { activationUrl: '', deactivationUrl: '' },
    })
    const fetchStub = respond(200, JSON.stringify({ released: true }))
    vi.stubGlobal('fetch', fetchStub)

    expect((await licensing.deactivate(0)).state).toBe('unlicensed')
    expect(fetchStub).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
    // Nothing this build does could ever release it, so nothing is kept.
    expect(waiting(pendingFile)).toBeNull()
  })

  it('sends nothing when there is no licence to release', async () => {
    const { licensing } = licensed({ stored: false })
    const fetchStub = respond(200, JSON.stringify({ released: true }))
    vi.stubGlobal('fetch', fetchStub)

    expect((await licensing.deactivate(0)).state).toBe('unlicensed')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('keeps the licence when its seat can neither be released nor kept for later', async () => {
    const { licensing, file, pendingFile } = licensed()
    // A folder where the file belongs: every attempt to write it fails.
    mkdirSync(pendingFile)
    vi.stubGlobal('fetch', offline())

    await expect(licensing.deactivate(0)).rejects.toThrow('The licence could not be removed')
    expect(existsSync(file)).toBe(true)
    expect((await licensing.status(0)).maskedKey).not.toBeNull()
  })

  it('retries only what might be answered differently later', () => {
    for (const status of [400, 401, 403, 404, 409, 410, 413]) {
      expect(isDefinitiveRefusal(status)).toBe(true)
    }
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isDefinitiveRefusal(status)).toBe(false)
    }
  })

  describe('when the server keeps the licence on this computer', () => {
    // The licence server's own sentence for the self-service cap on moves.
    const KEPT =
      'This licence has already been moved between computers 4 times in the last 12 months. It is still active on this computer. To move it again, contact info@appsgain.in with your licence key.'

    async function refusal(licensing: LicenseService): Promise<unknown> {
      try {
        await licensing.deactivate(0)
      } catch (error) {
        return error
      }
      return expect.unreachable('the removal should have been refused')
    }

    it('keeps the licence and says why, in the server’s words', async () => {
      const { licensing, file, pendingFile, logged } = licensed()
      const before = readFileSync(file, 'utf8')
      const fetchStub = respond(409, JSON.stringify({ error: KEPT }))
      vi.stubGlobal('fetch', fetchStub)

      const error = await refusal(licensing)

      // Shown by the Licence screen's error toast as it is.
      expect(error).toBeInstanceOf(AppError)
      expect(error).toMatchObject({
        code: ErrorCode.Validation,
        message: KEPT,
        retryable: false,
      })
      expect(fetchStub).toHaveBeenCalledOnce()
      expect(readFileSync(file, 'utf8')).toBe(before)
      // Asking again would get the same answer, and the seat is this computer's.
      expect(waiting(pendingFile)).toBeNull()
      expect((await licensing.status(0)).maskedKey).not.toBeNull()
      expectNothingSecretLogged(logged)
    })

    it('takes a 409 without the server’s sentence for something else answering', async () => {
      // A proxy's or the host's page is no verdict on the seat: the licence is
      // removed as for an unanswered release, and the seat kept to release.
      const { licensing, file, pendingFile } = licensed()
      vi.stubGlobal('fetch', respond(409, '<html>Conflict</html>'))

      expect((await licensing.deactivate(0)).state).toBe('unlicensed')
      expect(existsSync(file)).toBe(false)
      expect(waiting(pendingFile)).toEqual([TOKEN])
    })

    it('leaves earlier releases waiting as they were', async () => {
      const { licensing, pendingFile } = licensed({ pending: [OLD_IDENTITY] })
      const fetchStub = respond(409, JSON.stringify({ error: KEPT }))
      vi.stubGlobal('fetch', fetchStub)

      await refusal(licensing)

      expect(sent(fetchStub)).toEqual([TOKEN])
      expect(waiting(pendingFile)).toEqual([OLD_IDENTITY])
    })

    it('can still be removed once the server agrees', async () => {
      const { licensing, file } = licensed()
      vi.stubGlobal('fetch', respond(409, JSON.stringify({ error: KEPT })))
      await refusal(licensing)

      vi.stubGlobal('fetch', respond(200, JSON.stringify({ released: true })))

      expect((await licensing.deactivate(0)).state).toBe('unlicensed')
      expect(existsSync(file)).toBe(false)
    })
  })

  describe('when the seat could not be released at the time', () => {
    it('releases it at the next start-up', async () => {
      const first = licensed()
      vi.stubGlobal('fetch', offline())
      await first.licensing.deactivate(0)
      expect(waiting(first.pendingFile)).toEqual([TOKEN])

      const fetchStub = respond(200, JSON.stringify({ released: true }))
      vi.stubGlobal('fetch', fetchStub)
      const restarted = licensed({ directory: first.directory, stored: false })
      restarted.licensing.warmUp()

      await vi.waitFor(() => {
        expect(waiting(restarted.pendingFile)).toBeNull()
      })
      expect(fetchStub).toHaveBeenCalledOnce()
      expect(fetchStub.mock.calls[0]?.[0]).toBe(ENDPOINTS.deactivationUrl)
      expect(sent(fetchStub)).toEqual([TOKEN])
      expectNothingSecretLogged(restarted.logged)
    })

    it('keeps waiting while the server is out of reach, without trying the rest', async () => {
      const { licensing, pendingFile } = licensed({
        stored: false,
        pending: [TOKEN, OLD_IDENTITY],
      })
      const fetchStub = respond(503, JSON.stringify({ error: 'The licence server is busy.' }))
      vi.stubGlobal('fetch', fetchStub)

      await licensing.retryPendingReleases()

      expect(fetchStub).toHaveBeenCalledOnce()
      expect(waiting(pendingFile)).toEqual([TOKEN, OLD_IDENTITY])
    })

    it('gives up on a release the server refuses for good', async () => {
      const { licensing, pendingFile } = licensed({ stored: false, pending: [TOKEN] })
      vi.stubGlobal(
        'fetch',
        respond(400, JSON.stringify({ error: 'That activation is unreadable' })),
      )

      await licensing.retryPendingReleases()

      expect(waiting(pendingFile)).toBeNull()
    })

    it('keeps waiting while something other than the server answers, without trying the rest', async () => {
      const { licensing, pendingFile } = licensed({
        stored: false,
        pending: [TOKEN, OLD_IDENTITY],
      })
      const fetchStub = respond(404, '<!doctype html><title>Page not found</title>')
      vi.stubGlobal('fetch', fetchStub)

      await licensing.retryPendingReleases()

      expect(fetchStub).toHaveBeenCalledOnce()
      expect(waiting(pendingFile)).toEqual([TOKEN, OLD_IDENTITY])
    })

    it('drops a release the server keeps under its limit on moves, and says so in the log', async () => {
      // The licence it belonged to is already gone from this computer; there
      // is nothing here to keep, and the answer will not change for a year.
      const { licensing, pendingFile, logged } = licensed({
        stored: false,
        pending: [TOKEN, OLD_IDENTITY],
      })
      const fetchStub = vi.fn<typeof fetch>((_input, init) => {
        const { token } = JSON.parse(init?.body as string) as { token: string }
        return Promise.resolve(
          token === TOKEN
            ? new Response(JSON.stringify({ error: 'Moved too often.' }), { status: 409 })
            : new Response(JSON.stringify({ released: true }), { status: 200 }),
        )
      })
      vi.stubGlobal('fetch', fetchStub)

      await licensing.retryPendingReleases()

      // An answer, not an outage: the rest of the queue is still worked through.
      expect(sent(fetchStub)).toEqual([TOKEN, OLD_IDENTITY])
      expect(waiting(pendingFile)).toBeNull()
      expect(loggedMessage(logged, /will not be retried/u)).toMatchObject({
        meta: { dropped: 1 },
      })
      expectNothingSecretLogged(logged, OLD_IDENTITY)

      // Not asked again at the next start-up.
      await licensing.retryPendingReleases()
      expect(fetchStub).toHaveBeenCalledTimes(2)
    })

    it('never releases a seat this computer holds again', async () => {
      // The licence file names the same key and machine again — re-activated,
      // or a removal interrupted before the file went. That seat is in use.
      const { licensing, pendingFile } = licensed({ pending: [SAME_SEAT_EARLIER, OLD_IDENTITY] })
      const fetchStub = respond(200, JSON.stringify({ released: true }))
      vi.stubGlobal('fetch', fetchStub)

      await licensing.retryPendingReleases()

      expect(sent(fetchStub)).toEqual([OLD_IDENTITY])
      expect(waiting(pendingFile)).toBeNull()
    })

    it('settles them once the server answers a later removal', async () => {
      const { licensing, file, pendingFile } = licensed({ pending: [OLD_IDENTITY] })
      const fetchStub = respond(200, JSON.stringify({ released: true }))
      vi.stubGlobal('fetch', fetchStub)

      await licensing.deactivate(0)

      // The licence being removed goes first: it is the one the customer is waiting on.
      expect(sent(fetchStub)).toEqual([TOKEN, OLD_IDENTITY])
      expect(existsSync(file)).toBe(false)
      expect(waiting(pendingFile)).toBeNull()
    })

    it('frees the seat of an earlier identity before activating under the new one', async () => {
      // A renamed computer: removed while offline under its old identity, now
      // activating the same key under its new one. The release has to reach the
      // server first, or a one-seat licence is refused as already in use.
      build.publicKey = PUBLIC_KEY
      build.machineId = MACHINE
      const key = completeKey('A'.repeat(19)) ?? ''
      const before = issue({ key, machine: 'OLD0-MACH-INE0-IDEN-TITY-0000' })
      const after = issue({ key })
      const { licensing, pendingFile } = licensed({ stored: false, pending: [before] })

      const fetchStub = vi.fn<typeof fetch>((input) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              input === ENDPOINTS.deactivationUrl ? { released: true } : { token: after },
            ),
            { status: 200 },
          ),
        ),
      )
      vi.stubGlobal('fetch', fetchStub)

      const status = await licensing.activate({ key })

      expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
        ENDPOINTS.deactivationUrl,
        ENDPOINTS.activationUrl,
      ])
      expect(status.state).toBe('active')
      expect(waiting(pendingFile)).toBeNull()
    })

    it('forgets a release for the seat an offline activation takes back', async () => {
      build.publicKey = PUBLIC_KEY
      build.machineId = MACHINE
      const { licensing, pendingFile } = licensed({
        stored: false,
        pending: [SAME_SEAT_EARLIER, OLD_IDENTITY],
      })
      const fetchStub = respond(200, JSON.stringify({ released: true }))
      vi.stubGlobal('fetch', fetchStub)

      const status = await licensing.activateOffline({ token: TOKEN })

      expect(status.state).toBe('active')
      // Releasing it later would free the seat this activation now holds.
      expect(waiting(pendingFile)).toEqual([OLD_IDENTITY])
      expect(fetchStub).not.toHaveBeenCalled()
    })
  })
})

describe('replacing the stored licence with another', () => {
  /** A second licence key, and a valid one, so it can be activated online too. */
  const OTHER_KEY = completeKey('B'.repeat(19)) ?? ''
  const OTHER = issue({ key: OTHER_KEY })

  beforeEach(() => {
    build.publicKey = PUBLIC_KEY
    build.machineId = MACHINE
  })

  afterEach(resetBuild)

  /**
   * Wait for the release an activation leaves running behind it.
   *
   * It is queued behind the activation on the seat lock, so a retry queued
   * after it runs once it is done — and, with nothing left owed, sends nothing
   * of its own.
   */
  async function settled(licensing: LicenseService): Promise<void> {
    await licensing.retryPendingReleases()
  }

  it('releases the seat of the key it replaces, once the new licence is stored', async () => {
    const { licensing, file, pendingFile, logged } = licensed()

    let storedDuringRelease: string | null = null
    const fetchStub = vi.fn<typeof fetch>((input) => {
      if (input === ENDPOINTS.activationUrl) {
        return Promise.resolve(new Response(JSON.stringify({ token: OTHER }), { status: 200 }))
      }
      storedDuringRelease = storedLicence(file).token
      return Promise.resolve(new Response(JSON.stringify({ released: true }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchStub)

    const status = await licensing.activate({ key: OTHER_KEY })
    await settled(licensing)

    expect(status.state).toBe('active')
    expect(status.maskedKey).toBe(maskKey(OTHER_KEY))
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
      ENDPOINTS.activationUrl,
      ENDPOINTS.deactivationUrl,
    ])
    expect(JSON.parse(fetchStub.mock.calls[1]?.[1]?.body as string)).toEqual({ token: TOKEN })
    // The old seat goes only once the new licence is in place.
    expect(storedDuringRelease).toBe(OTHER)
    expect(storedLicence(file).token).toBe(OTHER)
    expect(waiting(pendingFile)).toBeNull()
    expectNothingSecretLogged(logged, OTHER, OTHER_KEY)
  })

  /** Activation answers with `OTHER`; every release is unanswered. */
  function activationOnly() {
    return vi.fn<typeof fetch>((input) =>
      input === ENDPOINTS.activationUrl
        ? Promise.resolve(new Response(JSON.stringify({ token: OTHER }), { status: 200 }))
        : Promise.reject(new TypeError('fetch failed')),
    )
  }

  /** The token each release request carried, ignoring activation requests. */
  function released(stub: Mock<typeof fetch>): unknown[] {
    return stub.mock.calls
      .filter(([url]) => url === ENDPOINTS.deactivationUrl)
      .map(([, init]) => (JSON.parse(init?.body as string) as { token: unknown }).token)
  }

  /**
   * Let anything an activation left running behind it reach the network.
   *
   * Unlike `settled`, asks for nothing itself: a release the activation
   * started would call `fetch` within microtasks of taking the seat lock.
   */
  async function quiet(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('keeps the old seat to release later when the server cannot be reached', async () => {
    const { licensing, file, pendingFile } = licensed()
    const fetchStub = activationOnly()
    vi.stubGlobal('fetch', fetchStub)

    const status = await licensing.activate({ key: OTHER_KEY })
    await settled(licensing)

    expect(status.state).toBe('active')
    expect(storedLicence(file).token).toBe(OTHER)
    expect(new Set(released(fetchStub))).toEqual(new Set([TOKEN]))
    expect(waiting(pendingFile)).toEqual([TOKEN])

    // Released the next time the server answers.
    vi.stubGlobal('fetch', respond(200, JSON.stringify({ released: true })))
    await licensing.retryPendingReleases()

    expect(waiting(pendingFile)).toBeNull()
    expect(storedLicence(file).token).toBe(OTHER)
  })

  it('sends nothing for an offline activation, and releases the old seat at the next start-up', async () => {
    // The privacy policy: "If you activate offline, nothing is sent by the app."
    const { licensing, file, pendingFile, logged } = licensed()
    const fetchStub = respond(200, JSON.stringify({ released: true }))
    vi.stubGlobal('fetch', fetchStub)

    const status = await licensing.activateOffline({ token: OTHER })
    await quiet()

    expect(status.state).toBe('active')
    expect(storedLicence(file).token).toBe(OTHER)
    expect(fetchStub).not.toHaveBeenCalled()
    // Set aside exactly as a removal made offline would be.
    expect(waiting(pendingFile)).toEqual([TOKEN])
    expect(loggedMessage(logged, /when RecoverX next starts/u)).toBeDefined()

    // What start-up does.
    await licensing.retryPendingReleases()

    expect(sent(fetchStub)).toEqual([TOKEN])
    expect(waiting(pendingFile)).toBeNull()
    expect(storedLicence(file).token).toBe(OTHER)
    expectNothingSecretLogged(logged, OTHER, OTHER_KEY)
  })

  it('releases the seat the same key held under the computer’s previous identity', async () => {
    // A renamed computer reads "Different computer"; the customer pastes an
    // emailed activation code for its new identity.
    const { licensing, file, pendingFile } = licensed({
      stored: { token: OLD_IDENTITY, key: KEY },
    })
    expect((await licensing.status(0)).state).toBe('machine-mismatch')
    const fetchStub = respond(200, JSON.stringify({ released: true }))
    vi.stubGlobal('fetch', fetchStub)

    expect((await licensing.activateOffline({ token: TOKEN })).state).toBe('active')
    await quiet()

    expect(fetchStub).not.toHaveBeenCalled()
    expect(waiting(pendingFile)).toEqual([OLD_IDENTITY])

    await licensing.retryPendingReleases()

    expect(sent(fetchStub)).toEqual([OLD_IDENTITY])
    expect(storedLicence(file).token).toBe(TOKEN)
    expect(waiting(pendingFile)).toBeNull()
  })

  it('releases nothing when the same seat is activated again', async () => {
    // Another token for the same key on the same machine is this seat, still
    // in use; releasing it would free the seat from under the new licence.
    const { licensing, file, pendingFile } = licensed({
      stored: { token: SAME_SEAT_EARLIER, key: KEY },
    })
    const fetchStub = respond(200, JSON.stringify({ released: true }))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.activateOffline({ token: TOKEN })
    await settled(licensing)

    expect(fetchStub).not.toHaveBeenCalled()
    expect(storedLicence(file).token).toBe(TOKEN)
    expect(waiting(pendingFile)).toBeNull()
  })

  it('passes on the server’s refusal of the key, and nothing else’s', async () => {
    const { licensing, file } = licensed()

    vi.stubGlobal('fetch', respond(404, '<!doctype html><title>Page not found</title>'))
    await expect(licensing.activate({ key: OTHER_KEY })).rejects.toMatchObject({
      code: ErrorCode.Io,
      message: 'The activation service returned an unusable response',
      retryable: true,
    })

    vi.stubGlobal('fetch', respond(404, JSON.stringify({ error: 'We could not find that key.' })))
    await expect(licensing.activate({ key: OTHER_KEY })).rejects.toMatchObject({
      code: ErrorCode.Validation,
      message: 'We could not find that key.',
      retryable: false,
    })

    expect(storedLicence(file).token).toBe(TOKEN)
  })

  it('keeps the new licence when the server will not release the old seat', async () => {
    const { licensing, file, pendingFile } = licensed()
    vi.stubGlobal('fetch', respond(409, JSON.stringify({ error: 'Moved too often.' })))

    await licensing.activateOffline({ token: OTHER })
    await settled(licensing)

    expect((await licensing.status(0)).state).toBe('active')
    expect(storedLicence(file).token).toBe(OTHER)
    // Nothing to keep: the old licence is no longer on this computer.
    expect(waiting(pendingFile)).toBeNull()
  })

  it('is never held up by the old seat, even when it cannot be kept for later', async () => {
    const { licensing, file, pendingFile } = licensed()
    // A folder where the file belongs: every attempt to write it fails.
    mkdirSync(pendingFile)
    const fetchStub = activationOnly()
    vi.stubGlobal('fetch', fetchStub)

    const status = await licensing.activate({ key: OTHER_KEY })
    await settled(licensing)

    expect(status.state).toBe('active')
    expect(storedLicence(file).token).toBe(OTHER)
    // One attempt, since there is nowhere to keep it for another.
    expect(released(fetchStub)).toEqual([TOKEN])
  })

  it('sends nothing for an offline activation even when the old seat cannot be kept', async () => {
    const { licensing, file, pendingFile, logged } = licensed()
    mkdirSync(pendingFile)
    const fetchStub = offline()
    vi.stubGlobal('fetch', fetchStub)

    const status = await licensing.activateOffline({ token: OTHER })
    await settled(licensing)

    expect(status.state).toBe('active')
    expect(storedLicence(file).token).toBe(OTHER)
    expect(fetchStub).not.toHaveBeenCalled()
    expect(loggedMessage(logged, /replaced could not be released/u)).toBeDefined()
  })

  it('keeps nothing to release when the build has no licence server', async () => {
    const { licensing, pendingFile } = licensed({
      endpoints: { activationUrl: '', deactivationUrl: '' },
    })
    const fetchStub = respond(200, JSON.stringify({ released: true }))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.activateOffline({ token: OTHER })
    await settled(licensing)

    expect(fetchStub).not.toHaveBeenCalled()
    expect(waiting(pendingFile)).toBeNull()
  })

  it('leaves the stored licence and its seat alone when the new activation fails', async () => {
    const { licensing, file, pendingFile } = licensed()
    const fetchStub = respond(404, JSON.stringify({ error: 'We could not find that licence key.' }))
    vi.stubGlobal('fetch', fetchStub)

    await expect(licensing.activate({ key: OTHER_KEY })).rejects.toThrow(
      'We could not find that licence key.',
    )
    const attacker = generateKeyPairSync('ed25519').privateKey
    await expect(
      licensing.activateOffline({ token: issue({ key: OTHER_KEY }, attacker) }),
    ).rejects.toThrow('That activation code is not genuine')
    await settled(licensing)

    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([ENDPOINTS.activationUrl])
    expect(storedLicence(file).token).toBe(TOKEN)
    expect(waiting(pendingFile)).toBeNull()
  })
})

describe('picking up a renewal', () => {
  const DAY = 24 * 60 * 60 * 1000

  /** A valid key: the check asks the server about the stored key by name. */
  const RENEW_KEY = completeKey('C'.repeat(19)) ?? ''

  beforeEach(() => {
    build.publicKey = PUBLIC_KEY
    build.machineId = MACHINE
  })

  afterEach(resetBuild)

  /** A genuine token for the stored key on this machine, ending at `expiresAt`. */
  function term(expiresAt: number | null, overrides: Partial<ActivationClaims> = {}): string {
    return issue({ key: RENEW_KEY, expiresAt, ...overrides })
  }

  function renewing(token: string, endpoints: LicenseEndpoints = ENDPOINTS) {
    return licensed({ stored: { token, key: RENEW_KEY }, endpoints })
  }

  /** The activation endpoint answering with this token. */
  function issues(token: string) {
    return respond(200, JSON.stringify({ token }))
  }

  /** The activation endpoint answering successive requests with these tokens, in turn. */
  function issuesInTurn(...tokens: string[]) {
    const queue = [...tokens]
    return vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: queue.shift() ?? '' }), { status: 200 }),
      ),
    )
  }

  it('stores a later term at start-up once the licence has expired', async () => {
    const expired = term(Date.now() - DAY)
    const renewed = term(Date.now() + 365 * DAY)
    const { licensing, file, logged } = renewing(expired)
    const fetchStub = issues(renewed)
    vi.stubGlobal('fetch', fetchStub)

    licensing.warmUp()

    await vi.waitFor(() => {
      expect(storedLicence(file).token).toBe(renewed)
    })

    const status = await licensing.status(0)
    expect(status.state).toBe('active')
    expect(status.expiresAt).toBe(decodeTokenClaims(renewed)?.expiresAt)
    // The customer activated this computer once; a renewal does not move that.
    expect(status.activatedAt).toBe(NOW)

    // One request, to activate the same key on the same machine: no seat released.
    expect(fetchStub).toHaveBeenCalledOnce()
    const [url, init] = fetchStub.mock.calls[0] ?? []
    expect(url).toBe(ENDPOINTS.activationUrl)
    expect(JSON.parse(init?.body as string)).toEqual({
      key: RENEW_KEY,
      machineId: MACHINE,
      product: 'recoverx',
    })
    expectNothingSecretLogged(logged, RENEW_KEY, expired, renewed)
  })

  it('asks when an active licence runs out within two weeks', async () => {
    const renewed = term(Date.now() + 368 * DAY)
    const { licensing, file } = renewing(term(Date.now() + 3 * DAY))
    vi.stubGlobal('fetch', issues(renewed))

    await licensing.renewIfDue()

    expect(storedLicence(file).token).toBe(renewed)
  })

  it('still asks in the month after the licence ended', async () => {
    const renewed = term(Date.now() + 365 * DAY)
    const { licensing, file } = renewing(term(Date.now() - RENEWAL_GRACE_MS + DAY))
    vi.stubGlobal('fetch', issues(renewed))

    await licensing.renewIfDue()

    expect(storedLicence(file).token).toBe(renewed)
  })

  it('stops asking at start-up once the licence has been over for a month', async () => {
    // A lapsed installation carrying on as Free would otherwise put a refused
    // request on every launch for ever, each one using the network's share of
    // the server's rate limit and adding to its history.
    const { licensing, file } = renewing(term(Date.now() - RENEWAL_GRACE_MS - DAY))
    const before = readFileSync(file, 'utf8')
    const fetchStub = respond(403, JSON.stringify({ error: 'This licence ended long ago.' }))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.renewIfDue()

    expect(fetchStub).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await licensing.status(0)).state).toBe('expired')
  })

  it('keeps asking for exactly the 30 days the Licence screen promises', () => {
    // "RecoverX looks for a renewal when it starts, until 30 days after the end
    // date" — the hint beside "Check for renewal", in both locales.
    expect(RENEWAL_GRACE_MS).toBe(30 * DAY)
  })

  it('does not ask while the end is further off', async () => {
    const { licensing } = renewing(term(Date.now() + RENEWAL_WINDOW_MS + DAY))
    const fetchStub = issues(term(Date.now() + 400 * DAY))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.renewIfDue()

    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('does not ask about a perpetual licence', async () => {
    const { licensing } = renewing(term(null))
    const fetchStub = issues(term(null, { edition: 'business' }))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.renewIfDue()

    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('keeps the stored licence when the server issues the same term again', async () => {
    // What the server does for a licence nobody has renewed yet.
    const expiresAt = Date.now() + 3 * DAY
    const { licensing, file } = renewing(term(expiresAt))
    const before = readFileSync(file, 'utf8')
    const fetchStub = issues(term(expiresAt, { issuedAt: NOW }))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.renewIfDue()

    expect(fetchStub).toHaveBeenCalledOnce()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('keeps the stored licence when the server issues a shorter term', async () => {
    const { licensing, file } = renewing(term(Date.now() + 10 * DAY))
    const before = readFileSync(file, 'utf8')
    vi.stubGlobal('fetch', issues(term(Date.now() + 5 * DAY)))

    await licensing.renewIfDue()

    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('takes an upgrade to another edition on the same term', async () => {
    const expiresAt = Date.now() + 3 * DAY
    const upgraded = term(expiresAt, { edition: 'business' })
    const { licensing, file } = renewing(term(expiresAt))
    vi.stubGlobal('fetch', issues(upgraded))

    await licensing.renewIfDue()

    expect(storedLicence(file).token).toBe(upgraded)
    expect((await licensing.status(0)).edition).toBe('business')
  })

  const attacker = generateKeyPairSync('ed25519').privateKey

  it.each<[string, () => string]>([
    ['not genuine', () => term(Date.now() + 400 * DAY).replace(/\..*$/u, '.AAAA')],
    ['signed by someone else', () => issue({ key: RENEW_KEY, expiresAt: null }, attacker)],
    ['for another computer', () => term(Date.now() + 400 * DAY, { machine: 'OTHER-MACHINE' })],
    [
      'for another key',
      () => issue({ key: completeKey('D'.repeat(19)) ?? '', expiresAt: Date.now() + 400 * DAY }),
    ],
    ['already over', () => term(Date.now() - 1)],
    ['unreadable', () => 'not-a-token'],
  ])('ignores a token that is %s', async (_label, token) => {
    const { licensing, file } = renewing(term(Date.now() - DAY))
    const before = readFileSync(file, 'utf8')
    vi.stubGlobal('fetch', issues(token()))

    await licensing.renewIfDue()

    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await licensing.status(0)).state).toBe('expired')
  })

  it.each<[string, () => Mock<typeof fetch>]>([
    ['offline', () => offline()],
    [
      'refusing',
      () => respond(403, JSON.stringify({ error: 'This licence ended on 1 November 2026.' })),
    ],
    ['busy', () => respond(503, JSON.stringify({ error: 'The licence server is busy.' }))],
    ['replaced by a captive portal', () => respond(200, '<html>Sign in to the Wi-Fi</html>')],
  ])('changes nothing when the server is %s', async (_label, server) => {
    const { licensing, file, pendingFile } = renewing(term(Date.now() - DAY))
    const before = readFileSync(file, 'utf8')
    const fetchStub = server()
    vi.stubGlobal('fetch', fetchStub)

    await expect(licensing.renewIfDue()).resolves.toBeUndefined()

    expect(fetchStub).toHaveBeenCalledOnce()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(waiting(pendingFile)).toBeNull()
  })

  it('asks only once per run of the application, whatever the answer', async () => {
    const { licensing } = renewing(term(Date.now() - DAY))
    const fetchStub = offline()
    vi.stubGlobal('fetch', fetchStub)

    await licensing.renewIfDue()
    await licensing.renewIfDue()

    expect(fetchStub).toHaveBeenCalledOnce()
  })

  it('stops waiting for a server that never answers', async () => {
    const { licensing, file } = renewing(term(Date.now() - DAY))
    const before = readFileSync(file, 'utf8')

    // Resolve the machine identifier on real timers first.
    await licensing.status(0)

    let aborted = false
    const fetchStub = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('The operation was aborted'))
          })
        }),
    )
    vi.stubGlobal('fetch', fetchStub)
    vi.useFakeTimers()

    const pending = licensing.renewIfDue()
    // The shorter start-up deadline, not the one for an activation.
    await vi.advanceTimersByTimeAsync(RENEWAL_CHECK_TIMEOUT_MS)
    await pending

    expect(aborted).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('asks nothing without a licence server', async () => {
    const { licensing } = renewing(term(Date.now() - DAY), {
      activationUrl: '',
      deactivationUrl: '',
    })
    const fetchStub = issues(term(Date.now() + 365 * DAY))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.renewIfDue()

    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('asks nothing when no licence is stored', async () => {
    const { licensing } = licensed({ stored: false })
    const fetchStub = issues(term(Date.now() + 365 * DAY))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.renewIfDue()

    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('asks nothing about an activation for another computer', async () => {
    // That needs activating again, not renewing.
    const { licensing } = renewing(term(Date.now() - DAY, { machine: 'OTHER-MACHINE' }))
    expect((await licensing.status(0)).state).toBe('machine-mismatch')
    const fetchStub = issues(term(Date.now() + 365 * DAY))
    vi.stubGlobal('fetch', fetchStub)

    await licensing.renewIfDue()

    expect(fetchStub).not.toHaveBeenCalled()
  })

  describe('when the customer asks from the Licence screen', () => {
    it('reports a renewal it found and stores it', async () => {
      const renewed = term(Date.now() + 365 * DAY)
      const { licensing, file } = renewing(term(Date.now() - DAY))
      vi.stubGlobal('fetch', issues(renewed))

      const check = await licensing.checkForRenewal(0)

      expect(check.renewed).toBe(true)
      expect(check.status.state).toBe('active')
      expect(check.status.expiresAt).toBe(decodeTokenClaims(renewed)?.expiresAt)
      expect(storedLicence(file).token).toBe(renewed)
    })

    it('reports that there is nothing newer', async () => {
      const expiresAt = Date.now() + 3 * DAY
      const { licensing, file } = renewing(term(expiresAt))
      const before = readFileSync(file, 'utf8')
      vi.stubGlobal('fetch', issues(term(expiresAt, { issuedAt: NOW })))

      const check = await licensing.checkForRenewal(0)

      expect(check.renewed).toBe(false)
      expect(check.status.state).toBe('active')
      expect(readFileSync(file, 'utf8')).toBe(before)
    })

    it('passes on the server’s reason when there is no renewal', async () => {
      const { licensing, file } = renewing(term(Date.now() - DAY))
      const before = readFileSync(file, 'utf8')
      vi.stubGlobal(
        'fetch',
        respond(403, JSON.stringify({ error: 'This licence ended on 1 November 2026.' })),
      )

      await expect(licensing.checkForRenewal(0)).rejects.toMatchObject({
        code: ErrorCode.Validation,
        message: 'This licence ended on 1 November 2026.',
      })
      expect(readFileSync(file, 'utf8')).toBe(before)
    })

    it('says when the server cannot be reached', async () => {
      const { licensing } = renewing(term(Date.now() - DAY))
      vi.stubGlobal('fetch', offline())

      await expect(licensing.checkForRenewal(0)).rejects.toMatchObject({
        code: ErrorCode.Io,
        message: 'The activation service could not be reached',
      })
    })

    it('asks however long ago the licence ended', async () => {
      const renewed = term(Date.now() + 365 * DAY)
      const { licensing, file } = renewing(term(Date.now() - 400 * DAY))
      const fetchStub = issues(renewed)
      vi.stubGlobal('fetch', fetchStub)

      // Too long ago for start-up to ask; the customer who has just paid can.
      await licensing.renewIfDue()
      const check = await licensing.checkForRenewal(0)

      expect(fetchStub).toHaveBeenCalledOnce()
      expect(check.renewed).toBe(true)
      expect(storedLicence(file).token).toBe(renewed)
    })

    it('reports a renewal the start-up check stored while this check waited for it', async () => {
      const expiresAt = Date.now() + 365 * DAY
      const renewed = term(expiresAt)
      const { licensing, file } = renewing(term(Date.now() - DAY))
      // The server answers both requests with the renewed term.
      const fetchStub = issuesInTurn(renewed, term(expiresAt, { issuedAt: NOW + 5_000 }))
      vi.stubGlobal('fetch', fetchStub)

      // The Licence screen, opened during start-up, shows the licence expired.
      expect((await licensing.status(0)).state).toBe('expired')

      const startUp = licensing.renewIfDue()
      const check = licensing.checkForRenewal(0)
      await startUp

      await expect(check).resolves.toMatchObject({
        renewed: true,
        status: { state: 'active', expiresAt },
      })
      expect(fetchStub).toHaveBeenCalledTimes(2)
      expect(storedLicence(file).token).toBe(renewed)
    })

    it('reports a renewal the start-up check stored before the customer asked, once', async () => {
      const expiresAt = Date.now() + 365 * DAY
      const renewed = term(expiresAt)
      const { licensing } = renewing(term(Date.now() - DAY))
      expect((await licensing.status(0)).state).toBe('expired')
      vi.stubGlobal(
        'fetch',
        issuesInTurn(
          renewed,
          term(expiresAt, { issuedAt: NOW + 5_000 }),
          term(expiresAt, { issuedAt: NOW + 6_000 }),
        ),
      )

      await licensing.renewIfDue()

      // The screen still shows Expired; the button is pressed.
      expect(await licensing.checkForRenewal(0)).toMatchObject({
        renewed: true,
        status: { state: 'active', expiresAt },
      })
      // Told once; the same term again is nothing new.
      expect((await licensing.checkForRenewal(0)).renewed).toBe(false)
    })

    it('reports a renewal already stored even when asking again fails', async () => {
      const renewed = term(Date.now() + 365 * DAY)
      const { licensing } = renewing(term(Date.now() - DAY))
      vi.stubGlobal('fetch', issues(renewed))
      await licensing.renewIfDue()

      vi.stubGlobal('fetch', offline())

      expect((await licensing.checkForRenewal(0)).renewed).toBe(true)
    })

    it('asks again after the start-up check', async () => {
      const { licensing } = renewing(term(Date.now() - DAY))
      const fetchStub = offline()
      vi.stubGlobal('fetch', fetchStub)

      await licensing.renewIfDue()
      await expect(licensing.checkForRenewal(0)).rejects.toThrow()

      expect(fetchStub).toHaveBeenCalledTimes(2)
    })

    it('refuses when there is no licence here to renew', async () => {
      const { licensing } = licensed({ stored: false })
      const fetchStub = issues(term(Date.now() + 365 * DAY))
      vi.stubGlobal('fetch', fetchStub)

      await expect(licensing.checkForRenewal(0)).rejects.toMatchObject({
        code: ErrorCode.Validation,
      })
      expect(fetchStub).not.toHaveBeenCalled()
    })

    it('refuses without a licence server', async () => {
      const { licensing } = renewing(term(Date.now() - DAY), {
        activationUrl: '',
        deactivationUrl: '',
      })

      await expect(licensing.checkForRenewal(0)).rejects.toMatchObject({
        code: ErrorCode.Unsupported,
      })
    })
  })
})

describe('what counts as a renewal', () => {
  const current: ActivationClaims = {
    v: 1,
    edition: 'professional',
    key: KEY,
    machine: MACHINE,
    issuedAt: NOW,
    expiresAt: NOW + 1000,
    registeredTo: null,
  }

  it('is a later end, no end at all, or another edition', () => {
    expect(improvesOn({ ...current, expiresAt: NOW + 2000 }, current)).toBe(true)
    expect(improvesOn({ ...current, expiresAt: null }, current)).toBe(true)
    expect(improvesOn({ ...current, edition: 'business' }, current)).toBe(true)
  })

  it('is not the same term re-issued, a shorter one, or a term for a perpetual licence', () => {
    expect(improvesOn({ ...current, issuedAt: NOW + 5 }, current)).toBe(false)
    expect(improvesOn({ ...current, expiresAt: NOW + 500 }, current)).toBe(false)
    expect(improvesOn({ ...current, expiresAt: NOW + 2000 }, { ...current, expiresAt: null })).toBe(
      false,
    )
    expect(improvesOn(current, null)).toBe(false)
  })
})

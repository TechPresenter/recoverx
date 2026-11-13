import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyToken } from '@main/licensing/activation-token'
import { ENTITLEMENTS } from '@shared/types/license'
import { KEY_ALPHABET, completeKey, generateKey, validateKey } from '@shared/utils/license-key'
import { DEFAULT_SELF_RELEASE_POLICY, LicenseAuthority, standingOf } from '@server/authority'
import { LicenseError, isDatabaseBusy } from '@server/errors'
import { CustomerMessages } from '@server/messages'
import { LicenseStore } from '@server/store'
import {
  CLI,
  CUSTOMER,
  DAY,
  MACHINE_A,
  MACHINE_B,
  MACHINE_C,
  MACHINE_D,
  NOW,
  PRODUCT_ID,
  freshKeyPair,
  openFixture,
  picksFor,
  scriptedRandom,
  type Fixture,
} from './fixtures'

/**
 * The licensing rules, exercised directly against a real SQLite database.
 *
 * These are the rules the HTTP server and the admin CLI both delegate to, so
 * this is where each one is pinned down: seats, idempotent re-activation,
 * revocation, expiry, and the refusal every customer-facing path can produce.
 */

let fixture: Fixture

beforeEach(() => {
  fixture = openFixture()
})

afterEach(() => {
  fixture.close()
})

function mint(input: Parameters<LicenseAuthority['createLicenses']>[0]): string {
  const [license] = fixture.authority.createLicenses(input, CLI).licenses
  if (license === undefined) throw new Error('no licence minted')
  return license.key
}

function activate(key: string, machineId: string): ReturnType<LicenseAuthority['activate']> {
  return fixture.authority.activate({ key, machineId, product: PRODUCT_ID }, CUSTOMER)
}

/** Run `fn` and return the `LicenseError` it throws. */
function refusal(fn: () => unknown): LicenseError {
  try {
    fn()
  } catch (error) {
    if (error instanceof LicenseError) return error
    throw error
  }
  throw new Error('expected a refusal, but the call succeeded')
}

describe('minting licences', () => {
  it.each(['professional', 'business', 'technician', 'enterprise'] as const)(
    'gives a %s licence its edition’s standard seat count',
    (edition) => {
      const [license] = fixture.authority.createLicenses({ edition }, CLI).licenses

      expect(license?.maxActivations).toBe(ENTITLEMENTS[edition].activations)
      expect(license?.expiresAt).toBeNull()
      expect(license?.createdAt).toBe(NOW)
    },
  )

  it('mints keys the desktop client accepts, in canonical form', () => {
    const { licenses } = fixture.authority.createLicenses({ edition: 'business', count: 25 }, CLI)

    expect(licenses).toHaveLength(25)
    expect(new Set(licenses.map((license) => license.key)).size).toBe(25)

    for (const license of licenses) {
      expect(validateKey(license.key)).toEqual({ ok: true, key: license.key, problem: null })
    }
  })

  it('refuses the Free edition with an explanation', () => {
    const error = refusal(() => fixture.authority.createLicenses({ edition: 'free' }, CLI))

    expect(error.refusal).toBe('invalid-argument')
    expect(error.message).toMatch(/Free edition needs no licence key/u)
  })

  it('refuses an edition that does not exist', () => {
    const error = refusal(() =>
      fixture.authority.createLicenses({ edition: 'ultimate' as 'business' }, CLI),
    )
    expect(error.refusal).toBe('invalid-argument')
  })

  it('overrides the seat count, including to unlimited', () => {
    expect(
      fixture.authority.createLicenses({ edition: 'professional', seats: 5 }, CLI).licenses[0],
    ).toMatchObject({ maxActivations: 5 })
    expect(
      fixture.authority.createLicenses({ edition: 'professional', seats: null }, CLI).licenses[0],
    ).toMatchObject({ maxActivations: null })
  })

  it('ends a dated licence at the end of that day, UTC', () => {
    const [license] = fixture.authority.createLicenses(
      { edition: 'professional', expires: '2027-03-31' },
      CLI,
    ).licenses

    expect(license?.expiresAt).toBe(Date.UTC(2027, 2, 31, 23, 59, 59, 999))
  })

  it('ends a term licence the given number of days from now', () => {
    const [license] = fixture.authority.createLicenses(
      { edition: 'business', days: 365 },
      CLI,
    ).licenses

    expect(license?.expiresAt).toBe(NOW + 365 * DAY)
  })

  it.each([
    [{ expires: '2027-01-01', days: 30 }, /not both/u],
    [{ expires: '2020-01-01' }, /already in the past/u],
    [{ expires: '2027-02-30' }, /not a real date/u],
    [{ expires: 'next tuesday' }, /not a date/u],
    [{ days: 0 }, /days/u],
    [{ count: 0 }, /count/u],
    [{ count: 1001 }, /count/u],
    [{ seats: 0 }, /seats/u],
    [{ email: 'not-an-address' }, /email/u],
  ])('refuses %j', (extra, message) => {
    const error = refusal(() =>
      fixture.authority.createLicenses({ edition: 'professional', ...extra }, CLI),
    )
    expect(error.refusal).toBe('invalid-argument')
    expect(error.message).toMatch(message)
  })

  it('refuses unknown fields, so a webhook typo cannot mint an anonymous licence', () => {
    const error = refusal(() =>
      fixture.authority.createLicenses(
        { edition: 'professional', registered_to: 'Jane' } as never,
        CLI,
      ),
    )
    expect(error.message).toMatch(/registered_to/u)
  })

  it('is idempotent per order reference, so a retried webhook mints nothing new', () => {
    const first = fixture.authority.createLicenses(
      { edition: 'business', count: 2, orderRef: 'INV-1042', registeredTo: 'Contoso Ltd' },
      CLI,
    )
    const replay = fixture.authority.createLicenses(
      { edition: 'business', count: 2, orderRef: 'INV-1042', registeredTo: 'Contoso Ltd' },
      CLI,
    )

    expect(first.created).toBe(true)
    expect(replay.created).toBe(false)
    expect(replay.licenses.map((license) => license.key).sort()).toEqual(
      first.licenses.map((license) => license.key).sort(),
    )
    expect(fixture.authority.list()).toHaveLength(2)
  })

  it('draws again when a generated key is already taken', () => {
    const takenBody = 'ABCDEFGHJKMNPQRSTVW'
    const taken = completeKey(takenBody) ?? ''

    const colliding = openFixture({
      randomIndex: scriptedRandom([
        ...picksFor(takenBody, KEY_ALPHABET),
        ...picksFor(takenBody, KEY_ALPHABET),
      ]),
    })

    try {
      const first = colliding.authority.createLicenses({ edition: 'professional' }, CLI)
      const second = colliding.authority.createLicenses({ edition: 'professional' }, CLI)

      expect(first.licenses[0]?.key).toBe(taken)
      expect(second.licenses[0]?.key).not.toBe(taken)
      expect(validateKey(second.licenses[0]?.key ?? '').ok).toBe(true)
    } finally {
      colliding.close()
    }
  })

  it('gives up loudly when the random source keeps repeating itself', () => {
    const broken = openFixture({ randomIndex: () => 7 })

    try {
      broken.authority.createLicenses({ edition: 'professional' }, CLI)
      expect(() => broken.authority.createLicenses({ edition: 'professional' }, CLI)).toThrow(
        /random source is broken/u,
      )
      // Nothing half-written: the failed batch rolled back as a whole.
      expect(broken.authority.list()).toHaveLength(1)
    } finally {
      broken.close()
    }
  })
})

describe('activation', () => {
  it('issues a token the desktop client verifies, for the canonical key and the machine', () => {
    const key = mint({ edition: 'professional', registeredTo: 'Jane Doe' })
    const result = activate(key, MACHINE_A)

    const verified = verifyToken(result.token, {
      publicKey: fixture.keys.publicKey,
      machineId: MACHINE_A,
      expectedKey: key,
      now: NOW,
    })

    expect(verified).toEqual({
      ok: true,
      claims: {
        v: 1,
        edition: 'professional',
        key,
        machine: MACHINE_A,
        issuedAt: NOW,
        expiresAt: null,
        registeredTo: 'Jane Doe',
      },
    })
    expect(result.reused).toBe(false)
    expect(result.activeSeats).toBe(1)
  })

  it('accepts a key typed the way customers type them', () => {
    const key = mint({ edition: 'professional' })
    // Lower case, no hyphens, spaces, and the letter O where a zero belongs.
    const sloppy = ` ${key.toLowerCase().replace(/-/gu, ' ').replace(/0/gu, 'o')} `

    const result = activate(sloppy, MACHINE_A)

    expect(result.claims.key).toBe(key)
    expect(result.claims.key).toBe(validateKey(sloppy).key)
  })

  it('re-activating the same machine is idempotent and takes no extra seat', () => {
    const key = mint({ edition: 'professional' })

    const first = activate(key, MACHINE_A)
    fixture.clock.advance(DAY)
    const again = activate(key, MACHINE_A)

    expect(again.reused).toBe(true)
    expect(again.activeSeats).toBe(1)
    expect(again.claims.issuedAt).toBe(first.claims.issuedAt + DAY)

    const [activation] = fixture.authority.show(key).activations
    expect(activation).toMatchObject({
      machineId: MACHINE_A,
      firstActivatedAt: NOW,
      lastActivatedAt: NOW + DAY,
      releasedAt: null,
    })
  })

  it('refuses a second machine once the only seat is taken, in the customer’s terms', () => {
    const key = mint({ edition: 'professional' })
    activate(key, MACHINE_A)

    const error = refusal(() => activate(key, MACHINE_B))

    expect(error.refusal).toBe('seats-exhausted')
    expect(error.status).toBe(409)
    expect(error.message).toMatch(/already active on another computer/u)
    expect(error.message).toMatch(/info@appsgain\.in/u)
  })

  it('enforces a three-seat Business licence', () => {
    const key = mint({ edition: 'business' })
    activate(key, MACHINE_A)
    activate(key, MACHINE_B)
    activate(key, MACHINE_C)

    const error = refusal(() => activate(key, MACHINE_D))
    expect(error.message).toMatch(/already active on 3 computers/u)

    // A machine already holding a seat is still served when the licence is full.
    expect(activate(key, MACHINE_B).reused).toBe(true)
  })

  it('does not cap an unlimited licence', () => {
    const key = mint({ edition: 'technician' })

    for (const machine of [MACHINE_A, MACHINE_B, MACHINE_C, MACHINE_D]) {
      expect(activate(key, machine).reused).toBe(false)
    }
    expect(fixture.authority.show(key).activeSeats).toBe(4)
  })

  it('refuses a key that was never issued', () => {
    const neverIssued = generateKey(() => 3)
    const error = refusal(() => activate(neverIssued, MACHINE_A))

    expect(error.refusal).toBe('unknown-key')
    expect(error.status).toBe(404)
    expect(error.message).toMatch(/could not find that licence key/u)
  })

  it('refuses a mistyped key before looking it up', () => {
    const key = mint({ edition: 'professional' })
    const last = key.slice(-1)
    const mistyped = key.slice(0, -1) + (last === 'A' ? 'B' : 'A')

    const error = refusal(() => activate(mistyped, MACHINE_A))

    expect(error.refusal).toBe('invalid-key')
    expect(error.status).toBe(400)
    expect(error.message).toMatch(/typing error/u)
  })

  it('refuses another product and a malformed machine identifier', () => {
    const key = mint({ edition: 'professional' })

    expect(
      refusal(() =>
        fixture.authority.activate({ key, machineId: MACHINE_A, product: 'other' }, CUSTOMER),
      ).refusal,
    ).toBe('wrong-product')

    for (const machineId of [
      '',
      'short',
      'abcd-efgh-jkmn-pqrs-tvwx-yz12',
      'ABCD EFGH JKMN PQRS TVWX',
    ]) {
      expect(refusal(() => activate(key, machineId)).refusal).toBe('invalid-machine')
    }

    expect(fixture.authority.show(key).activeSeats).toBe(0)
  })

  it('refuses a revoked licence, including on a machine that already held a seat', () => {
    const key = mint({ edition: 'professional' })
    activate(key, MACHINE_A)

    fixture.authority.revoke(key, 'refund INV-1042', CLI)
    const error = refusal(() => activate(key, MACHINE_A))

    expect(error.refusal).toBe('revoked')
    expect(error.status).toBe(403)
    expect(error.message).toMatch(/no longer valid/u)

    fixture.authority.restore(key, CLI)
    expect(activate(key, MACHINE_A).reused).toBe(true)
  })

  it('refuses an expired licence and says when it ended', () => {
    const key = mint({ edition: 'professional', days: 30 })
    activate(key, MACHINE_A)

    fixture.clock.advance(31 * DAY)
    const error = refusal(() => activate(key, MACHINE_A))

    expect(error.refusal).toBe('expired')
    expect(error.status).toBe(403)
    expect(error.message).toBe(
      'This licence ended on 12 December 2026. Renew it by emailing info@appsgain.in (see https://recoverx.snapkio.com/support/#renew) to recover without limit again.',
    )
  })

  it('carries the licence expiry into the token', () => {
    const key = mint({ edition: 'business', expires: '2027-06-30' })
    const { token } = activate(key, MACHINE_A)

    const options = { publicKey: fixture.keys.publicKey, machineId: MACHINE_A }
    expect(verifyToken(token, { ...options, now: NOW }).ok).toBe(true)
    expect(verifyToken(token, { ...options, now: Date.UTC(2027, 6, 1) })).toEqual({
      ok: false,
      failure: 'expired',
    })
  })

  it('records refusals of a known licence in its audit trail', () => {
    const key = mint({ edition: 'professional' })
    activate(key, MACHINE_A)
    refusal(() => activate(key, MACHINE_B))

    const types = fixture.authority.show(key).events.map((event) => event.type)
    expect(types).toEqual(['activation-refused', 'activated', 'license-created'])

    const refused = fixture.authority.show(key).events[0]
    expect(refused).toMatchObject({ machineId: MACHINE_B, ip: CUSTOMER.ip })
    expect(refused?.detail).toContain('seats-exhausted')
  })

  it('does not record renewal checks from a computer that still holds a seat of a lapsed licence', () => {
    const key = mint({ edition: 'business', days: 30 })
    const { token } = activate(key, MACHINE_A)
    expect(fixture.authority.deactivate(token, CUSTOMER).released).toBe(true)
    fixture.clock.advance(DAY)
    activate(key, MACHINE_B)
    fixture.clock.advance(40 * DAY)

    // The application asking at each launch whether the term was renewed:
    // refused every time, and none of it buries the history support reads.
    for (let launch = 0; launch < 60; launch += 1) {
      expect(refusal(() => activate(key, MACHINE_B)).refusal).toBe('expired')
    }

    // A computer with no seat trying the lapsed licence is still recorded…
    expect(refusal(() => activate(key, MACHINE_C)).refusal).toBe('expired')

    const events = fixture.authority.show(key).events
    expect(events.map((event) => event.type)).toEqual([
      'activation-refused',
      'activated',
      'deactivated',
      'activated',
      'license-created',
    ])
    expect(events[0]).toMatchObject({ machineId: MACHINE_C })
    expect(events[0]?.detail).toContain('expired')
  })
})

describe('deactivation', () => {
  it('releases the seat, and the licence can then move to another machine', () => {
    const key = mint({ edition: 'professional' })
    const { token } = activate(key, MACHINE_A)

    expect(fixture.authority.deactivate(token, CUSTOMER)).toEqual({
      released: true,
      key,
      machineId: MACHINE_A,
    })

    expect(activate(key, MACHINE_B).reused).toBe(false)
    expect(fixture.authority.show(key).activeSeats).toBe(1)
  })

  it('is idempotent: releasing a free seat again reports released: false', () => {
    const key = mint({ edition: 'professional' })
    const { token } = activate(key, MACHINE_A)

    fixture.authority.deactivate(token, CUSTOMER)
    expect(fixture.authority.deactivate(token, CUSTOMER).released).toBe(false)
  })

  it('keeps a returning machine’s history as one machine', () => {
    const key = mint({ edition: 'professional' })
    const { token } = activate(key, MACHINE_A)
    fixture.authority.deactivate(token, CUSTOMER)

    fixture.clock.advance(DAY)
    activate(key, MACHINE_A)

    expect(fixture.authority.show(key).activations).toEqual([
      {
        key,
        machineId: MACHINE_A,
        firstActivatedAt: NOW,
        lastActivatedAt: NOW + DAY,
        releasedAt: null,
      },
    ])
  })

  it('still releases the seat of a licence whose term has ended', () => {
    const key = mint({ edition: 'professional', days: 30 })
    const { token } = activate(key, MACHINE_A)

    fixture.clock.advance(60 * DAY)
    expect(fixture.authority.deactivate(token, CUSTOMER).released).toBe(true)
  })

  it('refuses a token signed with another key, and an unreadable one', () => {
    const key = mint({ edition: 'professional' })
    activate(key, MACHINE_A)

    // A second server with its own key and a copy of the same licence: its
    // tokens are well formed, name a real seat, and must still be refused.
    const impostor = openFixture({ keys: freshKeyPair() })
    try {
      const record = fixture.store.getLicense(key)
      if (record === null) throw new Error('licence missing')
      impostor.store.insertLicense(record)
      const { token: forged } = impostor.authority.activate(
        { key, machineId: MACHINE_A, product: PRODUCT_ID },
        CUSTOMER,
      )

      const forgedError = refusal(() => fixture.authority.deactivate(forged, CUSTOMER))
      expect(forgedError.refusal).toBe('forged-token')
      expect(forgedError.status).toBe(403)
    } finally {
      impostor.close()
    }

    for (const garbage of ['', 'abc', 'a.b.c', 'not base64!.x']) {
      expect(refusal(() => fixture.authority.deactivate(garbage, CUSTOMER)).refusal).toBe(
        'invalid-token',
      )
    }

    // The genuine seat is untouched by either attempt.
    expect(fixture.authority.show(key).activeSeats).toBe(1)
  })
})

describe('renewal by re-activation', () => {
  it('gives the same machine a token carrying the extended end date, without a new seat', () => {
    const key = mint({ edition: 'business', days: 30, registeredTo: 'Contoso Ltd' })
    const before = activate(key, MACHINE_A)
    expect(before.claims.expiresAt).toBe(NOW + 30 * DAY)

    fixture.clock.advance(10 * DAY)
    fixture.authority.extend(key, { days: 365 }, CLI)
    const after = activate(key, MACHINE_A)

    expect(after.reused).toBe(true)
    expect(after.activeSeats).toBe(1)
    expect(after.claims).toEqual({
      v: 1,
      edition: 'business',
      key,
      machine: MACHINE_A,
      issuedAt: NOW + 10 * DAY,
      expiresAt: NOW + 395 * DAY,
      registeredTo: 'Contoso Ltd',
    })

    // Past the old end date, the old token has lapsed and the new one has not.
    const options = {
      publicKey: fixture.keys.publicKey,
      machineId: MACHINE_A,
      expectedKey: key,
      now: NOW + 31 * DAY,
    }
    expect(verifyToken(before.token, options)).toEqual({ ok: false, failure: 'expired' })
    expect(verifyToken(after.token, options).ok).toBe(true)
  })

  it('carries the licence’s current edition and owner, never the previous token’s', () => {
    const key = mint({ edition: 'professional', days: 30, registeredTo: 'Jane Doe' })
    activate(key, MACHINE_A)

    // No admin command changes an edition or an owner today; an operator
    // upgrading a licence by hand is the case this stands in for.
    fixture.store.db
      .prepare('UPDATE licenses SET edition = ?, registered_to = ? WHERE key = ?')
      .run('business', 'Doe Consulting Ltd', key)
    fixture.authority.extend(key, { perpetual: true }, CLI)

    expect(activate(key, MACHINE_A).claims).toMatchObject({
      edition: 'business',
      registeredTo: 'Doe Consulting Ltd',
      expiresAt: null,
    })
  })
})

describe('the self-service release allowance', () => {
  const MOVES_SENTENCE =
    'This licence has already been moved between computers 4 times in the last 12 months. ' +
    'It is still active on this computer. To move it again, contact info@appsgain.in with your licence key.'

  /**
   * Activate on a machine and release it again, a day later than the last
   * time — the honest customer's "move to a new PC" as the server sees it.
   * Returns the token, so a test can retry the release with it.
   */
  function move(on: Fixture, key: string, machineId = MACHINE_A): string {
    const { token } = on.authority.activate({ key, machineId, product: PRODUCT_ID }, CUSTOMER)
    expect(on.authority.deactivate(token, CUSTOMER).released).toBe(true)
    on.clock.advance(DAY)
    return token
  }

  /** Use up the default allowance, then activate once more and return that token. */
  function spendAllowance(on: Fixture, key: string): string {
    for (let index = 0; index < DEFAULT_SELF_RELEASE_POLICY.limit; index += 1) move(on, key)
    return on.authority.activate({ key, machineId: MACHINE_A, product: PRODUCT_ID }, CUSTOMER).token
  }

  it('defaults to four moves in a rolling year', () => {
    expect(DEFAULT_SELF_RELEASE_POLICY).toEqual({ limit: 4, windowDays: 365 })
  })

  it('refuses the move past the allowance with 409, and the seat stays held', () => {
    const key = mint({ edition: 'professional' })
    const token = spendAllowance(fixture, key)

    const error = refusal(() => fixture.authority.deactivate(token, CUSTOMER))

    expect(error.refusal).toBe('self-release-limit')
    expect(error.status).toBe(409)
    expect(error.retryable).toBe(false)
    expect(error.message).toBe(MOVES_SENTENCE)
    expect(error.subject).toEqual({ key, machineId: MACHINE_A })

    // Still this computer's: the seat is held and another computer is refused.
    const shown = fixture.authority.show(key)
    expect(shown.activeSeats).toBe(1)
    expect(shown.activations[0]).toMatchObject({ machineId: MACHINE_A, releasedAt: null })
    expect(refusal(() => activate(key, MACHINE_B)).refusal).toBe('seats-exhausted')

    // The refusal is in the audit trail, which is where support will look.
    expect(shown.selfReleases).toEqual({ recent: 4, limit: 4, windowDays: 365 })
    const refused = shown.events.find((event) => event.type === 'deactivation-refused')
    expect(refused).toMatchObject({ machineId: MACHINE_A, ip: CUSTOMER.ip })
    expect(refused?.detail).toContain('self-release-limit')
  })

  it('counts only releases inside the rolling window', () => {
    const key = mint({ edition: 'professional' })
    // Releases at NOW, NOW + 1 day, NOW + 2 days and NOW + 3 days.
    const token = spendAllowance(fixture, key)
    expect(refusal(() => fixture.authority.deactivate(token, CUSTOMER)).refusal).toBe(
      'self-release-limit',
    )

    // A moment before the first release is a year old, it still counts…
    fixture.clock.current = NOW + 365 * DAY - 1
    expect(refusal(() => fixture.authority.deactivate(token, CUSTOMER)).refusal).toBe(
      'self-release-limit',
    )

    // …and once it is, one move is free again — one, not a fresh four.
    fixture.clock.current = NOW + 365 * DAY
    expect(fixture.authority.deactivate(token, CUSTOMER).released).toBe(true)
    expect(fixture.authority.show(key).selfReleases.recent).toBe(4)

    const next = activate(key, MACHINE_B).token
    expect(refusal(() => fixture.authority.deactivate(next, CUSTOMER)).refusal).toBe(
      'self-release-limit',
    )
  })

  it('with a limit of 0, refuses every self-service release of a held seat', () => {
    const strict = openFixture({ selfRelease: { limit: 0, windowDays: 365 } })
    try {
      const [license] = strict.authority.createLicenses({ edition: 'business' }, CLI).licenses
      const key = license?.key ?? ''
      const { token } = strict.authority.activate(
        { key, machineId: MACHINE_A, product: PRODUCT_ID },
        CUSTOMER,
      )

      const error = refusal(() => strict.authority.deactivate(token, CUSTOMER))
      expect(error.status).toBe(409)
      expect(error.message).toBe(CustomerMessages.selfReleaseDisabled)
      expect(error.message).toMatch(/still active on this computer.*info@appsgain\.in/u)
      expect(strict.authority.show(key).activeSeats).toBe(1)

      // Support moves it; the old computer's own release then finds the seat
      // free and is told so, not refused, so it can forget its licence.
      expect(strict.authority.release(key, MACHINE_A, CLI)).toBe(true)
      expect(strict.authority.deactivate(token, CUSTOMER).released).toBe(false)
    } finally {
      strict.close()
    }
  })

  it('never refuses or counts a repeated release of a seat that is already free', () => {
    const key = mint({ edition: 'professional' })
    let last = ''
    for (let index = 0; index < DEFAULT_SELF_RELEASE_POLICY.limit; index += 1) {
      last = move(fixture, key)
    }

    // The allowance is spent, but a client retrying after a lost response
    // gets the answer it would have got the first time.
    for (let retry = 0; retry < 3; retry += 1) {
      expect(fixture.authority.deactivate(last, CUSTOMER)).toEqual({
        released: false,
        key,
        machineId: MACHINE_A,
      })
    }

    expect(fixture.authority.show(key).selfReleases.recent).toBe(4)
  })

  it('lets support release and reset past the allowance, without counting either', () => {
    const key = mint({ edition: 'business' })
    const token = spendAllowance(fixture, key)
    refusal(() => fixture.authority.deactivate(token, CUSTOMER))

    expect(fixture.authority.release(key, MACHINE_A, CLI)).toBe(true)
    activate(key, MACHINE_B)
    activate(key, MACHINE_C)
    fixture.authority.issueOffline(key, MACHINE_D, CLI)
    expect(fixture.authority.resetSeats(key, { actor: 'admin-api', ip: '198.51.100.1' })).toBe(3)

    const shown = fixture.authority.show(key)
    expect(shown.activeSeats).toBe(0)
    expect(shown.selfReleases.recent).toBe(4)
    expect(shown.events.filter((event) => event.type === 'deactivated')).toHaveLength(4)
  })

  it('never limits a licence with unlimited seats, but still counts its moves', () => {
    // A technician removes the licence from each customer's computer after a
    // job; there is no seat to stretch, so the allowance must not trap it there.
    const key = mint({ edition: 'technician' })
    expect(fixture.authority.show(key).license.maxActivations).toBeNull()

    const token = spendAllowance(fixture, key)
    expect(fixture.authority.deactivate(token, CUSTOMER).released).toBe(true)

    expect(fixture.authority.show(key).selfReleases).toEqual({
      recent: 5,
      limit: null,
      windowDays: 365,
    })
  })

  it.each(['technician', 'enterprise'] as const)(
    'with a limit of 0, still lets unlimited seats move (%s)',
    (edition) => {
      const strict = openFixture({ selfRelease: { limit: 0, windowDays: 365 } })
      try {
        const [license] = strict.authority.createLicenses({ edition }, CLI).licenses
        const key = license?.key ?? ''
        expect(license?.maxActivations).toBeNull()
        const { token } = strict.authority.activate(
          { key, machineId: MACHINE_A, product: PRODUCT_ID },
          CUSTOMER,
        )

        expect(strict.authority.deactivate(token, CUSTOMER).released).toBe(true)
        expect(strict.authority.show(key).activeSeats).toBe(0)
        expect(strict.authority.show(key).events[0]?.type).toBe('deactivated')
      } finally {
        strict.close()
      }
    },
  )

  it('keeps the count across a restart, because it is read from the database', () => {
    const file = join(fixture.dir.path, 'restart.db')
    const clock = fixture.clock.now
    const policy = { limit: 2, windowDays: 30 }

    let store = LicenseStore.open(file)
    let authority = new LicenseAuthority({
      store,
      signer: fixture.signer,
      clock,
      selfRelease: policy,
    })
    const key = authority.createLicenses({ edition: 'professional' }, CLI).licenses[0]?.key ?? ''
    const cycle = (): string => {
      const { token } = authority.activate(
        { key, machineId: MACHINE_A, product: PRODUCT_ID },
        CUSTOMER,
      )
      return token
    }

    try {
      authority.deactivate(cycle(), CUSTOMER)
      authority.deactivate(cycle(), CUSTOMER)
      const held = cycle()

      store.close()
      store = LicenseStore.open(file)
      authority = new LicenseAuthority({
        store,
        signer: fixture.signer,
        clock,
        selfRelease: policy,
      })

      const error = refusal(() => authority.deactivate(held, CUSTOMER))
      expect(error.message).toBe(
        'This licence has already been moved between computers twice in the last 30 days. ' +
          'It is still active on this computer. To move it again, contact info@appsgain.in with your licence key.',
      )
      expect(authority.show(key).activeSeats).toBe(1)
    } finally {
      store.close()
    }
  })

  it('cannot hand the last allowed move to two releases at once', () => {
    // As with the last seat: the count and the release happen under one write
    // lock, so a second connection cannot read the count in between.
    const file = join(fixture.dir.path, 'race-release.db')
    const storeA = LicenseStore.open(file, { busyTimeoutMs: 50 })
    const storeB = LicenseStore.open(file, { busyTimeoutMs: 50 })
    const clock = fixture.clock.now
    const selfRelease = { limit: 1, windowDays: 365 }

    try {
      const authorityA = new LicenseAuthority({
        store: storeA,
        signer: fixture.signer,
        clock,
        selfRelease,
      })
      const key = authorityA.createLicenses({ edition: 'business' }, CLI).licenses[0]?.key ?? ''
      const tokenA = authorityA.activate(
        { key, machineId: MACHINE_A, product: PRODUCT_ID },
        CUSTOMER,
      ).token
      const tokenB = authorityA.activate(
        { key, machineId: MACHINE_B, product: PRODUCT_ID },
        CUSTOMER,
      ).token

      let raced: unknown = null
      const pausedB = new Proxy(storeB, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value

          if (property === 'countEventsAfter' && raced === null) {
            return (...args: unknown[]): number => {
              const counted = (value as (...a: unknown[]) => number).apply(target, args)
              try {
                raced = authorityA.deactivate(tokenA, CUSTOMER)
              } catch (error) {
                raced = error
              }
              return counted
            }
          }

          return (value as (...args: unknown[]) => unknown).bind(target)
        },
      })

      const authorityB = new LicenseAuthority({
        store: pausedB,
        signer: fixture.signer,
        clock,
        selfRelease,
      })

      expect(authorityB.deactivate(tokenB, CUSTOMER).released).toBe(true)
      expect(isDatabaseBusy(raced)).toBe(true)
      expect(refusal(() => authorityA.deactivate(tokenA, CUSTOMER)).refusal).toBe(
        'self-release-limit',
      )
      expect(storeA.countActiveSeats(key)).toBe(1)
    } finally {
      storeA.close()
      storeB.close()
    }
  })

  it('says a count and a window the way a person would', () => {
    expect(CustomerMessages.selfReleaseLimit(1, 365)).toMatch(
      /^This licence has already been moved between computers once in the last 12 months\. /u,
    )
    expect(CustomerMessages.selfReleaseLimit(3, 730)).toMatch(/3 times in the last 24 months\. /u)
    expect(CustomerMessages.selfReleaseLimit(2, 30)).toMatch(/twice in the last 30 days\. /u)
    expect(CustomerMessages.selfReleaseLimit(1, 1)).toMatch(/once in the last day\. /u)
  })

  it.each([
    [{ limit: -1, windowDays: 365 }, /limit must be a whole number of 0 or more/u],
    [{ limit: 1.5, windowDays: 365 }, /limit must be a whole number of 0 or more/u],
    [{ limit: 4, windowDays: 0 }, /window must be a whole number of days, at least 1/u],
  ])('refuses the policy %j', (selfRelease, message) => {
    expect(
      () => new LicenseAuthority({ store: fixture.store, signer: fixture.signer, selfRelease }),
    ).toThrow(message)
  })
})

describe('offline issuance', () => {
  it('follows the same seat rules and forgives how a person types the machine id', () => {
    const key = mint({ edition: 'professional' })

    const result = fixture.authority.issueOffline(key, `  ${MACHINE_A.toLowerCase()} `, CLI)
    expect(result.claims.machine).toBe(MACHINE_A)
    expect(
      verifyToken(result.token, {
        publicKey: fixture.keys.publicKey,
        machineId: MACHINE_A,
        expectedKey: key,
        now: NOW,
      }).ok,
    ).toBe(true)

    expect(refusal(() => fixture.authority.issueOffline(key, MACHINE_B, CLI)).refusal).toBe(
      'seats-exhausted',
    )
    expect(refusal(() => fixture.authority.issueOffline(key, 'not a machine', CLI)).refusal).toBe(
      'invalid-machine',
    )
    expect(fixture.authority.show(key).events.map((event) => event.type)).toEqual([
      'activation-refused',
      'offline-issued',
      'license-created',
    ])
  })

  it('needs a signing key', () => {
    const adminOnly = new LicenseAuthority({ store: fixture.store, signer: null })
    const key = mint({ edition: 'professional' })

    expect(() => adminOnly.issueOffline(key, MACHINE_A, CLI)).toThrow(/No signing key/u)
    // Administration that does not sign anything still works without one.
    expect(adminOnly.show(key).license.key).toBe(key)
  })
})

describe('administration', () => {
  it('revoking twice keeps the original date and reason', () => {
    const key = mint({ edition: 'professional' })

    fixture.authority.revoke(key, 'chargeback', CLI)
    fixture.clock.advance(DAY)
    const again = fixture.authority.revoke(key, 'second thoughts', CLI)

    expect(again).toMatchObject({ revokedAt: NOW, revokeReason: 'chargeback' })
    expect(standingOf(again, fixture.clock.now())).toBe('revoked')
  })

  it('extends a term from its current end, or from today once it has lapsed', () => {
    const key = mint({ edition: 'business', days: 30 })

    expect(fixture.authority.extend(key, { days: 365 }, CLI).expiresAt).toBe(NOW + 395 * DAY)

    fixture.clock.advance(500 * DAY)
    expect(fixture.authority.extend(key, { days: 10 }, CLI).expiresAt).toBe(NOW + 510 * DAY)
  })

  it('extending lets an expired licence activate again', () => {
    const key = mint({ edition: 'professional', days: 30 })
    fixture.clock.advance(40 * DAY)
    expect(refusal(() => activate(key, MACHINE_A)).refusal).toBe('expired')

    fixture.authority.extend(key, { days: 365 }, CLI)
    expect(activate(key, MACHINE_A).claims.expiresAt).toBe(NOW + 405 * DAY)
  })

  it('sets an absolute date or makes a licence perpetual, one at a time', () => {
    const key = mint({ edition: 'business', days: 30 })

    expect(fixture.authority.extend(key, { expires: '2028-01-31' }, CLI).expiresAt).toBe(
      Date.UTC(2028, 0, 31, 23, 59, 59, 999),
    )
    expect(fixture.authority.extend(key, { perpetual: true }, CLI).expiresAt).toBeNull()

    expect(refusal(() => fixture.authority.extend(key, { days: 30 }, CLI)).message).toMatch(
      /perpetual/u,
    )
    expect(
      refusal(() => fixture.authority.extend(key, { days: 30, perpetual: true }, CLI)).message,
    ).toMatch(/exactly one/u)
    expect(refusal(() => fixture.authority.extend(key, {}, CLI)).message).toMatch(/exactly one/u)
  })

  it('releases one machine for a customer whose computer died', () => {
    const key = mint({ edition: 'professional' })
    activate(key, MACHINE_A)

    expect(fixture.authority.release(key, MACHINE_A.toLowerCase(), CLI)).toBe(true)
    expect(fixture.authority.release(key, MACHINE_A, CLI)).toBe(false)
    expect(refusal(() => fixture.authority.release(key, MACHINE_B, CLI)).refusal).toBe('not-found')

    expect(activate(key, MACHINE_B).reused).toBe(false)
  })

  it('resets every seat at once', () => {
    const key = mint({ edition: 'business' })
    activate(key, MACHINE_A)
    activate(key, MACHINE_B)

    expect(fixture.authority.resetSeats(key, CLI)).toBe(2)
    expect(fixture.authority.resetSeats(key, CLI)).toBe(0)
    expect(fixture.authority.show(key).activeSeats).toBe(0)
  })

  it('answers admin operations on a missing or malformed key with operator-facing errors', () => {
    const missing = generateKey(() => 5)

    expect(refusal(() => fixture.authority.show(missing))).toMatchObject({
      refusal: 'not-found',
      status: 404,
    })
    expect(refusal(() => fixture.authority.revoke('RECX-12345', null, CLI))).toMatchObject({
      refusal: 'invalid-argument',
      status: 400,
    })
  })

  it('lists and filters licences, newest first', () => {
    mint({ edition: 'professional', registeredTo: 'Jane Doe', orderRef: 'INV-1' })
    fixture.clock.advance(1000)
    mint({ edition: 'business', email: 'ops@contoso.example', orderRef: 'INV-2' })
    fixture.clock.advance(1000)
    const key = mint({ edition: 'technician', notes: '100%_literal' })

    expect(fixture.authority.list().map((license) => license.edition)).toEqual([
      'technician',
      'business',
      'professional',
    ])
    expect(fixture.authority.list({ edition: 'business' })).toHaveLength(1)
    expect(fixture.authority.list({ search: 'contoso' })[0]?.orderRef).toBe('INV-2')
    expect(fixture.authority.list({ search: 'jane' })[0]?.registeredTo).toBe('Jane Doe')
    expect(fixture.authority.list({ orderRef: 'INV-1' })).toHaveLength(1)
    // LIKE wildcards in the search text are matched literally.
    expect(fixture.authority.list({ search: '%' })).toHaveLength(0)
    expect(fixture.authority.list({ search: key.slice(5, 10) })[0]?.key).toBe(key)
    expect(fixture.authority.list({ limit: 1, offset: 1 })[0]?.edition).toBe('business')
  })
})

describe('the last seat under concurrency', () => {
  it('two connections cannot both take it', () => {
    // Two connections to one file stand in for two processes: the server and
    // an operator issuing an offline activation, or two server replicas.
    const file = join(fixture.dir.path, 'race.db')
    const storeA = LicenseStore.open(file, { busyTimeoutMs: 50 })
    const storeB = LicenseStore.open(file, { busyTimeoutMs: 50 })

    try {
      const clock = fixture.clock.now
      const authorityA = new LicenseAuthority({ store: storeA, signer: fixture.signer, clock })
      const key = authorityA.createLicenses({ edition: 'professional' }, CLI).licenses[0]?.key ?? ''

      let interleaved = false
      let raced: unknown = null

      // B is stopped at the most dangerous moment — it has counted one free
      // seat and not yet taken it — and A tries to take the same seat then.
      const pausedB = new Proxy(storeB, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value

          if (property === 'countActiveSeats' && !interleaved) {
            return (seatKey: string): number => {
              const counted = (value as (k: string) => number).call(target, seatKey)
              interleaved = true
              try {
                raced = authorityA.activate(
                  { key: seatKey, machineId: MACHINE_A, product: PRODUCT_ID },
                  CUSTOMER,
                )
              } catch (error) {
                raced = error
              }
              return counted
            }
          }

          return (value as (...args: unknown[]) => unknown).bind(target)
        },
      })

      const authorityB = new LicenseAuthority({ store: pausedB, signer: fixture.signer, clock })
      const winner = authorityB.activate(
        { key, machineId: MACHINE_B, product: PRODUCT_ID },
        CUSTOMER,
      )

      expect(interleaved).toBe(true)
      expect(winner.claims.machine).toBe(MACHINE_B)
      // A could not even read the seat count while B held the write lock…
      expect(isDatabaseBusy(raced)).toBe(true)
      // …so exactly one seat was taken, and A now gets the honest answer.
      expect(storeA.countActiveSeats(key)).toBe(1)
      expect(
        refusal(() =>
          authorityA.activate({ key, machineId: MACHINE_A, product: PRODUCT_ID }, CUSTOMER),
        ).refusal,
      ).toBe('seats-exhausted')
    } finally {
      storeA.close()
      storeB.close()
    }
  })
})

import { randomInt, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeTokenClaims, verifyToken } from '@main/licensing/activation-token'
import { ActivationClaimsSchema, type ActivationClaims } from '@shared/types/license'
import { KEY_ALPHABET, generateKey, validateKey } from '@shared/utils/license-key'
import { fingerprintOf, publicKeyOf, samePublicKey } from '@server/signing'
import {
  CLI,
  CUSTOMER,
  DAY,
  MACHINE_A,
  MACHINE_B,
  NOW,
  PRODUCT_ID,
  openFixture,
  picksFor,
  type Fixture,
} from './fixtures'

/**
 * Cross-compatibility between the licence server and the desktop client.
 *
 * The two halves of the token format live in different processes, are built
 * by different bundlers and are deployed on different schedules. The only
 * thing keeping them in agreement is this file: every token here is minted by
 * the server's code and checked by the client's own verifier, unmodified.
 *
 * If one of these fails, a release would ship in which every activation the
 * server hands out is rejected on the customer's machine as "not genuine".
 */

let fixture: Fixture

beforeEach(() => {
  fixture = openFixture()
})

afterEach(() => {
  fixture.close()
})

function mint(input: Parameters<Fixture['authority']['createLicenses']>[0]): string {
  return fixture.authority.createLicenses(input, CLI).licenses[0]?.key ?? ''
}

describe('server-issued tokens on the desktop client', () => {
  it('verify with the client verifier, and the claims key is what validateKey gives the client', () => {
    const key = mint({ edition: 'business', registeredTo: 'Contoso Ltd', days: 365 })

    // What the customer types, and what the client sends after its own
    // local validation — exactly as license.service.ts does it.
    const typed = key.toLowerCase().replace(/-/gu, '')
    const clientKey = validateKey(typed).key
    expect(clientKey).not.toBeNull()

    const { token } = fixture.authority.activate(
      { key: clientKey ?? '', machineId: MACHINE_A, product: PRODUCT_ID },
      CUSTOMER,
    )

    const result = verifyToken(token, {
      publicKey: fixture.keys.publicKey,
      machineId: MACHINE_A,
      expectedKey: clientKey ?? undefined,
      now: NOW,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.claims.key).toBe(clientKey)
    expect(result.claims.key).toBe(key)
    expect(result.claims).toEqual({
      v: 1,
      edition: 'business',
      key,
      machine: MACHINE_A,
      issuedAt: NOW,
      expiresAt: NOW + 365 * DAY,
      registeredTo: 'Contoso Ltd',
    })
  })

  it('verify against the public key the server derives and prints', () => {
    const key = mint({ edition: 'professional' })
    const { token } = fixture.authority.activate(
      { key, machineId: MACHINE_A, product: PRODUCT_ID },
      CUSTOMER,
    )

    const printed = publicKeyOf(fixture.keys.privateKey)
    expect(printed).toBe(fixture.signer.publicKey)
    expect(samePublicKey(printed, fixture.keys.publicKey)).toBe(true)
    expect(fingerprintOf(printed)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u)

    expect(verifyToken(token, { publicKey: printed, machineId: MACHINE_A, now: NOW }).ok).toBe(true)
  })

  it('are bound to the machine they were issued for', () => {
    const key = mint({ edition: 'professional' })
    const { token } = fixture.authority.activate(
      { key, machineId: MACHINE_A, product: PRODUCT_ID },
      CUSTOMER,
    )

    expect(
      verifyToken(token, { publicKey: fixture.keys.publicKey, machineId: MACHINE_B, now: NOW }),
    ).toEqual({ ok: false, failure: 'wrong-machine' })
  })

  it('expire on the client when the licence term ends', () => {
    const key = mint({ edition: 'professional', expires: '2027-01-31' })
    const { token } = fixture.authority.activate(
      { key, machineId: MACHINE_A, product: PRODUCT_ID },
      CUSTOMER,
    )
    const options = { publicKey: fixture.keys.publicKey, machineId: MACHINE_A }

    expect(verifyToken(token, { ...options, now: Date.UTC(2027, 0, 31, 23, 0) }).ok).toBe(true)
    expect(verifyToken(token, { ...options, now: Date.UTC(2027, 1, 1) })).toEqual({
      ok: false,
      failure: 'expired',
    })
  })

  it('decode with the client’s unverified reader too', () => {
    const key = mint({ edition: 'enterprise', registeredTo: 'Ünïcødé GmbH' })
    const { token, claims } = fixture.authority.issueOffline(key, MACHINE_A, CLI)

    expect(decodeTokenClaims(token)).toEqual(claims)
    expect(claims.registeredTo).toBe('Ünïcødé GmbH')
  })

  it('are rejected by a client built with a different public key', () => {
    const other = openFixture()
    try {
      const key = mint({ edition: 'professional' })
      const { token } = fixture.authority.activate(
        { key, machineId: MACHINE_A, product: PRODUCT_ID },
        CUSTOMER,
      )

      expect(
        verifyToken(token, { publicKey: other.keys.publicKey, machineId: MACHINE_A, now: NOW }),
      ).toEqual({ ok: false, failure: 'bad-signature' })
    } finally {
      other.close()
    }
  })
})

describe('client-format tokens on the server', () => {
  it('a token signed the way the client tests sign one releases its seat', () => {
    const key = mint({ edition: 'professional' })
    fixture.authority.activate({ key, machineId: MACHINE_A, product: PRODUCT_ID }, CUSTOMER)

    // Built independently of the server's signer, following the documented
    // format: base64url(JSON) "." base64url(Ed25519 over the encoded payload).
    const claims: ActivationClaims = ActivationClaimsSchema.parse({
      v: 1,
      edition: 'professional',
      key,
      machine: MACHINE_A,
      issuedAt: NOW,
      expiresAt: null,
      registeredTo: null,
    })
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const signature = sign(null, Buffer.from(payload, 'utf8'), fixture.keys.privateKey).toString(
      'base64url',
    )

    expect(fixture.signer.verifySignature(`${payload}.${signature}`)).toEqual({
      ok: true,
      claims,
    })
    expect(fixture.authority.deactivate(`${payload}.${signature}`, CUSTOMER).released).toBe(true)
  })
})

describe('key generation against the client validator', () => {
  it('every generated key validates and is already canonical', () => {
    for (let index = 0; index < 2000; index += 1) {
      const key = generateKey((max) => randomInt(max))
      expect(validateKey(key)).toEqual({ ok: true, key, problem: null })
    }
  })

  it('survives a random body that begins with the prefix', () => {
    // `RECX` is spelled from the key alphabet, so a body can start with it,
    // and the normaliser strips the prefix when it leads the input. A body
    // that happens to start that way must not be mistaken for a prefix.
    const body = 'RECXBCDEFGHJKMNPQRS'
    const picks = picksFor(body, KEY_ALPHABET)
    let index = 0
    const key = generateKey(() => picks[index++] ?? 0)

    expect(key.startsWith('RECX-RECXB-')).toBe(true)
    expect(validateKey(key)).toEqual({ ok: true, key, problem: null })
  })

  it('refuses an out-of-range random index instead of producing a short key', () => {
    expect(() => generateKey(() => KEY_ALPHABET.length)).toThrow(RangeError)
    expect(() => generateKey(() => -1)).toThrow(RangeError)
    expect(() => generateKey(() => 0.5)).toThrow(RangeError)
  })
})

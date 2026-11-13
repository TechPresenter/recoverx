import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { ActivationClaimsSchema, type ActivationClaims } from '@shared/types/license'
import { parseJson } from '@shared/utils/json'

/**
 * Activation tokens.
 *
 * A token is `base64url(claims JSON).base64url(Ed25519 signature)`. The shape
 * resembles a JWT deliberately — it is familiar and easy to issue — but the
 * algorithm is fixed in code rather than read from a header. Trusting an
 * attacker-supplied `alg` field is the flaw that has broken JWT libraries
 * repeatedly, most notoriously by accepting `none`, and there is no reason to
 * inherit it here.
 *
 * Verification is entirely local. That is what allows a machine with no network
 * access — often exactly the machine a technician is recovering data from — to
 * be activated from a file, with no weaker guarantee than an online one.
 *
 * Ed25519 comes from `node:crypto`, so this adds no dependency and no native
 * build step.
 */

export type TokenFailure =
  | 'malformed'
  | 'bad-signature'
  | 'bad-claims'
  | 'no-public-key'
  | 'expired'
  | 'wrong-machine'
  | 'wrong-key'

export type TokenResult =
  | { readonly ok: true; readonly claims: ActivationClaims }
  | { readonly ok: false; readonly failure: TokenFailure }

export interface VerifyOptions {
  /** Vendor public key, SPKI DER encoded as base64. */
  readonly publicKey: string
  /** Fingerprint of the machine the token must name. */
  readonly machineId: string
  /** Licence key the token must have been issued against, when known. */
  readonly expectedKey?: string | undefined
  /** Current time, injected so expiry is testable. */
  readonly now: number
}

/**
 * Parsing a token without checking anything.
 *
 * Separated from verification so the two cannot be confused at a call site:
 * every caller of this must decide for itself what to do about the signature,
 * and every caller that wants a trustworthy answer calls `verifyToken`.
 */
export function decodeTokenClaims(token: string): ActivationClaims | null {
  const parts = token.trim().split('.')
  if (parts.length !== 2) return null

  const [payload] = parts
  if (payload === undefined || payload.length === 0) return null

  const decoded = Buffer.from(payload, 'base64url').toString('utf8')
  const parsed = parseJson(decoded, ActivationClaimsSchema)

  return parsed.ok ? parsed.data : null
}

/**
 * Verify a token and return its claims.
 *
 * The order of the checks matters: the signature is validated before any claim
 * is read for a decision. Reading the edition out of an unverified token and
 * checking the signature afterwards would let a forged token select its own
 * entitlement for as long as the window between the two lasted.
 */
export function verifyToken(token: string, options: VerifyOptions): TokenResult {
  if (options.publicKey.trim().length === 0) {
    // A build with no key configured cannot tell a real token from a forged
    // one, so it must trust neither.
    return { ok: false, failure: 'no-public-key' }
  }

  const parts = token.trim().split('.')
  const payload = parts[0]
  const signature = parts[1]

  if (parts.length !== 2 || payload === undefined || signature === undefined) {
    return { ok: false, failure: 'malformed' }
  }

  let key: KeyObject
  try {
    key = createPublicKey({
      key: Buffer.from(options.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    return { ok: false, failure: 'no-public-key' }
  }

  let signatureValid: boolean
  try {
    // Ed25519 takes a null algorithm: the hash is part of the scheme.
    signatureValid = verify(
      null,
      Buffer.from(payload, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return { ok: false, failure: 'bad-signature' }
  }

  if (!signatureValid) return { ok: false, failure: 'bad-signature' }

  const claims = decodeTokenClaims(token)
  if (claims === null) return { ok: false, failure: 'bad-claims' }

  // Binding to the machine is what makes a copied token worthless.
  if (claims.machine !== options.machineId) {
    return { ok: false, failure: 'wrong-machine' }
  }

  if (options.expectedKey !== undefined && claims.key !== options.expectedKey) {
    return { ok: false, failure: 'wrong-key' }
  }

  if (claims.expiresAt !== null && claims.expiresAt <= options.now) {
    // Reported separately from an invalid token: an expired licence is a
    // renewal, and telling that customer their licence is "invalid" is both
    // wrong and the sort of thing that loses a renewal.
    return { ok: false, failure: 'expired' }
  }

  return { ok: true, claims }
}

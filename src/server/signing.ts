import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { ActivationClaimsSchema, type ActivationClaims } from '@shared/types/license'
import { parseJson } from '@shared/utils/json'

/**
 * Activation token issuance.
 *
 * This is the other half of `src/main/licensing/activation-token.ts`, and the
 * format must match it byte for byte:
 *
 *     base64url(JSON claims) "." base64url(Ed25519 signature)
 *
 * where the signature covers the ASCII bytes of the *encoded* payload string,
 * not the JSON it decodes to. Signing the encoded form means the verifier never
 * has to re-serialise anything before checking it, so there is no question of
 * two JSON encoders disagreeing about key order or whitespace.
 *
 * The cross-compatibility test in `tests/unit/server` issues tokens here and
 * verifies them with the desktop client's own verifier. If either side changes
 * the format, that test is what fails — before a release, rather than on every
 * customer's machine after one.
 */

export type SignatureFailure = 'malformed' | 'bad-signature' | 'bad-claims'

export type SignatureCheck =
  | { readonly ok: true; readonly claims: ActivationClaims }
  | { readonly ok: false; readonly failure: SignatureFailure }

export interface TokenSigner {
  /** Ed25519 public key, SPKI DER encoded as base64 — the value builds embed. */
  readonly publicKey: string
  /** Short, comparable identifier of the public key, for logs and the CLI. */
  readonly fingerprint: string
  /** Sign claims into a token the desktop client will accept. */
  issue(claims: ActivationClaims): string
  /**
   * Check that a token was signed by this key and return its claims.
   *
   * Deliberately ignores expiry and machine binding: it exists for
   * deactivation, where an expired licence must still be able to give its seat
   * back and the request does not come from the machine's own verifier.
   */
  verifySignature(token: string): SignatureCheck
}

/** Tokens never come near this size; the bound keeps a hostile one cheap. */
const MAX_TOKEN_LENGTH = 4096

const BASE64URL = /^[A-Za-z0-9_-]+$/u

/**
 * Parse a PKCS#8 PEM private key and insist that it is Ed25519.
 *
 * Accepts the PEM with its line breaks written as literal `\n` sequences too,
 * because that is how several container platforms deliver a multi-line secret
 * through a single environment variable.
 */
export function parsePrivateKey(pem: string): KeyObject {
  const text = pem.includes('\n') ? pem : pem.replace(/\\n/gu, '\n')

  let key: KeyObject
  try {
    key = createPrivateKey({ key: text.trim(), format: 'pem' })
  } catch (error) {
    throw new Error(
      'The signing key is not a readable PEM private key. Use the license-signing-key.pem file written by `npm run licensing:keys`.',
      { cause: error },
    )
  }

  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `The signing key is a ${key.asymmetricKeyType ?? 'unknown'} key, but RecoverX activations are signed with Ed25519. Use the key written by \`npm run licensing:keys\`.`,
    )
  }

  return key
}

/** The public half of a private key, in the encoding the client embeds. */
export function publicKeyOf(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
}

/**
 * A fingerprint of a public key, in the `SHA256:…` style SSH uses.
 *
 * Printed at start-up and by `admin public-key`, so an operator can confirm at
 * a glance that a server and a build agree on the key without comparing sixty
 * characters of base64 by eye.
 */
export function fingerprintOf(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64.replace(/\s+/gu, ''), 'base64')
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/u, '')}`
}

/**
 * Whether two base64 public keys are the same key.
 *
 * Compares the decoded bytes, so line wrapping, stray whitespace or a missing
 * padding character in a pasted value do not cause a false mismatch.
 */
export function samePublicKey(a: string, b: string): boolean {
  const left = Buffer.from(a.replace(/\s+/gu, ''), 'base64')
  const right = Buffer.from(b.replace(/\s+/gu, ''), 'base64')
  return left.length > 0 && left.equals(right)
}

export function createTokenSigner(privateKey: KeyObject): TokenSigner {
  const publicKey = publicKeyOf(privateKey)
  const publicKeyObject = createPublicKey(privateKey)

  return {
    publicKey,
    fingerprint: fingerprintOf(publicKey),

    issue(claims: ActivationClaims): string {
      // Re-validated even though every caller builds the claims itself: a token
      // the client would reject as `bad-claims` is worse than an error here,
      // because the customer would see "not genuine" for a licence they paid for.
      const checked = ActivationClaimsSchema.parse(claims)

      // Built field by field so the encoded order is fixed and documented.
      const ordered: ActivationClaims = {
        v: checked.v,
        edition: checked.edition,
        key: checked.key,
        machine: checked.machine,
        issuedAt: checked.issuedAt,
        expiresAt: checked.expiresAt,
        registeredTo: checked.registeredTo,
      }

      const payload = Buffer.from(JSON.stringify(ordered), 'utf8').toString('base64url')
      // Ed25519 takes a null digest: the hash is part of the scheme.
      const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url')

      return `${payload}.${signature}`
    },

    verifySignature(token: string): SignatureCheck {
      const trimmed = token.trim()
      if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_LENGTH) {
        return { ok: false, failure: 'malformed' }
      }

      const parts = trimmed.split('.')
      const payload = parts[0]
      const signature = parts[1]

      if (
        parts.length !== 2 ||
        payload === undefined ||
        signature === undefined ||
        !BASE64URL.test(payload) ||
        !BASE64URL.test(signature)
      ) {
        return { ok: false, failure: 'malformed' }
      }

      let valid: boolean
      try {
        valid = verify(
          null,
          Buffer.from(payload, 'utf8'),
          publicKeyObject,
          Buffer.from(signature, 'base64url'),
        )
      } catch {
        return { ok: false, failure: 'bad-signature' }
      }

      // The signature is checked before a single claim is read, for the same
      // reason the client does: nothing an attacker wrote is acted on until
      // it is known not to have been written by an attacker.
      if (!valid) return { ok: false, failure: 'bad-signature' }

      const decoded = parseJson(
        Buffer.from(payload, 'base64url').toString('utf8'),
        ActivationClaimsSchema,
      )

      return decoded.ok ? { ok: true, claims: decoded.data } : { ok: false, failure: 'bad-claims' }
    },
  }
}

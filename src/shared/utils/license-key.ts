import { KEY_GROUP_COUNT, KEY_GROUP_LENGTH, KEY_PREFIX } from '../types/license'

/**
 * Licence key format.
 *
 * `RECX-XXXXX-XXXXX-XXXXX-XXXXX`, where the final character is a checksum over
 * everything before it.
 *
 * The checksum earns its place at the support desk rather than in security: it
 * catches a mistyped key instantly and locally, so a customer who transposed
 * two characters is told so immediately instead of being told "activation
 * failed" after a network round trip that they will read as "you did not pay".
 *
 * The alphabet excludes the characters people confuse when copying from an
 * invoice — I and 1, O and 0, plus U to avoid accidental profanity. Input is
 * normalised through the same substitutions, so a customer who types the letter
 * O where a zero belongs is silently corrected rather than rejected.
 *
 * This lives in the shared kernel so the renderer can validate as the user
 * types, without a round trip to the main process for every keystroke.
 */

/** Crockford-style alphabet: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** What a human is likely to type instead of the intended character. */
const SUBSTITUTIONS: Readonly<Record<string, string>> = {
  I: '1',
  L: '1',
  O: '0',
  U: 'V',
}

const BODY_LENGTH = KEY_GROUP_COUNT * KEY_GROUP_LENGTH

/**
 * Reduce free-form input to canonical characters.
 *
 * Accepts what people actually paste: lower case, spaces, missing or extra
 * hyphens, and the confusable characters above.
 */
export function normalizeKeyInput(input: string): string {
  const compact = compactKeyInput(input)

  /*
   * The prefix is separated before any substitution is applied. The
   * substitutions describe how customers mistype the random part of a key, not
   * the fixed product tag. `RECX` was chosen to contain none of the characters
   * they rewrite, but a tag that did would be rewritten into something no key
   * starts with, and every key ever issued would then be rejected as belonging
   * to another product.
   */
  const prefix = PREFIX_FORMS.find((form) => compact.startsWith(form))
  const body = prefix === undefined ? compact : compact.slice(prefix.length)

  let normalized = ''
  for (const character of body) {
    normalized += SUBSTITUTIONS[character] ?? character
  }

  return (prefix === undefined ? '' : KEY_PREFIX) + normalized
}

/** Upper case, with the spaces and hyphens people type between groups removed. */
function compactKeyInput(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/gu, '')
}

/**
 * Spellings of the prefix that should be recognised.
 *
 * A customer who types the tag with the same confusions the body allows still
 * gets a working key rather than "that key is for a different product".
 *
 * `RECX` has no confusable spelling, so today this holds the prefix alone. It
 * is still derived rather than written out, so a future tag containing an I,
 * L, O or U is forgiven the same way without anyone remembering to list its
 * misspelling here.
 */
const PREFIX_FORMS: readonly string[] = [
  ...new Set([
    KEY_PREFIX,
    [...KEY_PREFIX].map((character) => SUBSTITUTIONS[character] ?? character).join(''),
  ]),
]

/**
 * Format a key for display, in groups.
 *
 * Copes with a partially entered key as well as a complete one. A key field
 * reformatting on every keystroke uses `formatKeyAsTyped`, which leaves a
 * prefix that is still being typed alone; this one always shows the prefix,
 * and the licence server's twin of it (server-php `LicenseKey::format`) is
 * held to the same answers by the contract tests.
 */
export function formatKey(input: string): string {
  const normalized = normalizeKeyInput(input)
  const body = normalized.startsWith(KEY_PREFIX) ? normalized.slice(KEY_PREFIX.length) : normalized

  const groups: string[] = []
  for (let index = 0; index < body.length; index += KEY_GROUP_LENGTH) {
    groups.push(body.slice(index, index + KEY_GROUP_LENGTH))
  }

  return [KEY_PREFIX, ...groups].filter((group) => group.length > 0).join('-')
}

/**
 * Format what is in a key field after each keystroke.
 *
 * `formatKey` puts the prefix in front of anything that does not already start
 * with it, which is right for a key body pasted on its own but wrong for a
 * customer typing the key from a receipt: "R" would become "RECX-R", the
 * prefix they go on to type would land in the key body, and the field could
 * never be emptied with Backspace — "REC" turns straight back into "RECX-REC".
 * So while the input could still be the start of the prefix, it is left as
 * typed, and only once it departs from the prefix is it formatted.
 */
export function formatKeyAsTyped(input: string): string {
  return isPartialKeyPrefix(input) ? compactKeyInput(input) : formatKey(input)
}

/**
 * Whether the input could still be the start of the prefix: empty, or "R",
 * "RE", "REC" on the way to `RECX`.
 *
 * Such input is an incomplete key, not another product's, which is how
 * `validateKey` would otherwise describe it.
 */
export function isPartialKeyPrefix(input: string): boolean {
  const compact = compactKeyInput(input)
  return PREFIX_FORMS.some((form) => compact.length < form.length && form.startsWith(compact))
}

/**
 * Compute the checksum character for a key body.
 *
 * A weighted sum, so transposing two adjacent characters — the commonest typing
 * error, and one a plain sum cannot see — changes the result.
 */
export function checksumCharacter(body: string): string {
  let total = 0

  for (let index = 0; index < body.length; index += 1) {
    const value = ALPHABET.indexOf(body[index] ?? '')
    if (value < 0) return ''

    total += value * (index + 1)
  }

  return ALPHABET[total % ALPHABET.length] ?? ''
}

export type KeyProblem = 'empty' | 'wrong-product' | 'wrong-length' | 'bad-character' | 'checksum'

export interface KeyValidation {
  readonly ok: boolean
  /** The canonical form, present whenever the key is well formed. */
  readonly key: string | null
  readonly problem: KeyProblem | null
}

/** Check a key's shape and checksum. Says nothing about whether it was sold. */
export function validateKey(input: string): KeyValidation {
  const normalized = normalizeKeyInput(input)

  if (normalized.length === 0) return { ok: false, key: null, problem: 'empty' }

  if (!normalized.startsWith(KEY_PREFIX)) {
    return { ok: false, key: null, problem: 'wrong-product' }
  }

  const body = normalized.slice(KEY_PREFIX.length)

  if (body.length !== BODY_LENGTH) {
    return { ok: false, key: null, problem: 'wrong-length' }
  }

  for (const character of body) {
    if (!ALPHABET.includes(character)) {
      return { ok: false, key: null, problem: 'bad-character' }
    }
  }

  const payload = body.slice(0, BODY_LENGTH - 1)
  const expected = checksumCharacter(payload)

  if (expected.length === 0 || expected !== body[BODY_LENGTH - 1]) {
    return { ok: false, key: null, problem: 'checksum' }
  }

  return { ok: true, key: formatKey(normalized), problem: null }
}

/**
 * Hide all but the last group.
 *
 * Enough for a customer to confirm which licence is in use, not enough for a
 * screenshot or a support transcript to leak a working key.
 */
export function maskKey(key: string): string {
  const formatted = formatKey(key)
  const groups = formatted.split('-')

  if (groups.length <= 2) return formatted

  const last = groups[groups.length - 1] ?? ''
  const hidden = groups.slice(1, -1).map((group) => '•'.repeat(group.length))

  return [groups[0], ...hidden, last].join('-')
}

/**
 * Build a key body with a valid checksum from a payload.
 *
 * The issuing side of the same rule. Exported so the vendor's key generator and
 * the client's validator can never drift apart — a mismatch there would reject
 * every key ever sold.
 */
export function completeKey(payload: string): string | null {
  const normalized = normalizeKeyInput(payload)
  const body = normalized.startsWith(KEY_PREFIX) ? normalized.slice(KEY_PREFIX.length) : normalized

  if (body.length !== BODY_LENGTH - 1) return null

  for (const character of body) {
    if (!ALPHABET.includes(character)) return null
  }

  const checksum = checksumCharacter(body)
  if (checksum.length === 0) return null

  return formatKey(KEY_PREFIX + body + checksum)
}

/**
 * The characters a key body is drawn from.
 *
 * Exported for the vendor's key generator and its tests, so the issuing side
 * never keeps a second copy of the alphabet that could drift from this one.
 */
export const KEY_ALPHABET: string = ALPHABET

/**
 * Mint a new, well-formed key.
 *
 * `pick` must return a uniformly distributed integer in `[0, maxExclusive)`.
 * It is injected rather than imported because this module is shared with the
 * renderer and must stay free of Node built-ins: the licence server passes
 * `crypto.randomInt`, and a test can pass something deterministic.
 *
 * The payload is completed *with* the product prefix in front of it. Completing
 * the bare payload would be wrong for roughly one key in a million: `RECX` is
 * spelled entirely from the key alphabet, so a payload can happen to begin with
 * it, and `normalizeKeyInput` would then take those four characters for the
 * prefix, strip them, and leave a body too short to checksum.
 */
export function generateKey(pick: (maxExclusive: number) => number): string {
  let payload = ''

  for (let index = 0; index < BODY_LENGTH - 1; index += 1) {
    const choice = pick(ALPHABET.length)
    const character = Number.isInteger(choice) ? ALPHABET[choice] : undefined

    if (character === undefined) {
      throw new RangeError(
        `Key generator returned ${String(choice)}, outside 0..${ALPHABET.length - 1}`,
      )
    }

    payload += character
  }

  const key = completeKey(KEY_PREFIX + payload)
  if (key === null) throw new Error('A generated licence key could not be completed')

  return key
}

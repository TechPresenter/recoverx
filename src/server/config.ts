import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { describeUnknown } from '@shared/utils/errors'
import { formatZodIssues } from '@shared/utils/json'
import { DEFAULT_SELF_RELEASE_POLICY, type SelfReleasePolicy } from './authority'
import { DEFAULT_EVENT_RETENTION_DAYS, MAX_EVENT_RETENTION_DAYS } from './retention'
import {
  createTokenSigner,
  fingerprintOf,
  parsePrivateKey,
  samePublicKey,
  type TokenSigner,
} from './signing'

/**
 * Licence server configuration, read from the environment.
 *
 * Twelve-factor style, because the two places this runs — a container with
 * secrets injected as variables or files, and an operator's shell running the
 * admin CLI — both speak environment variables natively.
 *
 * Validation is strict and happens before anything listens. A licence server
 * that starts with a half-valid configuration fails later and worse: a missing
 * signing key turns into a 500 on the first customer's activation, and a
 * mismatched one turns into every activation "succeeding" with a token the
 * desktop application then rejects as not genuine.
 */

/**
 * Defaults for everything that has a safe one.
 *
 * The database path deliberately has none. The file holds customers' names,
 * e-mail addresses, licence keys and activation addresses, and a default
 * relative to the working directory put it inside the source checkout whenever
 * `npm run licensing:*` was run from there — one `git add -A` away from
 * publishing that personal data. Every real deployment names the file anyway
 * (the Docker image sets it), so requiring it costs nothing there.
 */
export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  /** Requests a single client may make in a burst. */
  rateLimitBurst: 20,
  /** Sustained requests per minute per client once the burst is spent. */
  rateLimitPerMinute: 30,
  /** Self-service releases per licence key in the window; see `SelfReleasePolicy`. */
  selfReleaseLimit: DEFAULT_SELF_RELEASE_POLICY.limit,
  /** Length of that rolling window, in days. */
  selfReleaseWindowDays: DEFAULT_SELF_RELEASE_POLICY.windowDays,
  /** Days the activation history is kept: the 13 months the privacy policy promises. */
  eventRetentionDays: DEFAULT_EVENT_RETENTION_DAYS,
} as const

/** Longest self-service release window accepted: ten years, to catch a misplaced digit. */
export const MAX_SELF_RELEASE_WINDOW_DAYS = 3650

/** Shortest admin token accepted: 32 characters of `base64url` is 192 bits. */
export const MIN_ADMIN_TOKEN_LENGTH = 32

/** Visible ASCII, `!` to `~`: what an HTTP client sends unaltered after `Bearer `. */
const ADMIN_TOKEN_CHARACTERS = /^[\x21-\x7e]+$/u

/** How an operator can make a token long enough, quoted in the error. */
const ADMIN_TOKEN_HINT =
  "generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\""

/** Raised for any configuration problem; the message is the whole explanation. */
export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConfigError'
  }
}

/** An unset variable and an empty one mean the same thing in every deployment tool. */
const blank = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value

const optionalText = z.preprocess(blank, z.string().trim().optional())

const flag = z.preprocess(
  blank,
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'], {
      message: 'must be true or false',
    })
    .optional(),
)

const boundedInteger = (fallback: number, min: number, max: number): z.ZodType<number> =>
  z.preprocess(
    blank,
    z.coerce
      .number({ message: 'must be a whole number' })
      .int({ message: 'must be a whole number' })
      .min(min, { message: `must be at least ${min}` })
      .max(max, { message: `must be at most ${max}` })
      .default(fallback),
  )

const positiveInteger = (fallback: number, max: number): z.ZodType<number> =>
  boundedInteger(fallback, 1, max)

const EnvironmentSchema = z.object({
  LICENSE_SIGNING_KEY_FILE: optionalText,
  // Not trimmed by the schema: the PEM parser copes with surrounding whitespace,
  // and trimming here would hide an accidental quote character in the error.
  LICENSE_SIGNING_KEY: z.preprocess(blank, z.string().optional()),
  LICENSE_DB_FILE: optionalText,
  HOST: optionalText,
  PORT: z.preprocess(
    blank,
    z.coerce
      .number({ message: 'must be a port number' })
      .int({ message: 'must be a port number' })
      .min(0, { message: 'must be between 0 and 65535' })
      .max(65535, { message: 'must be between 0 and 65535' })
      .optional(),
  ),
  LICENSE_ADMIN_TOKEN: z.preprocess(
    blank,
    z
      .string()
      .trim()
      .min(MIN_ADMIN_TOKEN_LENGTH, {
        message: `must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters when set (${ADMIN_TOKEN_HINT})`,
      })
      // The token travels as `Authorization: Bearer <token>`, which the server
      // reads up to the first space, and HTTP header values are Latin-1. A
      // passphrase with spaces or a non-ASCII character could therefore never
      // match; refusing it here turns a silent "every webhook gets 401" into a
      // start-up error.
      .regex(ADMIN_TOKEN_CHARACTERS, {
        message: `must be printable ASCII with no spaces, because it is sent in an HTTP header (${ADMIN_TOKEN_HINT})`,
      })
      .optional(),
  ),
  LICENSE_TRUST_PROXY: flag,
  RECOVERX_LICENSE_PUBLIC_KEY: optionalText,
  LICENSE_RATE_LIMIT_BURST: positiveInteger(DEFAULTS.rateLimitBurst, 100_000),
  LICENSE_RATE_LIMIT_PER_MINUTE: positiveInteger(DEFAULTS.rateLimitPerMinute, 1_000_000),
  // 0 is meaningful here — it turns self-service release off — so the range
  // starts there, unlike the rate limits, where 0 would refuse everyone.
  LICENSE_SELF_RELEASE_LIMIT: boundedInteger(DEFAULTS.selfReleaseLimit, 0, 1_000_000),
  LICENSE_SELF_RELEASE_WINDOW_DAYS: positiveInteger(
    DEFAULTS.selfReleaseWindowDays,
    MAX_SELF_RELEASE_WINDOW_DAYS,
  ),
  LICENSE_EVENT_RETENTION_DAYS: positiveInteger(
    DEFAULTS.eventRetentionDays,
    MAX_EVENT_RETENTION_DAYS,
  ),
})

export type SigningKeySource =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'inline'; readonly pem: string }

export interface ServerConfig {
  /** Where the private key comes from, or `null` when none is configured. */
  readonly signingKey: SigningKeySource | null
  /**
   * Absolute path of the SQLite database, or `null` when LICENSE_DB_FILE is
   * unset. Code that opens the database goes through `requireDatabaseFile`;
   * the CLI's `public-key`, which never touches it, does not need one.
   */
  readonly dbFile: string | null
  readonly host: string
  readonly port: number
  /** `null` disables the admin HTTP API entirely. */
  readonly adminToken: string | null
  /** Whether the first `X-Forwarded-For` hop is the client address. */
  readonly trustProxy: boolean
  /** The public key shipped builds embed, when the operator has supplied it. */
  readonly expectedPublicKey: string | null
  readonly rateLimit: { readonly burst: number; readonly perMinute: number }
  /** How often a customer may move a licence between computers themselves. */
  readonly selfRelease: SelfReleasePolicy
  /**
   * Days an activation-history event is kept before it is deleted. Never
   * shorter than `selfRelease.windowDays`; see retention.ts.
   */
  readonly eventRetentionDays: number
}

/**
 * Read and validate the configuration.
 *
 * Every problem is reported at once rather than the first one only, so an
 * operator fixing a deployment does not have to restart it once per typo.
 */
export function readConfig(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): ServerConfig {
  const parsed = EnvironmentSchema.safeParse(env)

  if (!parsed.success) {
    throw new ConfigError(
      `The licence server configuration is invalid: ${formatZodIssues(parsed.error.issues)}`,
    )
  }

  const values = parsed.data

  if (values.LICENSE_SIGNING_KEY_FILE !== undefined && values.LICENSE_SIGNING_KEY !== undefined) {
    // Refusing beats picking one: whichever was chosen, the operator would be
    // surprised by it on the day the two disagree.
    throw new ConfigError(
      'Set LICENSE_SIGNING_KEY_FILE or LICENSE_SIGNING_KEY, not both — it is not clear which one should sign.',
    )
  }

  let signingKey: SigningKeySource | null = null
  if (values.LICENSE_SIGNING_KEY_FILE !== undefined) {
    signingKey = { kind: 'file', path: absolute(values.LICENSE_SIGNING_KEY_FILE, cwd) }
  } else if (values.LICENSE_SIGNING_KEY !== undefined) {
    signingKey = { kind: 'inline', pem: values.LICENSE_SIGNING_KEY }
  }

  if (values.LICENSE_EVENT_RETENTION_DAYS < values.LICENSE_SELF_RELEASE_WINDOW_DAYS) {
    // Moves are counted from the event log, so deleting it sooner than the
    // window would let the allowance forget moves made inside it — and give a
    // customer who had used it up a fresh one. Lengthening the window is the
    // usual way to get here, which is why the message names both settings.
    throw new ConfigError(
      `LICENSE_EVENT_RETENTION_DAYS (${values.LICENSE_EVENT_RETENTION_DAYS}) must be at least LICENSE_SELF_RELEASE_WINDOW_DAYS (${values.LICENSE_SELF_RELEASE_WINDOW_DAYS}), because self-service moves are counted from the event log. Raise LICENSE_EVENT_RETENTION_DAYS — and the retention period in the privacy policy with it — or shorten the window.`,
    )
  }

  const trust = values.LICENSE_TRUST_PROXY

  return {
    signingKey,
    dbFile: values.LICENSE_DB_FILE === undefined ? null : absolute(values.LICENSE_DB_FILE, cwd),
    host: values.HOST ?? DEFAULTS.host,
    port: values.PORT ?? DEFAULTS.port,
    adminToken: values.LICENSE_ADMIN_TOKEN ?? null,
    trustProxy: trust === 'true' || trust === '1' || trust === 'yes' || trust === 'on',
    expectedPublicKey: values.RECOVERX_LICENSE_PUBLIC_KEY ?? null,
    rateLimit: {
      burst: values.LICENSE_RATE_LIMIT_BURST,
      perMinute: values.LICENSE_RATE_LIMIT_PER_MINUTE,
    },
    selfRelease: {
      limit: values.LICENSE_SELF_RELEASE_LIMIT,
      windowDays: values.LICENSE_SELF_RELEASE_WINDOW_DAYS,
    },
    eventRetentionDays: values.LICENSE_EVENT_RETENTION_DAYS,
  }
}

/**
 * Load the signing key and build the signer.
 *
 * This is also where the start-up safety check lives. When the operator has
 * told the server which public key shipped builds carry, a signing key whose
 * public half differs is refused outright: every token it issued would be
 * rejected by every copy of the application as "not genuine", and the customer
 * who just paid would be the first to find out.
 */
export function loadSigner(config: ServerConfig): TokenSigner {
  const source = config.signingKey

  if (source === null) {
    throw new ConfigError(
      'No signing key is configured. Set LICENSE_SIGNING_KEY_FILE to the path of the license-signing-key.pem written by `npm run licensing:keys`, or LICENSE_SIGNING_KEY to its contents.',
    )
  }

  let pem: string
  if (source.kind === 'file') {
    try {
      pem = readFileSync(source.path, 'utf8')
    } catch (error) {
      throw new ConfigError(
        `LICENSE_SIGNING_KEY_FILE points to ${source.path}, which could not be read: ${describeUnknown(error)}`,
        { cause: error },
      )
    }
  } else {
    pem = source.pem
  }

  let signer: TokenSigner
  try {
    signer = createTokenSigner(parsePrivateKey(pem))
  } catch (error) {
    const origin =
      source.kind === 'file' ? `The file at ${source.path}` : 'The value of LICENSE_SIGNING_KEY'
    throw new ConfigError(`${origin} is not usable: ${describeUnknown(error)}`, { cause: error })
  }

  const expected = config.expectedPublicKey
  if (expected !== null && !samePublicKey(expected, signer.publicKey)) {
    throw new ConfigError(
      [
        'The signing key does not match RECOVERX_LICENSE_PUBLIC_KEY.',
        'Every desktop build compiled with that public key would reject the activations this server issues.',
        `Signing key's public key: ${signer.publicKey} (${signer.fingerprint})`,
        `RECOVERX_LICENSE_PUBLIC_KEY: ${expected} (${fingerprintOf(expected)})`,
      ].join(' '),
    )
  }

  return signer
}

/**
 * The database path, or a ConfigError saying how to set one.
 *
 * See `DEFAULTS` for why there is no fallback. The example path in the
 * message is outside any checkout on purpose, so copying it is safe.
 */
export function requireDatabaseFile(config: ServerConfig): string {
  if (config.dbFile === null) {
    throw new ConfigError(
      'LICENSE_DB_FILE is not set. Point it at the licence database (the admin CLI also accepts --db <file>), for example /var/lib/recoverx-licensing/licences.db. Keep it outside any source checkout: the file holds customer names, e-mail addresses and licence keys.',
    )
  }
  return config.dbFile
}

/**
 * Create the directory that will hold the database.
 *
 * SQLite creates the file but not its parent, and "unable to open database
 * file" is a famously unhelpful way to learn that a volume was not mounted.
 */
export function ensureDatabaseDirectory(dbFile: string): void {
  try {
    mkdirSync(dirname(dbFile), { recursive: true })
  } catch (error) {
    throw new ConfigError(
      `The database directory ${dirname(dbFile)} could not be created: ${describeUnknown(error)}`,
      { cause: error },
    )
  }
}

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

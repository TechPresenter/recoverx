import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { ENTITLEMENTS, LicenseEditionSchema, type ActivationClaims } from '@shared/types/license'
import { formatZodIssues } from '@shared/utils/json'
import { generateKey, maskKey, validateKey } from '@shared/utils/license-key'
import { LicenseError } from './errors'
import { MAX_TERM_DAYS, addDays, resolveExtension, resolveNewExpiry } from './expiry'
import { CustomerMessages, describeKeyProblem, formatCustomerDate } from './messages'
import type { TokenSigner } from './signing'
import type {
  ActivationRecord,
  EventRecord,
  EventType,
  LicenseRecord,
  LicenseStore,
  LicenseSummary,
  PaidEdition,
} from './store'

/**
 * The licensing rules.
 *
 * Everything that decides whether a customer gets a token lives here, behind a
 * store and a signer that are passed in and a clock that is injected. The HTTP
 * server and the admin CLI are thin shells around this class, so the rules are
 * tested once, without a network or a terminal, and cannot differ between an
 * online activation and one issued by hand for an air-gapped machine.
 */

/** The product identifier the desktop client sends. */
export const PRODUCT_ID = 'recoverx'

/**
 * Shape of a machine identifier the desktop client can produce.
 *
 * Twenty-four characters of upper-cased base64url, grouped by four with
 * hyphens (see src/main/licensing/machine-id.ts). Base64url itself contains `-`
 * and `_`, so the pattern cannot assume a hyphen is always a separator; the
 * length range leaves room for a longer identifier in a future client.
 */
export const MACHINE_ID_PATTERN = /^[A-Z0-9_-]{24,40}$/u

/** Most licences one request may mint. A bulk order larger than this is a script. */
export const MAX_BATCH = 1000

/** Largest finite seat count accepted. */
export const MAX_SEATS = 1_000_000

/** Recent events returned with a licence. */
const SHOWN_EVENTS = 50

/** Attempts at drawing a key that is not already taken. */
const KEY_ATTEMPTS = 8

/**
 * How often a customer may move a licence between computers on their own.
 *
 * Why there is a limit at all: an activation token is verified offline and
 * cannot be recalled. A customer who backs up `license.json`, deactivates (so
 * the server frees the seat), and then restores the backup has a licensed
 * computer *and* a free seat — and can repeat that for as many computers as
 * they like. Counting self-service releases bounds how far one seat can be
 * stretched that way; past the allowance, moving the licence goes through
 * support, where a person sees the pattern.
 *
 * The allowance is generous on purpose (a new PC, a reinstall, a repair and a
 * spare a year), because the honest customer replacing a computer is far more
 * common than the one gaming it, and they are the one who meets the refusal.
 */
export interface SelfReleasePolicy {
  /**
   * Self-service releases allowed per licence key within the window.
   * `0` turns self-service release off: every move goes through support.
   */
  readonly limit: number
  /** Length of the rolling window, in days. */
  readonly windowDays: number
}

export const DEFAULT_SELF_RELEASE_POLICY: SelfReleasePolicy = { limit: 4, windowDays: 365 }

/** Where a licence stands against the self-service release allowance. */
export interface SelfReleaseStanding {
  /** Self-service releases inside the current window. */
  readonly recent: number
  /**
   * Releases allowed in the window; `0` when self-service release is off, and
   * `null` for a licence with unlimited seats, which is never limited.
   */
  readonly limit: number | null
  readonly windowDays: number
}

/**
 * JSON `null` and an absent field mean the same thing for optional text.
 *
 * The return type is left to inference on purpose: annotating it as a plain
 * `ZodType` would erase the input type, and every field built from it would
 * then become a required `unknown` in `CreateLicensesInput`.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) =>
      value === null || value === undefined || value === '' ? undefined : value,
    )

/**
 * What it takes to mint licences.
 *
 * Shared by the admin HTTP API, which feeds it a JSON body, and the CLI, which
 * builds the same object from flags — so both validate identically. Unknown
 * fields are refused rather than ignored: a webhook that sends `registered_to`
 * instead of `registeredTo` should fail loudly, not mint a licence with no name.
 */
export const CreateLicensesSchema = z.strictObject({
  edition: LicenseEditionSchema,
  count: z.number().int().min(1).max(MAX_BATCH).nullish(),
  /** A number, `null` for unlimited, or absent for the edition's default. */
  seats: z.number().int().min(1).max(MAX_SEATS).nullable().optional(),
  /** `YYYY-MM-DD` (inclusive) or an ISO 8601 instant with a zone. */
  expires: optionalText(64),
  /** Term length from now, in days. */
  days: z.number().int().min(1).max(MAX_TERM_DAYS).nullish(),
  registeredTo: optionalText(200),
  email: z
    .email()
    .max(254)
    .nullish()
    .transform((value) => value ?? undefined),
  orderRef: optionalText(200),
  notes: optionalText(2000),
})

export type CreateLicensesInput = z.input<typeof CreateLicensesSchema>

export const ExtendLicenseSchema = z.strictObject({
  expires: optionalText(64),
  days: z
    .number()
    .int()
    .min(1)
    .max(MAX_TERM_DAYS)
    .nullish()
    .transform((value) => value ?? undefined),
  perpetual: z.boolean().optional(),
})

export type ExtendLicenseInput = z.input<typeof ExtendLicenseSchema>

export interface CreateLicensesResult {
  /**
   * `false` when the order reference had already been fulfilled and the
   * existing licences were returned instead of new ones.
   */
  readonly created: boolean
  readonly licenses: readonly LicenseRecord[]
}

export interface ActivationRequest {
  readonly key: string
  readonly machineId: string
  readonly product: string
}

export interface ActivationResult {
  readonly token: string
  readonly claims: ActivationClaims
  readonly license: LicenseRecord
  /** `true` when the machine already held a seat and no new one was taken. */
  readonly reused: boolean
  readonly activeSeats: number
}

export interface DeactivationResult {
  readonly released: boolean
  readonly key: string
  readonly machineId: string
}

export type LicenseStanding = 'active' | 'revoked' | 'expired'

export interface LicenseDetails {
  readonly license: LicenseRecord
  readonly standing: LicenseStanding
  readonly activeSeats: number
  /** What support needs to answer "why can't I move my licence?". */
  readonly selfReleases: SelfReleaseStanding
  readonly activations: readonly ActivationRecord[]
  readonly events: readonly EventRecord[]
}

export interface ListOptions {
  readonly edition?: PaidEdition | undefined
  readonly search?: string | undefined
  readonly orderRef?: string | undefined
  readonly limit?: number | undefined
  readonly offset?: number | undefined
}

/** Who asked, recorded with every audit event. */
export interface AuditContext {
  readonly actor: 'customer' | 'admin-api' | 'cli'
  readonly ip?: string | null | undefined
}

export interface AuthorityOptions {
  readonly store: LicenseStore
  /**
   * `null` for an authority that only administers licences. Operations that
   * issue or verify tokens then fail with a configuration error, which lets
   * the admin CLI list and revoke licences on a machine that does not hold
   * the signing key.
   */
  readonly signer: TokenSigner | null
  readonly clock?: () => number
  /** Uniform integer in `[0, max)`. Defaults to `crypto.randomInt`. */
  readonly randomIndex?: (maxExclusive: number) => number
  /** Defaults to `DEFAULT_SELF_RELEASE_POLICY`. */
  readonly selfRelease?: SelfReleasePolicy | undefined
}

export class LicenseAuthority {
  private readonly store: LicenseStore
  private readonly signer: TokenSigner | null
  private readonly clock: () => number
  private readonly randomIndex: (maxExclusive: number) => number
  private readonly selfRelease: SelfReleasePolicy

  constructor(options: AuthorityOptions) {
    this.store = options.store
    this.signer = options.signer
    this.clock = options.clock ?? Date.now
    this.randomIndex = options.randomIndex ?? ((max) => randomInt(max))
    this.selfRelease = checkPolicy(options.selfRelease ?? DEFAULT_SELF_RELEASE_POLICY)
  }

  // --- minting ---------------------------------------------------------------

  /**
   * Mint licences.
   *
   * Idempotent per order reference. Payment providers deliver webhooks at
   * least once, and a retried "payment succeeded" must not send the customer a
   * second key for the same purchase: if licences already exist for the order,
   * they are returned and nothing new is created.
   */
  createLicenses(input: CreateLicensesInput, context: AuditContext): CreateLicensesResult {
    const parsed = CreateLicensesSchema.safeParse(input)
    if (!parsed.success) {
      throw new LicenseError('invalid-argument', formatZodIssues(parsed.error.issues))
    }

    const request = parsed.data
    const edition = request.edition

    if (edition === 'free') {
      throw new LicenseError(
        'invalid-argument',
        'The Free edition needs no licence key. Choose professional, business, technician or enterprise.',
      )
    }

    const now = this.clock()
    const expiresAt = resolveNewExpiry(
      { expires: request.expires, days: request.days ?? undefined },
      now,
    )
    // `undefined` means "the edition's default"; `null` means "unlimited".
    const maxActivations =
      request.seats === undefined ? ENTITLEMENTS[edition].activations : request.seats
    const count = request.count ?? 1
    const orderRef = request.orderRef ?? null

    return this.store.transaction(() => {
      if (orderRef !== null) {
        const existing = this.store.findByOrderRef(orderRef)
        if (existing.length > 0) return { created: false, licenses: existing }
      }

      const licenses: LicenseRecord[] = []

      for (let index = 0; index < count; index += 1) {
        const record: LicenseRecord = {
          key: this.drawUnusedKey(),
          edition,
          registeredTo: request.registeredTo ?? null,
          email: request.email ?? null,
          maxActivations,
          expiresAt,
          createdAt: now,
          revokedAt: null,
          revokeReason: null,
          orderRef,
          notes: request.notes ?? null,
        }

        this.store.insertLicense(record)
        this.audit('license-created', record.key, null, context, now, {
          edition,
          seats: maxActivations,
          expiresAt,
          orderRef,
        })
        licenses.push(record)
      }

      return { created: true, licenses }
    })
  }

  /**
   * A key that no licence holds yet.
   *
   * Collisions are astronomically unlikely — the body carries 95 random bits —
   * but a primary-key violation would abort a whole batch, so they are handled
   * rather than assumed away.
   */
  private drawUnusedKey(): string {
    for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
      const key = generateKey(this.randomIndex)

      // The generator and the validator share their alphabet and checksum, but
      // a key the client would refuse must never be sold, so it is checked.
      if (validateKey(key).key !== key) {
        throw new Error('The key generator produced a key the client would not accept')
      }

      if (this.store.getLicense(key) === null) return key
    }

    throw new Error(
      `Could not draw an unused licence key in ${KEY_ATTEMPTS} attempts; the random source is broken`,
    )
  }

  // --- activation ------------------------------------------------------------

  /**
   * Exchange a licence key for a signed activation token.
   *
   * Re-activating a machine that already holds a seat is idempotent: it
   * re-issues a token without taking another seat. That is what a customer
   * does after reinstalling Windows on the same computer, or after a renewal,
   * and neither should cost them a seat.
   */
  activate(request: ActivationRequest, context: AuditContext): ActivationResult {
    if (request.product !== PRODUCT_ID) {
      throw new LicenseError('wrong-product', CustomerMessages.wrongProduct)
    }

    if (!MACHINE_ID_PATTERN.test(request.machineId)) {
      throw new LicenseError('invalid-machine', CustomerMessages.invalidMachine)
    }

    return this.allocate(request.key, request.machineId, context, 'online')
  }

  /**
   * Issue a token for a machine that cannot reach this server.
   *
   * The customer sends the machine identifier shown in the application; the
   * operator runs this and sends back the token. The seat rules are exactly the
   * online ones, so offline activation is not a way around the seat limit.
   */
  issueOffline(keyInput: string, machineInput: string, context: AuditContext): ActivationResult {
    // Typed or pasted by a person, so case and stray whitespace are forgiven.
    // The client's own identifier is always upper case, so this cannot turn a
    // valid identifier into a different valid one.
    const machineId = machineInput.trim().toUpperCase()

    if (!MACHINE_ID_PATTERN.test(machineId)) {
      throw new LicenseError(
        'invalid-machine',
        `"${machineInput.trim()}" is not a RecoverX machine identifier. Ask the customer to copy it from the offline activation screen.`,
      )
    }

    return this.allocate(keyInput, machineId, context, 'offline')
  }

  private allocate(
    keyInput: string,
    machineId: string,
    context: AuditContext,
    mode: 'online' | 'offline',
  ): ActivationResult {
    const signer = this.requireSigner()
    const key = canonicalKey(keyInput)
    const now = this.clock()

    try {
      return this.store.transaction(() => {
        const license = this.store.getLicense(key)
        if (license === null) throw new LicenseError('unknown-key', CustomerMessages.unknownKey)

        assertUsable(license, now)

        const existing = this.store.getActivation(key, machineId)
        const reused = existing !== null && existing.releasedAt === null

        if (reused) {
          this.store.touchSeat(key, machineId, now)
        } else {
          const held = this.store.countActiveSeats(key)

          if (license.maxActivations !== null && held >= license.maxActivations) {
            throw new LicenseError(
              'seats-exhausted',
              CustomerMessages.seatsExhausted(held),
              `${held}/${license.maxActivations} seats held`,
            )
          }

          this.store.claimSeat(key, machineId, now)
        }

        // Built from the licence row as it stands now, read inside this
        // transaction — never from the machine's previous token. That is what
        // makes a re-activation the renewal path: after `extend`, the same
        // computer activating again receives the new end date (and the
        // current edition and owner) without taking another seat.
        const claims: ActivationClaims = {
          v: 1,
          edition: license.edition,
          key,
          machine: machineId,
          issuedAt: now,
          expiresAt: license.expiresAt,
          registeredTo: license.registeredTo,
        }

        const token = signer.issue(claims)
        const activeSeats = this.store.countActiveSeats(key)

        const type: EventType =
          mode === 'offline' ? 'offline-issued' : reused ? 'reactivated' : 'activated'
        this.audit(type, key, machineId, context, now, { seats: activeSeats })

        return { token, claims, license, reused, activeSeats }
      })
    } catch (error) {
      this.auditRefusal(error, key, machineId, context, now)
      throw error
    }
  }

  /**
   * Release the seat named in an activation token — the customer moving their
   * licence off a computer themselves.
   *
   * The token's signature is checked, but not its expiry: a customer whose
   * term has ended must still be able to give the seat back. Releasing a seat
   * that is already free is not an error, so a client that retries after a
   * lost response gets the same answer twice.
   *
   * A release that would exceed the self-service allowance (see
   * `SelfReleasePolicy`) is refused with `self-release-limit` and the seat
   * stays held; the desktop client keeps its licence and shows the sentence.
   * The order of the checks is what keeps the idempotency promise: a seat that
   * is already free answers `released: false` before the allowance is looked
   * at, so a retried release can never turn into a refusal, and it is never
   * counted. The count and the release share one `BEGIN IMMEDIATE`
   * transaction, so two simultaneous releases cannot both take the last one.
   *
   * The administrative paths (`release`, `resetSeats`) do not come through
   * here. They bypass the allowance and record different events, so an
   * operator moving a licence for a customer never uses up the customer's own
   * allowance.
   */
  deactivate(token: string, context: AuditContext): DeactivationResult {
    const signer = this.requireSigner()
    const check = signer.verifySignature(token)

    if (!check.ok) {
      throw check.failure === 'bad-signature'
        ? new LicenseError('forged-token', CustomerMessages.tokenForged)
        : new LicenseError('invalid-token', CustomerMessages.tokenUnreadable)
    }

    // Tokens are issued with the canonical key, but canonicalising again costs
    // nothing and keeps the lookup correct if an older issuer ever differed.
    const key = validateKey(check.claims.key).key ?? check.claims.key
    const machineId = check.claims.machine
    const subject = { key, machineId }
    const now = this.clock()

    const outcome = this.store.transaction(
      (): { readonly released: boolean } | { readonly refused: LicenseError } => {
        const license = this.store.getLicense(key)
        if (license === null) {
          throw new LicenseError(
            'unknown-key',
            CustomerMessages.tokenLicenceMissing,
            undefined,
            subject,
          )
        }

        const activation = this.store.getActivation(key, machineId)
        const held = activation !== null && activation.releasedAt === null
        if (!held) {
          this.audit('deactivation-noop', key, machineId, context, now)
          return { released: false }
        }

        const allowance = this.selfReleaseStanding(license, now)
        if (allowance.limit !== null && allowance.recent >= allowance.limit) {
          // Recorded and committed rather than rolled back with a throw: the
          // refusal is the event support will be asked about.
          this.audit('deactivation-refused', key, machineId, context, now, {
            reason: 'self-release-limit',
            releases: allowance.recent,
            limit: allowance.limit,
            windowDays: allowance.windowDays,
          })

          return {
            refused: new LicenseError(
              'self-release-limit',
              allowance.limit === 0
                ? CustomerMessages.selfReleaseDisabled
                : CustomerMessages.selfReleaseLimit(allowance.recent, allowance.windowDays),
              `${allowance.recent}/${allowance.limit} self-service releases in ${allowance.windowDays} days`,
              subject,
            ),
          }
        }

        const released = this.store.releaseSeat(key, machineId, now)
        this.audit(released ? 'deactivated' : 'deactivation-noop', key, machineId, context, now)
        return { released }
      },
    )

    if ('refused' in outcome) throw outcome.refused
    return { released: outcome.released, key, machineId }
  }

  /**
   * How many self-service releases a licence has made in the current window,
   * and how many it may make.
   *
   * Counted from the durable `deactivated` events, which only `deactivate`
   * writes, inside whatever transaction the caller holds.
   *
   * A licence with unlimited seats (Technician and Enterprise by default, or
   * anything minted with `--seats unlimited`) is never limited, whatever the
   * operator's limit — including `0`. The cap exists to bound how far one
   * seat can be stretched by restoring a backed-up activation after releasing
   * it, and an unlimited licence has no seat to stretch: a further activation
   * would succeed anyway. Capping it would only hurt the customer the edition
   * is designed for — a technician who removes the licence from each
   * customer's computer after a job, and who, past the allowance, would have
   * to leave it installed there. Releases are still counted and shown, so
   * support can see the pattern.
   */
  private selfReleaseStanding(license: LicenseRecord, now: number): SelfReleaseStanding {
    const { limit, windowDays } = this.selfRelease
    const recent = this.store.countEventsAfter(
      license.key,
      'deactivated',
      addDays(now, -windowDays),
    )

    return { recent, limit: license.maxActivations === null ? null : limit, windowDays }
  }

  // --- administration --------------------------------------------------------

  /**
   * Stop a licence from activating.
   *
   * Machines that already hold a token keep working until it expires, because
   * the desktop client verifies tokens offline; revocation stops every new
   * activation and every re-activation. Revoking twice keeps the original date
   * and reason, so the audit trail records when it actually happened.
   */
  revoke(keyInput: string, reason: string | null, context: AuditContext): LicenseRecord {
    const now = this.clock()

    return this.store.transaction(() => {
      const license = this.requireLicense(keyInput)
      if (license.revokedAt !== null) return license

      const trimmed = reason?.trim() ?? ''
      const stored = trimmed.length === 0 ? null : trimmed.slice(0, 500)

      this.store.setRevocation(license.key, now, stored)
      this.audit('revoked', license.key, null, context, now, { reason: stored })

      return { ...license, revokedAt: now, revokeReason: stored }
    })
  }

  /** Undo a revocation, e.g. after a payment dispute is resolved in the customer's favour. */
  restore(keyInput: string, context: AuditContext): LicenseRecord {
    const now = this.clock()

    return this.store.transaction(() => {
      const license = this.requireLicense(keyInput)
      if (license.revokedAt === null) return license

      this.store.setRevocation(license.key, null, null)
      this.audit('restored', license.key, null, context, now, {
        revokedAt: license.revokedAt,
        reason: license.revokeReason,
      })

      return { ...license, revokedAt: null, revokeReason: null }
    })
  }

  /**
   * Change when a licence ends.
   *
   * Machines pick up the new date the next time they activate, because the
   * expiry travels inside the token they hold.
   */
  extend(keyInput: string, change: ExtendLicenseInput, context: AuditContext): LicenseRecord {
    const parsed = ExtendLicenseSchema.safeParse(change)
    if (!parsed.success) {
      throw new LicenseError('invalid-argument', formatZodIssues(parsed.error.issues))
    }

    const now = this.clock()

    return this.store.transaction(() => {
      const license = this.requireLicense(keyInput)
      const expiresAt = resolveExtension(parsed.data, license.expiresAt, now)

      this.store.setExpiry(license.key, expiresAt)
      this.audit('extended', license.key, null, context, now, {
        from: license.expiresAt,
        to: expiresAt,
      })

      return { ...license, expiresAt }
    })
  }

  /**
   * Free one machine's seat — for a customer whose computer died before they
   * could deactivate it, or who has used up the self-service allowance.
   *
   * Not subject to that allowance and not counted against it: this is the
   * support route the allowance's refusal points the customer to. Afterwards
   * the old computer's own Deactivate finds the seat already free, answers
   * `released: false`, and the application there forgets its licence.
   */
  release(keyInput: string, machineInput: string, context: AuditContext): boolean {
    const now = this.clock()
    const machineId = machineInput.trim().toUpperCase()

    return this.store.transaction(() => {
      const license = this.requireLicense(keyInput)
      const released = this.store.releaseSeat(license.key, machineId, now)

      if (!released && this.store.getActivation(license.key, machineId) === null) {
        throw new LicenseError(
          'not-found',
          `Licence ${license.key} has never been activated on machine ${machineId}.`,
        )
      }

      if (released) this.audit('seat-released', license.key, machineId, context, now)
      return released
    })
  }

  /**
   * Free every seat a licence holds. Returns how many were held.
   *
   * Like `release`, outside the self-service allowance and never counted.
   */
  resetSeats(keyInput: string, context: AuditContext): number {
    const now = this.clock()

    return this.store.transaction(() => {
      const license = this.requireLicense(keyInput)
      const released = this.store.releaseAllSeats(license.key, now)

      this.audit('seats-reset', license.key, null, context, now, { released })
      return released
    })
  }

  list(options: ListOptions = {}): LicenseSummary[] {
    return this.store.listLicenses({
      edition: options.edition,
      search: options.search,
      orderRef: options.orderRef,
      limit: Math.min(Math.max(options.limit ?? 50, 1), 1000),
      offset: Math.max(options.offset ?? 0, 0),
    })
  }

  show(keyInput: string): LicenseDetails {
    const license = this.requireLicense(keyInput)
    const activations = this.store.listActivations(license.key)
    const now = this.clock()

    return {
      license,
      standing: standingOf(license, now),
      activeSeats: activations.filter((activation) => activation.releasedAt === null).length,
      selfReleases: this.selfReleaseStanding(license, now),
      activations,
      events: this.store.listEvents(license.key, SHOWN_EVENTS),
    }
  }

  /** The current time as this authority sees it. */
  now(): number {
    return this.clock()
  }

  // --- internals -------------------------------------------------------------

  private requireSigner(): TokenSigner {
    if (this.signer === null) {
      throw new Error(
        'No signing key is configured. Set LICENSE_SIGNING_KEY_FILE or LICENSE_SIGNING_KEY.',
      )
    }
    return this.signer
  }

  /** Find a licence for an admin operation, with operator-facing errors. */
  private requireLicense(keyInput: string): LicenseRecord {
    const validation = validateKey(keyInput)

    if (!validation.ok || validation.key === null) {
      throw new LicenseError(
        'invalid-argument',
        `"${keyInput.trim()}" is not a well-formed licence key: ${describeKeyProblem(validation.problem)}`,
      )
    }

    const license = this.store.getLicense(validation.key)
    if (license === null) {
      throw new LicenseError('not-found', `No licence with key ${validation.key} exists.`)
    }

    return license
  }

  private audit(
    type: EventType,
    key: string | null,
    machineId: string | null,
    context: AuditContext,
    now: number,
    detail: Record<string, unknown> = {},
  ): void {
    this.store.recordEvent({
      at: now,
      type,
      key,
      machineId,
      ip: context.ip ?? null,
      detail: JSON.stringify({ actor: context.actor, ...detail }),
    })
  }

  /**
   * Record why a known licence was refused.
   *
   * Written after the transaction has rolled back, so it is never lost with
   * it. Only refusals of a licence that exists are recorded: logging every
   * unknown key would let anyone with a loop fill the database, and those
   * attempts are already rate limited and visible in the request log.
   *
   * Nor is a lapsed term refused to a computer that still holds one of the
   * licence's seats. That is the application asking whether the licence has
   * been renewed — at start-up for a while after the end date, and whenever
   * the customer presses "Check for renewal" — and the licence's own end date
   * already says everything such a row would. Recording each one would bury
   * the history support reads (`show` lists the latest few dozen events)
   * under identical rows, one per launch; the request log still has them. A
   * computer *without* a seat being refused for the same reason is still
   * recorded: that is someone trying to move or reinstall a lapsed licence.
   */
  private auditRefusal(
    error: unknown,
    key: string,
    machineId: string,
    context: AuditContext,
    now: number,
  ): void {
    if (!(error instanceof LicenseError)) return
    if (error.refusal === 'unknown-key' || error.refusal === 'invalid-key') return

    try {
      if (error.refusal === 'expired' && this.holdsSeat(key, machineId)) return

      this.audit('activation-refused', key, machineId, context, now, {
        reason: error.refusal,
      })
    } catch {
      // The refusal itself is what the caller needs; a failed audit write must
      // not replace it with a database error.
    }
  }

  /** Whether a machine currently holds one of a licence's seats. */
  private holdsSeat(key: string, machineId: string): boolean {
    const activation = this.store.getActivation(key, machineId)
    return activation !== null && activation.releasedAt === null
  }
}

/** Validate and canonicalise a customer-supplied key, or refuse it in their terms. */
export function canonicalKey(input: string): string {
  const validation = validateKey(input)

  if (!validation.ok || validation.key === null) {
    throw new LicenseError('invalid-key', describeKeyProblem(validation.problem))
  }

  return validation.key
}

/**
 * Refuse a policy the rules cannot apply.
 *
 * `config.ts` validates the environment before it gets here; this guards the
 * other callers (tests, a future embedding) from a fractional or negative
 * limit, which would make the comparison in `deactivate` quietly wrong.
 */
function checkPolicy(policy: SelfReleasePolicy): SelfReleasePolicy {
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 0) {
    throw new RangeError(
      `The self-service release limit must be a whole number of 0 or more, not ${policy.limit}`,
    )
  }
  if (!Number.isSafeInteger(policy.windowDays) || policy.windowDays < 1) {
    throw new RangeError(
      `The self-service release window must be a whole number of days, at least 1, not ${policy.windowDays}`,
    )
  }
  return { limit: policy.limit, windowDays: policy.windowDays }
}

/** Whether a licence may currently be activated, and if not, why not. */
export function standingOf(license: LicenseRecord, now: number): LicenseStanding {
  if (license.revokedAt !== null) return 'revoked'
  if (license.expiresAt !== null && license.expiresAt <= now) return 'expired'
  return 'active'
}

function assertUsable(license: LicenseRecord, now: number): void {
  switch (standingOf(license, now)) {
    case 'revoked':
      throw new LicenseError('revoked', CustomerMessages.revoked)
    case 'expired':
      throw new LicenseError(
        'expired',
        CustomerMessages.expired(formatCustomerDate(license.expiresAt ?? now)),
      )
    case 'active':
      return
  }
}

/** A licence key safe to write to a log line. */
export function logSafeKey(input: string): string {
  const validation = validateKey(input)
  return validation.key === null ? '(malformed)' : maskKey(validation.key)
}

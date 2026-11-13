import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  LICENSE_ACTIVATION_URL,
  LICENSE_DEACTIVATION_URL,
  LICENSE_PUBLIC_KEY,
} from '@shared/constants/licensing'
import {
  entitlementsFor,
  type ActivationClaims,
  type LicenseEdition,
  type LicenseState,
  type LicenseStatus,
} from '@shared/types/license'
import { maskKey, validateKey, type KeyProblem } from '@shared/utils/license-key'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import { parseJson } from '@shared/utils/json'
import type { AppPaths } from '../config/paths'
import type { Logger } from '../logging/logger'
import { decodeTokenClaims, verifyToken, type TokenFailure } from './activation-token'
import { resolveMachineId } from './machine-id'

/**
 * Licence storage, activation and enforcement.
 *
 * The stored activation lives in its own file rather than in the database, for
 * one practical reason: the database is quarantined and rebuilt if it is ever
 * found corrupt, and a customer losing their licence because an unrelated table
 * was damaged is an unacceptable way to fail.
 *
 * Every entitlement decision re-verifies the signature. Caching the *verdict*
 * rather than the token would mean a single successful check at start-up
 * unlocked the process for its lifetime, which is exactly the point a patch
 * would target.
 */

const LICENSE_FILE = 'license.json'

/**
 * Activations that were removed from this computer while the licence server
 * could not be reached, or replaced by an offline activation, kept so their
 * seats can still be released later.
 *
 * A separate file from the licence itself, so that removing a licence always
 * removes it — the application goes back to Free at once — while the one
 * credential that can name the seat survives until the server has answered.
 */
export const PENDING_RELEASE_FILE = 'license-release.json'

/**
 * Cap on activations waiting to be released.
 *
 * Each one costs a request per launch until the server answers, and a
 * customer who removed sixteen licences without ever going online is not a
 * case worth an unbounded file. The newest are kept.
 */
const MAX_PENDING_RELEASES = 16

/** How long an activation request may take before the UI gives up on it. */
const ACTIVATION_TIMEOUT_MS = 20_000

/**
 * How long removing a licence waits for the server to release the seat.
 *
 * Much shorter than activation. The licence is removed locally whatever the
 * answer — an unanswered release is set aside and retried later — and a
 * machine behind a firewall that silently drops the request should not keep
 * the button spinning for twenty seconds to learn nothing.
 */
export const DEACTIVATION_TIMEOUT_MS = 8_000

/**
 * How close to its end a term licence has to be before start-up asks the
 * licence server whether it has been renewed.
 *
 * Renewals are paid for in a browser, and the server records them against the
 * key; nothing tells this computer. Asking at every start-up would put a
 * request on every launch for a licence that has years to run. Two weeks is
 * long enough that a customer who renews early sees the new date well before
 * the old one lapses, and short enough that the question is only asked when
 * the answer is likely to have changed.
 */
export const RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/**
 * How long after a term licence has ended start-up keeps asking whether it
 * has been renewed.
 *
 * A customer who means to renew does it around the end date, prompted by the
 * reminders and by the Licence screen turning to Expired; a month covers a
 * late payment, a holiday and an invoice waiting for approval. Past that, the
 * licence has lapsed and the computer carries on as Free, and asking at every
 * launch for ever would buy nothing but cost: each request is refused by the
 * server, spends the network's share of its rate limit (an office of lapsed
 * computers starting at nine can use up a colleague's activation), and behind
 * a firewall that drops the packets holds the seat lock for the whole
 * `RENEWAL_CHECK_TIMEOUT_MS`. A customer who renews later has just paid and is
 * looking at the Licence screen, where "Check for renewal" asks on demand
 * whatever the date, as does activating the key again.
 */
export const RENEWAL_GRACE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long the start-up renewal check waits for the licence server.
 *
 * Shorter than an activation the customer is watching. Nobody is waiting on
 * this one, and it holds the seat lock while it runs, so a slow server must
 * not keep a button the customer *is* pressing spinning behind it.
 */
export const RENEWAL_CHECK_TIMEOUT_MS = 8_000

const StoredLicenseSchema = z.object({
  token: z.string().min(1),
  key: z.string().min(1),
  activatedAt: z.number(),
})

type StoredLicense = z.infer<typeof StoredLicenseSchema>

const PendingReleaseSchema = z.object({
  tokens: z.array(z.string().min(1)),
})

/**
 * How one attempt to release a seat ended.
 *
 *  - `released`: the server answered; the seat is free (or already was).
 *  - `refused`: the server answered with a definitive no — a token it did not
 *    issue, a licence it no longer has. Asking again will not change that.
 *  - `kept`: the server will not release this seat and the licence stays where
 *    it is — the self-service cap on moving a licence between computers. The
 *    reason is the server's sentence for the customer, naming the count and
 *    how to reach support.
 *  - `unreachable`: no usable answer — offline, timed out, rate limited, a
 *    server error, or a page from something in front of the server (a captive
 *    portal, the web host, a firewall) in place of its reply, whatever the
 *    status. Worth asking again later.
 *
 * Only a reply in the licence server's own format can be `refused` or `kept`:
 * those two give up on the release, and only the server holding the seat can
 * say that it should be given up on.
 */
type ReleaseOutcome =
  | { readonly kind: 'released' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'kept'; readonly reason: string }
  | { readonly kind: 'unreachable' }

/**
 * The status the licence server answers a release with when it is keeping the
 * licence on this computer: the self-service cap on moves has been reached.
 *
 * Checked before `isDefinitiveRefusal`, which also counts 409 as final. The
 * difference is what happens to the licence: any other definitive refusal
 * means the server no longer recognises the seat, so there is nothing left to
 * keep; this one means the server still holds the seat *for this computer*,
 * and removing the licence here would strand a seat nobody could use.
 */
const RELEASE_KEPT_STATUS = 409

/**
 * The seat of a stored activation that a new one replaced, and whether its
 * token made it into the pending release file before the licence file was
 * overwritten.
 */
interface ReplacedSeat {
  readonly token: string
  readonly queued: boolean
}

/**
 * How asking the licence server for a fresh token for the stored key ended.
 *
 *  - `renewed`: the server issued a genuine token for this key and machine
 *    that runs later than the stored one, or for a different edition; it has
 *    been stored.
 *  - `unchanged`: the server answered, but with nothing better than what is
 *    stored — the same term, a shorter one, or a token that does not verify.
 *  - `failed`: no usable answer, or a refusal. Carries the error so the
 *    customer-facing check can show it; the start-up check only logs it.
 */
type RenewalOutcome =
  | { readonly kind: 'renewed' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'failed'; readonly error: AppError }

/**
 * What a renewal check asked for from the Licence screen reports.
 *
 * `renewed` is said explicitly rather than left for the screen to infer by
 * comparing dates, because "the server had nothing newer" and "the term was
 * extended by a day" look alike from the outside and need different words.
 * It is true when a better licence has been stored since the customer asked,
 * whichever check stored it; see `LicenseService.checkForRenewal`.
 */
export interface LicenseRenewalCheck {
  readonly renewed: boolean
  readonly status: LicenseStatus
}

/** What the activation endpoint returns. Documented for the vendor service. */
const ActivationResponseSchema = z.object({
  token: z.string().min(1),
})

/**
 * What the deactivation endpoint returns. `released` is false when the seat
 * was already free, which the server still reports as success: releasing is
 * idempotent, so a retry after a lost response is harmless.
 */
const DeactivationResponseSchema = z.object({
  released: z.boolean(),
})

/** Both endpoints answer a failure with one customer-readable sentence. */
const ServiceErrorSchema = z.object({
  error: z.string().min(1),
})

export interface ActivateRequest {
  readonly key: string
}

export interface ActivateOfflineRequest {
  readonly token: string
}

/**
 * Where the licence server lives.
 *
 * Injectable, with the build-time values as the default. Those are fixed at
 * import time, so without this a test could only ever exercise the "no server
 * configured" branch — the one branch that never touches the network.
 */
export interface LicenseEndpoints {
  /** Exchanges a key for a token. Empty when the build has no licence server. */
  readonly activationUrl: string
  /** Releases a seat. Empty when the build has no licence server. */
  readonly deactivationUrl: string
}

const BUILD_ENDPOINTS: LicenseEndpoints = {
  activationUrl: LICENSE_ACTIVATION_URL,
  deactivationUrl: LICENSE_DEACTIVATION_URL,
}

export class LicenseService {
  private readonly filePath: string
  private readonly pendingReleasePath: string
  private readonly logger: Logger
  private readonly endpoints: LicenseEndpoints
  private stored: StoredLicense | null = null
  private machineId = ''

  /**
   * Serialises everything that touches the licence server's idea of this
   * machine's seats: activating, removing, and retrying a release.
   *
   * Without it, a release retried at start-up could reach the server just
   * after the customer re-activated the same key here, and free the seat the
   * new activation holds. It also keeps the read-modify-write of the pending
   * release file from interleaving with itself.
   */
  private seatLock: Promise<unknown> = Promise.resolve()

  /** Set once the start-up renewal check has run; see `renewIfDue`. */
  private renewalChecked = false

  /**
   * The token the start-up renewal check replaced, until the Licence screen's
   * own check has reported the renewal; see `checkForRenewal`.
   *
   * Nothing tells an open Licence screen that the background check stored a
   * renewal: it loaded the status when it opened, and goes on showing Expired
   * with a "Check for renewal" button. A customer who presses it must hear
   * that their renewal arrived, not that it has not.
   */
  private unreportedRenewalFrom: string | null = null

  constructor(paths: AppPaths, logger: Logger, endpoints: LicenseEndpoints = BUILD_ENDPOINTS) {
    this.filePath = join(paths.userData, LICENSE_FILE)
    this.pendingReleasePath = join(paths.userData, PENDING_RELEASE_FILE)
    this.logger = logger.child('license')
    this.endpoints = endpoints
  }

  /**
   * Resolve the machine identifier and load any stored activation.
   *
   * Deliberately lazy rather than a boot step. Reading the identifier means
   * querying the registry, and blocking the window on that would put a
   * measurable delay in front of every launch to answer a question nothing
   * needs until the user opens a screen or starts a recovery. The work happens
   * once and is then cached for the process lifetime.
   */
  private async ready(): Promise<void> {
    if (this.machineId.length > 0) return

    this.machineId = await resolveMachineId()
    this.stored = this.read()

    const status = this.describeCurrent(0)
    this.logger.info('Licence loaded', { state: status.state, edition: status.edition })
  }

  /**
   * Begin resolving in the background.
   *
   * Called during boot without being awaited, so the first screen that asks for
   * a licence status usually finds the answer already there. Any seat release
   * left over from a licence removed while offline, or replaced by an offline
   * activation, is retried at the same time: start-up is the one moment a
   * machine that is only occasionally online reliably passes through. For the
   * same reason, a term licence that is about to run out, or has only
   * recently, is checked for a renewal straight after.
   */
  warmUp(): void {
    void this.ready()
      .then(async () => this.retryPendingReleases())
      .then(async () => this.renewIfDue())
      .catch((error: unknown) => {
        this.logger.warn('The licence could not be loaded', { error: describeUnknown(error) })
      })
  }

  /**
   * Pick up a renewal paid for since this computer was activated.
   *
   * A renewal is bought in a browser and recorded by the licence server
   * against the key; the token on this computer still carries the old end
   * date and keeps it until something asks again. Re-activating the same key
   * on the same machine is idempotent on the server — it re-issues the token
   * with the licence's *current* term and edition and takes no extra seat — so
   * asking is exactly an activation of what is already stored.
   *
   * Only asked when the answer is likely to matter: the licence runs out
   * within `RENEWAL_WINDOW_MS`, or ended less than `RENEWAL_GRACE_MS` ago.
   * Only once per process, whatever the outcome: start-up is what this is
   * for, and a machine that was offline then will be asked again at the next
   * one. The Licence screen offers the same check on demand
   * (`checkForRenewal`) for a customer who has just paid, however long ago the
   * licence ended.
   *
   * Never throws, and nothing short of a better genuine token changes anything:
   * no network, a refusal, a token for another machine or key, a forged one,
   * or one that runs no longer than the stored one all leave the stored
   * licence exactly as it was.
   */
  async renewIfDue(): Promise<void> {
    if (this.renewalChecked) return
    this.renewalChecked = true

    try {
      await this.ready()
      if (this.endpoints.activationUrl.length === 0) return

      await this.withSeatLock(async () => {
        if (!this.renewalDue(Date.now())) return

        const before = this.stored?.token ?? null
        const outcome = await this.refreshStored(RENEWAL_CHECK_TIMEOUT_MS)
        if (outcome.kind === 'renewed') this.unreportedRenewalFrom = before
      })
    } catch (error) {
      this.logger.warn('The licence renewal check did not complete', {
        error: describeUnknown(error),
      })
    }
  }

  /**
   * Ask the licence server now whether the stored licence has been renewed.
   *
   * The on-demand half of `renewIfDue`, for the Licence screen: a customer who
   * has just paid for a renewal should not have to restart the application to
   * see it. Unlike the start-up check it reports what went wrong — offline,
   * or the server's own sentence when the licence has not been renewed — since
   * someone pressed a button and is waiting to hear.
   *
   * Offered only for a licence whose signature verifies here, active or
   * expired. Any other stored activation belongs to a different computer, key
   * or build, and asking the server about it would answer a different
   * question; activating the key again is what those need.
   *
   * `renewed` answers the customer's question — has my renewal arrived since
   * I last looked? — not whether this particular request was the one that
   * stored it. The start-up check (`renewIfDue`) may store the very renewal
   * they are asking about: while this check waits behind it for the seat
   * lock, or before they pressed the button on a screen opened during
   * start-up that still shows Expired. Either way this request then gets the
   * same term back, and judging by it alone would tell them no renewal was
   * recorded while the card turns to Active with the new date. So the licence
   * stored afterwards is compared with what was stored when they asked —
   * taken before waiting for the lock — or with what the start-up check
   * replaced, if it has not been reported yet.
   */
  async checkForRenewal(recoveredBytes: number): Promise<LicenseRenewalCheck> {
    await this.ready()

    if (this.endpoints.activationUrl.length === 0) {
      throw new AppError(ErrorCode.Unsupported, 'Online activation is not available', {
        details: 'This build has no activation service configured. Use offline activation.',
        retryable: false,
      })
    }

    const asked = this.stored?.token ?? null

    return this.withSeatLock(async () => {
      const state = this.describeCurrent(0).state

      if (this.stored === null || (state !== 'active' && state !== 'expired')) {
        throw new AppError(ErrorCode.Validation, 'There is no licence on this computer to renew', {
          retryable: false,
        })
      }

      const outcome = await this.refreshStored(ACTIVATION_TIMEOUT_MS)
      const renewed =
        outcome.kind === 'renewed' || this.renewedSince(this.unreportedRenewalFrom ?? asked)

      // A renewal already stored is the answer, even if asking again failed.
      if (!renewed && outcome.kind === 'failed') throw outcome.error

      this.unreportedRenewalFrom = null

      return {
        renewed,
        status: this.describeCurrent(recoveredBytes),
      }
    })
  }

  /**
   * Try again to release the seats of licences removed while offline.
   *
   * Never throws; whatever is still unanswered stays queued for next time.
   */
  async retryPendingReleases(): Promise<void> {
    await this.ready()
    await this.withSeatLock(async () => this.flushPendingReleases())
  }

  /**
   * The current entitlement.
   *
   * `recoveredBytes` is supplied by the caller rather than read here: the
   * running total lives in the database beside the recovery history (its
   * allowance ledger), and duplicating it would create two figures that can
   * disagree.
   */
  async status(recoveredBytes: number, now = Date.now()): Promise<LicenseStatus> {
    await this.ready()
    return this.describeCurrent(recoveredBytes, now)
  }

  /** The synchronous half, once the identifier is known. */
  private describeCurrent(recoveredBytes: number, now = Date.now()): LicenseStatus {
    const base = {
      machineId: this.machineId,
      recoveredBytes,
    }

    if (this.stored === null) {
      return this.describe('unlicensed', 'free', null, null, null, base)
    }

    const result = verifyToken(this.stored.token, {
      publicKey: LICENSE_PUBLIC_KEY,
      machineId: this.machineId,
      expectedKey: this.stored.key,
      now,
    })

    if (result.ok) {
      return this.describe(
        'active',
        result.claims.edition,
        this.stored.key,
        this.stored.activatedAt,
        result.claims.expiresAt,
        base,
        result.claims.registeredTo,
      )
    }

    /*
     * A rejected activation falls back to Free, never to nothing. Whatever went
     * wrong — an expired term, a replaced motherboard, a build with no key —
     * the customer keeps a working application and a clear explanation, rather
     * than being locked out of software they have already paid for.
     *
     * The claims read here are unverified and used only to show the customer
     * which licence is failing. No entitlement is derived from them.
     */
    const unverified = decodeTokenClaims(this.stored.token)

    return this.describe(
      stateFor(result.failure),
      'free',
      this.stored.key,
      this.stored.activatedAt,
      unverified?.expiresAt ?? null,
      base,
      unverified?.registeredTo ?? null,
    )
  }

  /**
   * Activate over the network.
   *
   * The key is validated locally first. A mistyped key is by far the commonest
   * activation failure, and answering it in milliseconds without a round trip —
   * and without the customer wondering whether their purchase was rejected — is
   * worth the few lines it costs.
   */
  async activate(request: ActivateRequest): Promise<LicenseStatus> {
    await this.ready()

    const validation = validateKey(request.key)

    if (!validation.ok || validation.key === null) {
      throw new AppError(ErrorCode.Validation, 'That licence key is not valid', {
        details: describeKeyProblem(validation.problem),
        retryable: false,
      })
    }

    if (this.endpoints.activationUrl.length === 0) {
      throw new AppError(ErrorCode.Unsupported, 'Online activation is not available', {
        details: 'This build has no activation service configured. Use offline activation.',
        retryable: false,
      })
    }

    const key = validation.key

    return this.withSeatLock(async () => {
      // Activating proves the server is reachable, which makes this the best
      // moment to settle a release left over from an offline removal — and
      // the necessary one when that release is what frees the seat this
      // activation is about to ask for, as after renaming the computer.
      await this.flushPendingReleases()

      const token = await this.requestToken(key)
      return this.store(key, token, 'activation')
    })
  }

  /**
   * Activate from a token issued out of band.
   *
   * The verification path is identical to the online one — the token is checked
   * against the same public key and the same machine binding. Offline
   * activation is therefore not a weaker mode, which matters because the
   * machines that most need it are the isolated ones a technician is called to.
   *
   * It sends nothing: offline is how a customer activates a computer that
   * does not talk to the licence server, and the privacy policy promises that
   * the app sends nothing for it. A stored activation for another seat that
   * this one replaces is set aside exactly as if it had been removed while
   * offline — its release waits for the next start-up, or for an online
   * activation before that — rather than being sent from here.
   */
  async activateOffline(request: ActivateOfflineRequest): Promise<LicenseStatus> {
    await this.ready()
    const token = request.token.trim()

    const result = verifyToken(token, {
      publicKey: LICENSE_PUBLIC_KEY,
      machineId: this.machineId,
      now: Date.now(),
    })

    if (!result.ok) {
      throw new AppError(ErrorCode.Validation, describeTokenFailure(result.failure), {
        details: result.failure === 'wrong-machine' ? this.machineId : undefined,
        retryable: false,
      })
    }

    return this.withSeatLock(async () =>
      Promise.resolve(this.store(result.claims.key, token, 'activation', 'later')),
    )
  }

  /**
   * Remove the stored activation, freeing the seat for another machine.
   *
   * Offered whatever the local verdict on the licence. An expired licence, or
   * one that reports a different computer after the machine was renamed, still
   * holds a seat on the server, and freeing it is exactly what that customer
   * needs before they can activate again.
   *
   * The seat is released on the server first and the local file removed
   * second, because that is the order that survives an interruption between
   * the two: a file left behind costs nothing but a second press of the button.
   *
   * When the server cannot be reached — offline, timed out, rate limited,
   * mid-deploy — the licence is still removed, because a licence that cannot be
   * removed from one's own computer is a worse failure than a seat released
   * late. The token is not thrown away with it, though: it is set aside in its
   * own file *before* the licence file goes, and the release is retried at the
   * next start-up and before the next online activation, until the server gives
   * a definitive answer. Throwing it away would leave the customer one
   * activation short until support freed the seat by hand.
   *
   * The one answer that keeps the licence is the server declining to move it
   * (409): a licence may only be moved between computers so many times a year
   * without asking support. The seat is then still this computer's, so the
   * licence file stays, nothing is set aside to retry — asking again would get
   * the same answer — and the server's sentence is thrown for the customer to
   * read, since it says how many moves were used and whom to contact.
   *
   * A known limit, recorded here because this method is what makes it
   * reachable: releasing a seat does not invalidate the token that held it.
   * Tokens are verified offline, so a copy of the licence file taken before the
   * release and put back afterwards still verifies on this machine while the
   * seat is free for another. The server's cap on self-service releases is
   * what bounds that — each round trip costs one of a handful of moves a year
   * — since nothing the client does alone can prevent it: anything stored here
   * can be restored from a backup.
   */
  async deactivate(recoveredBytes: number): Promise<LicenseStatus> {
    await this.ready()

    return this.withSeatLock(async () => {
      if (this.stored !== null) await this.releaseOrSetAside(this.stored.token)

      try {
        if (existsSync(this.filePath)) rmSync(this.filePath, { force: true })
      } catch (error) {
        throw new AppError(ErrorCode.Io, 'The licence could not be removed', {
          details: describeUnknown(error),
          retryable: true,
        })
      }

      this.stored = null
      this.logger.info('Licence removed')

      return this.describeCurrent(recoveredBytes)
    })
  }

  /**
   * Decide whether a recovery of this size is permitted.
   *
   * Throws rather than returning a flag, because every caller must stop. A
   * boolean here would eventually be ignored at one call site, and that call
   * site would be the one that gave the product away.
   */
  async assertRecoveryAllowed(recoveredBytes: number, requestedBytes: number): Promise<void> {
    const status = await this.status(recoveredBytes)
    if (status.remainingBytes === null) return

    if (requestedBytes > status.remainingBytes) {
      throw new AppError(
        ErrorCode.Unsupported,
        'This recovery is larger than the Free edition allows',
        {
          details: JSON.stringify({
            limitBytes: status.recoveryLimitBytes,
            usedBytes: recoveredBytes,
            remainingBytes: status.remainingBytes,
            requestedBytes,
          }),
          retryable: false,
        },
      )
    }
  }

  // --- internals -----------------------------------------------------------

  private describe(
    state: LicenseState,
    edition: LicenseEdition,
    key: string | null,
    activatedAt: number | null,
    expiresAt: number | null,
    base: { machineId: string; recoveredBytes: number },
    registeredTo: string | null = null,
  ): LicenseStatus {
    const limit = entitlementsFor(edition).recoveryLimitBytes

    return {
      state,
      edition,
      maskedKey: key === null ? null : maskKey(key),
      activatedAt,
      expiresAt,
      machineId: base.machineId,
      registeredTo,
      recoveryLimitBytes: limit,
      recoveredBytes: base.recoveredBytes,
      remainingBytes: limit === null ? null : Math.max(0, limit - base.recoveredBytes),
    }
  }

  /** Run one seat operation at a time; see `seatLock`. */
  private withSeatLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.seatLock.then(task)
    this.seatLock = run.catch(() => undefined)
    return run
  }

  /**
   * Release the seat of the licence being removed, or keep its token so the
   * release can be retried.
   *
   * Earlier releases still waiting are tried after it, but only once the
   * server has answered for this one.
   *
   * Throws in two cases, both before anything is removed, so the licence and
   * its seat stay together rather than the seat being stranded: when the
   * server keeps the licence on this computer (the cap on moving it), with the
   * server's sentence as the message; and when the server cannot be reached
   * and the token cannot be kept to try again.
   */
  private async releaseOrSetAside(token: string): Promise<void> {
    if (this.endpoints.deactivationUrl.length === 0) {
      this.logger.info('No licence server is configured; the seat was not released online')
      return
    }

    const outcome = await this.releaseSeat(token)

    if (outcome.kind === 'kept') {
      // Nothing has been touched yet, so throwing here leaves the licence
      // exactly as it was. Validation rather than I/O: the request worked, and
      // pressing the button again would only be told the same thing.
      throw new AppError(ErrorCode.Validation, outcome.reason, { retryable: false })
    }

    const earlier = this.readPendingReleases().filter((owed) => owed !== token)

    if (outcome.kind !== 'unreachable') {
      const answered =
        earlier.length === 0 ? new Map<string, ReleaseOutcome>() : await this.releaseSeats(earlier)
      this.writePendingReleases(earlier.filter((owed) => !answered.has(owed)))
      this.noteDropped(answered)
      return
    }

    // Unanswered, so the earlier ones are not tried either: the server is out
    // of reach, and asking it again would only multiply the wait.
    const remaining = [token, ...earlier]

    if (!this.writePendingReleases(remaining)) {
      throw new AppError(ErrorCode.Io, 'The licence could not be removed', {
        details:
          'The licence server could not be reached to free this licence, and it could not be kept to try again later. Check your connection and try again.',
        retryable: true,
      })
    }

    this.logger.warn('The licence seat will be released when the licence server can be reached', {
      waiting: remaining.length,
    })
  }

  /**
   * Retry releases left over from licences removed while offline.
   *
   * Expects the seat lock to be held. Never throws.
   */
  private async flushPendingReleases(): Promise<void> {
    if (this.endpoints.deactivationUrl.length === 0) return

    const pending = this.readPendingReleases()
    if (pending.length === 0) return

    // A seat this machine holds again — the same key re-activated here since
    // it was removed — is in use, not owed. Releasing it would free the seat
    // from under the licence now stored.
    const held = this.stored === null ? null : seatOf(this.stored.token)
    const owed = pending.filter((token) => !sameSeat(seatOf(token), held))

    const answered =
      owed.length === 0 ? new Map<string, ReleaseOutcome>() : await this.releaseSeats(owed)
    const remaining = owed.filter((token) => !answered.has(token))

    this.writePendingReleases(remaining)

    if (owed.length > 0) {
      this.logger.info('Retried licence seat releases from an earlier removal', {
        settled: answered.size,
        waiting: remaining.length,
      })
    }

    this.noteDropped(answered)
  }

  /**
   * Release seats in order, stopping at the first that gets no usable answer.
   *
   * One unanswered request means the server is out of reach for now; trying
   * the rest would only multiply the wait by the length of the queue.
   *
   * Returns how each answered release ended. A token missing from the result
   * got no answer and is still owed.
   */
  private async releaseSeats(tokens: readonly string[]): Promise<Map<string, ReleaseOutcome>> {
    const answered = new Map<string, ReleaseOutcome>()

    for (const token of tokens) {
      const outcome = await this.releaseSeat(token)
      if (outcome.kind === 'unreachable') break
      answered.set(token, outcome)
    }

    return answered
  }

  /**
   * Record queued releases the server kept under its cap on moving a licence.
   *
   * They are dropped like any other answered release rather than kept to
   * retry. The licence each one belonged to is already gone from this
   * computer, so unlike a removal the customer is watching there is nothing
   * here left to keep; and the server would give the same answer until its
   * window moves on, a year of requests at every start-up. The seat stays on
   * the server until support moves it, which is what the server's sentence
   * tells a customer who asks — so it is logged, for whoever reads the log
   * with them.
   */
  private noteDropped(answered: ReadonlyMap<string, ReleaseOutcome>): void {
    let kept = 0
    for (const outcome of answered.values()) {
      if (outcome.kind === 'kept') kept += 1
    }

    if (kept > 0) {
      this.logger.warn(
        'The licence server kept seats from an earlier removal under its limit on moving a licence; they will not be retried',
        { dropped: kept },
      )
    }
  }

  /**
   * Ask the licence server to release the seat a token holds.
   *
   * Sent whatever the local verdict on the token. An expired licence, or one
   * that reports a different computer after Windows was reinstalled, still
   * occupies a seat on the server, and freeing it is exactly what that customer
   * needs. The server verifies the signature itself, so nothing here has to
   * vouch for the token.
   *
   * Never throws. Every outcome is logged, and none of them with the token or
   * the key: the token is a bearer credential for this seat, and a log file is
   * something customers attach to support emails.
   */
  private async releaseSeat(token: string): Promise<ReleaseOutcome> {
    const url = this.endpoints.deactivationUrl
    if (url.length === 0) return { kind: 'unreachable' }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, DEACTIVATION_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      })

      // Read inside the timeout as well: a server that sends its headers and
      // then stalls has answered no more than one that never replied.
      const body = await response.text()

      if (!response.ok) {
        const failure = parseJson(body, ServiceErrorSchema)

        if (!failure.ok) {
          // Both licence servers answer every failure with their `{ error }`
          // sentence. Anything else came from something in front of them —
          // the host's own "page not found" when the licensing rules are
          // missing from .htaccess, a firewall's or CDN's challenge page — and
          // says nothing about the seat, which is still held. Treated like a
          // captive portal's page below: unanswered, so the token is kept and
          // the release retried, never dropped on a stranger's word.
          this.logger.warn('The licence server sent an unusable reply to a seat release', {
            status: response.status,
          })
          return { kind: 'unreachable' }
        }

        // The server's sentence names a count and a support address, never
        // the key or the token, so it is safe to log.
        const reason = failure.data.error

        if (response.status === RELEASE_KEPT_STATUS) {
          this.logger.warn('The licence server kept the licence on the computer that holds it', {
            status: response.status,
            reason,
          })
          return { kind: 'kept', reason }
        }

        const definitive = isDefinitiveRefusal(response.status)

        this.logger.warn(
          definitive
            ? 'The licence server refused to release the seat'
            : 'The licence server could not release the seat right now',
          { status: response.status, reason },
        )
        return definitive ? { kind: 'refused' } : { kind: 'unreachable' }
      }

      const parsed = parseJson(body, DeactivationResponseSchema)

      if (!parsed.ok) {
        // A 200 that is not the server's reply is usually a captive portal or a
        // proxy's page: the request never reached the licence server at all.
        this.logger.warn('The licence server sent an unusable reply to a seat release', {
          status: response.status,
        })
        return { kind: 'unreachable' }
      }

      this.logger.info(
        parsed.data.released ? 'Licence seat released' : 'The licence seat was already free',
      )
      return { kind: 'released' }
    } catch (error) {
      // Offline, refused or timed out; the abort arrives here too.
      this.logger.warn('The licence server could not be reached to release the seat', {
        error: describeUnknown(error),
        timedOut: controller.signal.aborted,
      })
      return { kind: 'unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Activations waiting for their seat to be released. Never throws. */
  private readPendingReleases(): string[] {
    if (!existsSync(this.pendingReleasePath)) return []

    try {
      const parsed = parseJson(readFileSync(this.pendingReleasePath, 'utf8'), PendingReleaseSchema)
      if (parsed.ok) return parsed.data.tokens.slice(0, MAX_PENDING_RELEASES)

      this.logger.warn('The pending licence release file could not be read')
    } catch (error) {
      this.logger.warn('The pending licence release file could not be opened', {
        error: describeUnknown(error),
      })
    }

    return []
  }

  /**
   * Replace the queue of activations waiting for release; an empty queue
   * removes the file. Reports whether it worked rather than throwing, because
   * only the caller knows whether a failure here loses anything.
   */
  private writePendingReleases(tokens: readonly string[]): boolean {
    const queue = [...new Set(tokens)].slice(0, MAX_PENDING_RELEASES)

    try {
      if (queue.length === 0) {
        rmSync(this.pendingReleasePath, { force: true })
      } else {
        writeFileSync(this.pendingReleasePath, JSON.stringify({ tokens: queue }, null, 2), {
          encoding: 'utf8',
        })
      }
      return true
    } catch (error) {
      this.logger.warn('The pending licence release file could not be saved', {
        error: describeUnknown(error),
      })
      return false
    }
  }

  /**
   * Exchange a key for a token. Throws with the server's own sentence when it
   * refuses, and with an explanation of its own when it cannot be reached.
   *
   * The body is read inside the deadline as well as the headers. A server that
   * answers and then stalls has answered no more than one that never replied,
   * and these requests hold the seat lock: a stalled renewal check must not
   * keep the customer's own button waiting behind it indefinitely.
   */
  private async requestToken(key: string, timeoutMs = ACTIVATION_TIMEOUT_MS): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    let response: Response
    let body: string
    try {
      response = await fetch(this.endpoints.activationUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, machineId: this.machineId, product: 'recoverx' }),
        signal: controller.signal,
      })
      body = await response.text()
    } catch (error) {
      throw new AppError(ErrorCode.Io, 'The activation service could not be reached', {
        details:
          'Check your internet connection, or use offline activation if this machine has no network access.',
        cause: error,
        retryable: true,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const failure = parseJson(body, ServiceErrorSchema)

      // Only the licence server's own sentence is a verdict on the key. A
      // failure page from the web host, a proxy or a firewall in front of it
      // says nothing about the key, and telling the customer it was rejected
      // would send them to support over a key that is fine.
      if (!failure.ok) {
        throw new AppError(ErrorCode.Io, 'The activation service returned an unusable response', {
          details: `An error page (HTTP ${response.status}) came back instead of its reply. Try again later, or use offline activation.`,
          retryable: true,
        })
      }

      throw new AppError(ErrorCode.Validation, failure.data.error, { retryable: false })
    }

    const parsed = parseJson(body, ActivationResponseSchema)
    if (!parsed.ok) {
      throw new AppError(ErrorCode.Io, 'The activation service returned an unusable response', {
        retryable: true,
      })
    }

    return parsed.data.token
  }

  /**
   * Persist a token after verifying it. Never stores something unverified.
   *
   * Expects the seat lock to be held. A `renewal` replaces the token of the
   * licence already stored and keeps its activation date: the customer
   * activated this computer once, and a renewal picked up later should not
   * move the date the Licence screen shows for that.
   *
   * Storing over an activation for a different seat — another key, or this
   * key under the computer's previous identity — would otherwise throw away
   * the only credential that can free the seat it holds, leaving the customer
   * one activation short until support released it by hand. So that token is
   * queued for release first, before the file it lives in is overwritten.
   * With `replacedRelease` at `now` — an online activation, which has just
   * reached the server anyway — it is also released once the new licence is
   * in place. At `later` — an offline activation, which must send nothing —
   * it waits in the queue like any removal made offline, for the next
   * start-up. Nothing about the old seat can stop the new activation: the
   * release happens once the activation has returned, and a failure to queue
   * it is logged, not thrown.
   */
  private store(
    key: string,
    token: string,
    purpose: 'activation' | 'renewal',
    replacedRelease: 'now' | 'later' = 'now',
  ): LicenseStatus {
    const result = verifyToken(token, {
      publicKey: LICENSE_PUBLIC_KEY,
      machineId: this.machineId,
      expectedKey: key,
      now: Date.now(),
    })

    if (!result.ok) {
      throw new AppError(ErrorCode.Validation, describeTokenFailure(result.failure), {
        retryable: false,
      })
    }

    const previous = this.stored
    const replaced = previous === null ? null : this.setAsideReplaced(previous.token, token)

    const activatedAt =
      purpose === 'renewal' && previous !== null ? previous.activatedAt : Date.now()
    const record: StoredLicense = { token, key, activatedAt }

    try {
      writeFileSync(this.filePath, JSON.stringify(record, null, 2), { encoding: 'utf8' })
    } catch (error) {
      // The replaced token may already be queued. That is harmless: the licence
      // file still names its seat, and a queued release for the seat that is
      // stored is skipped and dropped, never sent.
      throw new AppError(ErrorCode.Io, 'The licence could not be saved', {
        details: describeUnknown(error),
        cause: error,
        retryable: true,
      })
    }

    this.stored = record
    this.logger.info(purpose === 'renewal' ? 'Licence renewed' : 'Licence activated', {
      edition: result.claims.edition,
    })

    // An activation answers the customer with its own status, so a renewal
    // the start-up check stored before it has nothing left to report.
    if (purpose === 'activation') this.unreportedRenewalFrom = null

    // A release still waiting for the seat this activation now holds must not
    // be retried later: it would free the seat from under this licence.
    const seat = seatOf(token)
    const pending = this.readPendingReleases()
    const owed = pending.filter((waiting) => !sameSeat(seatOf(waiting), seat))
    if (owed.length !== pending.length) this.writePendingReleases(owed)

    if (replaced !== null) {
      if (replacedRelease === 'now') {
        this.releaseReplaced(replaced)
      } else if (replaced.queued) {
        this.logger.info(
          'The seat of the licence this one replaced will be released when RecoverX next starts',
        )
      } else {
        // Nowhere to keep it, and nothing may be sent from here: the seat
        // stays taken on the server until support frees it.
        this.logger.warn('The seat of the licence this one replaced could not be released')
      }
    }

    return this.describeCurrent(0)
  }

  /**
   * Queue the seat of a stored activation that a new one is about to replace.
   *
   * Returns what to release afterwards, or `null` when there is nothing to
   * release: the same seat stored again (a re-activation or a renewal), a
   * build with no licence server, or a stored activation too damaged to name
   * a seat the server could find.
   */
  private setAsideReplaced(previous: string, next: string): ReplacedSeat | null {
    if (this.endpoints.deactivationUrl.length === 0) return null

    const seat = seatOf(previous)
    if (seat === null || sameSeat(seat, seatOf(next))) return null

    const queued = this.writePendingReleases([
      previous,
      ...this.readPendingReleases().filter((waiting) => waiting !== previous),
    ])

    if (!queued) {
      this.logger.warn('The replaced licence could not be kept to release its seat later')
    }

    return { token: previous, queued }
  }

  /**
   * Release the seat of a replaced activation once the new one is stored.
   *
   * Online activations only; an offline one leaves the replaced seat queued
   * for the next start-up (see `store`). Not awaited by the activation, which
   * has nothing to gain from waiting for a second answer. Taking the seat lock
   * queues it behind the activation that is storing the new licence.
   *
   * A queued token goes through the ordinary retry, so an unanswered release
   * stays queued for the next start-up, and the server keeping the old licence
   * where it is drops it. One that could not be queued gets a single attempt,
   * since there is nowhere to keep it for another.
   */
  private releaseReplaced(replaced: ReplacedSeat): void {
    this.logger.info('Releasing the seat of the licence this one replaced')

    void this.withSeatLock(async () => {
      if (replaced.queued) {
        await this.flushPendingReleases()
      } else {
        await this.releaseSeat(replaced.token)
      }
    }).catch((error: unknown) => {
      this.logger.warn('The replaced licence seat could not be released', {
        error: describeUnknown(error),
      })
    })
  }

  /**
   * Whether start-up should ask the licence server about a renewal.
   *
   * Only for a licence that verifies here apart from its date: a stored
   * activation for another computer, key or build would ask the server a
   * different question from the one it would answer. And only around the end
   * of its term — from `RENEWAL_WINDOW_MS` before it to `RENEWAL_GRACE_MS`
   * after — so a licence that lapsed long ago does not put a refused request
   * on every launch for the rest of the installation's life.
   */
  private renewalDue(now: number): boolean {
    if (this.stored === null) return false

    const status = this.describeCurrent(0, now)

    // Expired means the signature, machine and key all verified and only the
    // date failed, so the end date read back here is the genuine one.
    if (status.state === 'expired') {
      return status.expiresAt !== null && now - status.expiresAt <= RENEWAL_GRACE_MS
    }

    return (
      status.state === 'active' &&
      status.expiresAt !== null &&
      status.expiresAt - now <= RENEWAL_WINDOW_MS
    )
  }

  /**
   * Ask the licence server for a fresh token for the stored key, and keep it
   * only if it is better than the one stored.
   *
   * Expects the seat lock to be held and a licence to be stored. Never throws:
   * a failure is returned, for the caller to log or to show.
   *
   * "Better" means a genuine token for this key on this machine that is in
   * force now and either runs later than the stored one or names a different
   * edition. Anything else — the same term again, a shorter one, a token for
   * another machine or key, one that is not genuine or has already ended —
   * leaves the stored licence exactly as it was. The server is trusted for
   * what it signs, not for what it happens to send.
   */
  private async refreshStored(timeoutMs: number): Promise<RenewalOutcome> {
    const stored = this.stored
    if (stored === null) return { kind: 'unchanged' }

    const validation = validateKey(stored.key)
    if (!validation.ok || validation.key === null) {
      // Not a key the server could recognise; nothing to ask about.
      this.logger.warn('The stored licence key is not one the licence server could renew')
      return { kind: 'unchanged' }
    }

    const key = validation.key

    let token: string
    try {
      token = await this.requestToken(key, timeoutMs)
    } catch (error) {
      const failure =
        error instanceof AppError
          ? error
          : new AppError(ErrorCode.Io, 'The activation service could not be reached', {
              cause: error,
              retryable: true,
            })

      // The message is either this service's own or the server's sentence for
      // the customer; neither carries the key.
      this.logger.info('No renewal could be fetched from the licence server', {
        code: failure.code,
        reason: failure.message,
      })
      return { kind: 'failed', error: failure }
    }

    const result = verifyToken(token, {
      publicKey: LICENSE_PUBLIC_KEY,
      machineId: this.machineId,
      expectedKey: stored.key,
      now: Date.now(),
    })

    if (!result.ok) {
      this.logger.warn('The licence server sent a renewal this computer cannot use', {
        failure: result.failure,
      })
      return { kind: 'unchanged' }
    }

    if (!improvesOn(result.claims, decodeTokenClaims(stored.token))) {
      this.logger.info('The licence server has no later term for this licence')
      return { kind: 'unchanged' }
    }

    try {
      this.store(stored.key, token, 'renewal')
    } catch (error) {
      // Only saving can fail here, the token having been verified above; the
      // stored licence is untouched, and the next check will ask again.
      const failure =
        error instanceof AppError
          ? error
          : new AppError(ErrorCode.Io, 'The licence could not be saved', { cause: error })

      this.logger.warn('A renewed licence could not be saved', { error: failure.message })
      return { kind: 'failed', error: failure }
    }

    return { kind: 'renewed' }
  }

  /**
   * Whether the licence stored now improves on an earlier token for the same
   * seat, whatever stored it.
   *
   * Both are read without vouching for them: the stored one was verified when
   * it was stored, and the earlier one is only the yardstick. A different key
   * or machine is never a renewal of the other — that is a new activation,
   * which the customer has already been shown.
   */
  private renewedSince(earlier: string | null): boolean {
    if (earlier === null || this.stored === null) return false

    const current = this.stored.token
    if (current === earlier || !sameSeat(seatOf(current), seatOf(earlier))) return false

    const claims = decodeTokenClaims(current)
    return claims !== null && improvesOn(claims, decodeTokenClaims(earlier))
  }

  private read(): StoredLicense | null {
    if (!existsSync(this.filePath)) return null

    try {
      const parsed = parseJson(readFileSync(this.filePath, 'utf8'), StoredLicenseSchema)
      if (parsed.ok) return parsed.data

      this.logger.warn('The stored licence file could not be read')
    } catch (error) {
      this.logger.warn('The stored licence file could not be opened', {
        error: describeUnknown(error),
      })
    }

    return null
  }
}

/**
 * Whether a refused release is final.
 *
 * Most 4xx answers are the server's considered verdict on the token — not
 * issued by it, unreadable, a licence it no longer has — and asking again will
 * get the same one. Timeouts, "too early", rate limiting and every 5xx are
 * about the moment, not the token.
 *
 * Judged only for a reply that carries the licence server's own `{ error }`
 * sentence; a status from anything in front of it is never final (see
 * `LicenseService.releaseSeat`).
 */
export function isDefinitiveRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429
}

/** The seat a token names: one licence key on one machine. */
interface Seat {
  readonly key: string
  readonly machine: string
}

/**
 * Read the seat from a token without vouching for it.
 *
 * Used only to match tokens against each other, never to grant anything; the
 * server verifies whatever is eventually sent to it.
 */
function seatOf(token: string): Seat | null {
  const claims = decodeTokenClaims(token)
  return claims === null ? null : { key: claims.key, machine: claims.machine }
}

function sameSeat(a: Seat | null, b: Seat | null): boolean {
  return a !== null && b !== null && a.key === b.key && a.machine === b.machine
}

/**
 * Whether a freshly issued token is worth replacing the stored one with.
 *
 * A later end, an end removed altogether (a term licence converted to a
 * perpetual one), or a different edition (an upgrade recorded on the server).
 * Re-issuing the same term is what the server does for a licence that has not
 * been renewed, and storing that would only churn the file. A stored token
 * that cannot be read is never replaced from here: the caller only asks about
 * licences that verify, and anything else is for an activation to fix.
 */
export function improvesOn(next: ActivationClaims, current: ActivationClaims | null): boolean {
  if (current === null) return false
  if (next.edition !== current.edition) return true
  if (current.expiresAt === null) return false
  return next.expiresAt === null || next.expiresAt > current.expiresAt
}

/** Map a verification failure onto the state the user is told about. */
export function stateFor(failure: TokenFailure): LicenseState {
  switch (failure) {
    case 'expired':
      return 'expired'
    case 'wrong-machine':
      return 'machine-mismatch'
    case 'no-public-key':
      return 'unverifiable'
    case 'malformed':
    case 'bad-signature':
    case 'bad-claims':
    case 'wrong-key':
      return 'invalid'
  }
}

function describeTokenFailure(failure: TokenFailure): string {
  switch (failure) {
    case 'expired':
      return 'This licence has expired'
    case 'wrong-machine':
      return 'This activation was issued for a different computer'
    case 'no-public-key':
      return 'This build cannot verify licences'
    case 'wrong-key':
      return 'This activation does not match the licence key'
    case 'malformed':
    case 'bad-claims':
      return 'That activation code is not readable'
    case 'bad-signature':
      return 'That activation code is not genuine'
  }
}

function describeKeyProblem(problem: KeyProblem | null): string {
  switch (problem) {
    case null:
      return 'Check the key against your receipt.'
    case 'empty':
      return 'Enter your licence key.'
    case 'wrong-product':
      return 'That key is for a different product.'
    case 'wrong-length':
      return 'A licence key has 20 characters after the RECX prefix.'
    case 'bad-character':
      return 'That key contains characters a licence key never uses.'
    case 'checksum':
      return 'That key has a typing error in it. Check it against your receipt.'
  }
}

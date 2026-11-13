import { DAY_MS, MAX_TERM_DAYS, addDays } from './expiry'
import type { Logger } from './log'
import type { LicenseStore } from './store'

/**
 * How long the activation history is kept.
 *
 * The `events` table records every activation, release and refusal of a known
 * licence together with the address the request came from. The published
 * privacy policy promises that this log, IP addresses included, is kept for 13
 * months and then deleted, and this is where that promise is kept: events
 * recorded more than `days` days ago are deleted when the server starts and
 * once a day after that (`scheduleEventPruning`), and an operator can run the
 * same pass, or preview it, with the admin CLI's `prune-events`.
 *
 * The PHP port applies exactly the same rule — its `event_retention_days`,
 * the same default and the same cutoff — from ordinary requests rather than a
 * timer, because shared hosting gives it no process that stays running.
 *
 * The self-service release allowance is counted from the same table, so the
 * retention may never be shorter than the allowance's window: a deleted
 * `deactivated` event is a move the allowance has forgotten, and a customer
 * who had used it up would quietly get it back. The configuration refuses
 * such a setting, and so does the constructor here.
 */

/** About 13 months — 365 + 30 days — which is what the privacy policy promises. */
export const DEFAULT_EVENT_RETENTION_DAYS = 395

/** Longest retention accepted: the longest licence term, to catch a misplaced digit. */
export const MAX_EVENT_RETENTION_DAYS = MAX_TERM_DAYS

/** How far apart the running server's automatic passes are. */
export const EVENT_PRUNING_INTERVAL_MS = DAY_MS

export interface PruneResult {
  readonly retentionDays: number
  /** Events recorded strictly before this instant (epoch ms) are past the retention. */
  readonly cutoff: number
  /** Events past the retention when the pass ran. */
  readonly found: number
  /** Events deleted: all of `found`, or none on a dry run. */
  readonly deleted: number
  readonly dryRun: boolean
}

export interface EventRetentionOptions {
  readonly store: LicenseStore
  /** Days an event is kept; at least `selfReleaseWindowDays`. */
  readonly days: number
  /** The self-service release window (`SelfReleasePolicy.windowDays`) the retention must cover. */
  readonly selfReleaseWindowDays: number
  readonly clock?: () => number
}

export class EventRetention {
  readonly days: number
  private readonly store: LicenseStore
  private readonly clock: () => number

  constructor(options: EventRetentionOptions) {
    this.days = checkRetention(options.days, options.selfReleaseWindowDays)
    this.store = options.store
    this.clock = options.clock ?? Date.now
  }

  /** Events recorded strictly before this instant are past the retention. */
  cutoff(): number {
    return addDays(this.clock(), -this.days)
  }

  /**
   * Delete every event past the retention, or, as a dry run, only count them.
   *
   * One statement, so it is atomic without a transaction of its own, and
   * deleting what is already gone deletes nothing: the running server's pass
   * and an operator's `prune-events` can meet without harm.
   */
  prune(options: { readonly dryRun?: boolean } = {}): PruneResult {
    const dryRun = options.dryRun === true
    const cutoff = this.cutoff()

    if (dryRun) {
      const found = this.store.countEventsBefore(cutoff)
      return { retentionDays: this.days, cutoff, found, deleted: 0, dryRun }
    }

    const deleted = this.store.deleteEventsBefore(cutoff)
    return { retentionDays: this.days, cutoff, found: deleted, deleted, dryRun }
  }
}

/**
 * Refuse a retention the rules cannot keep.
 *
 * `config.ts` validates the environment before it gets here; this guards the
 * other callers (tests, a future embedding) from a retention that would let
 * the self-service allowance forget moves inside its own window.
 */
export function checkRetention(days: number, selfReleaseWindowDays: number): number {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new RangeError(
      `The event retention must be a whole number of days, at least 1, not ${days}`,
    )
  }
  if (days < selfReleaseWindowDays) {
    throw new RangeError(
      `The event retention (${days} days) must be at least the self-service release window (${selfReleaseWindowDays} days), because moves are counted from the event log`,
    )
  }
  return days
}

export interface PruningSchedule {
  /** Stop the daily pass. Called before the database is closed. */
  stop(): void
}

export interface PruningScheduleOptions {
  readonly retention: EventRetention
  readonly logger: Logger
  /** Defaults to `EVENT_PRUNING_INTERVAL_MS`. */
  readonly intervalMs?: number
}

/**
 * Prune now, then once every interval for as long as the server runs.
 *
 * A pass that fails is logged and left to the next one, never thrown: history
 * going a day late is no reason to stop activating licences, and the usual
 * cause — another connection holding the database lock — clears by itself.
 * The timer is unref'd, so it never keeps alive a process that has otherwise
 * finished; shutting down stops it explicitly, before the database closes.
 *
 * Every pass is logged, the ones that delete nothing included: that line is
 * how an operator confirms, from the platform's log, that the promise in the
 * privacy policy is being kept.
 */
export function scheduleEventPruning(options: PruningScheduleOptions): PruningSchedule {
  const { retention, logger } = options

  const pass = (): void => {
    try {
      const result = retention.prune()
      logger.info('Pruned the event log', {
        deleted: result.deleted,
        retentionDays: result.retentionDays,
        cutoff: new Date(result.cutoff).toISOString(),
      })
    } catch (error) {
      logger.error('Pruning the event log failed; the next pass will try again', { error })
    }
  }

  pass()

  const timer = setInterval(pass, options.intervalMs ?? EVENT_PRUNING_INTERVAL_MS)
  timer.unref()

  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}

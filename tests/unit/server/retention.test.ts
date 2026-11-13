import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readConfig } from '@server/config'
import { createJsonLogger } from '@server/log'
import {
  DEFAULT_EVENT_RETENTION_DAYS,
  EVENT_PRUNING_INTERVAL_MS,
  EventRetention,
  checkRetention,
  scheduleEventPruning,
} from '@server/retention'
import { startServer } from '@server/runtime'
import { LicenseStore, type EventType } from '@server/store'
import {
  CLI,
  CUSTOMER,
  DAY,
  MACHINE_A,
  NOW,
  PRODUCT_ID,
  freshKeyPair,
  openFixture,
  tempDir,
  type Fixture,
} from './fixtures'

/**
 * The event-log retention: the privacy policy's promise that the activation
 * history, IP addresses included, is deleted after 13 months.
 *
 * The rule is small — delete events recorded strictly before now minus the
 * retention — so most of what is tested here is its edges: the exact cutoff,
 * a second pass, a dry run, the guard that keeps the self-service allowance's
 * memory intact, and the running server actually applying it.
 */

/** Write an event `ageMs` before the fixture's clock, bypassing the authority. */
function eventAged(
  fixture: Fixture,
  ageMs: number,
  type: EventType = 'activated',
  key: string | null = null,
): void {
  fixture.store.recordEvent({
    at: fixture.clock.current - ageMs,
    type,
    key,
    machineId: MACHINE_A,
    ip: '203.0.113.7',
    detail: null,
  })
}

function eventCount(store: LicenseStore): number {
  return store.countEventsBefore(Number.MAX_SAFE_INTEGER)
}

describe('event retention', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = openFixture()
  })

  afterEach(() => {
    fixture.close()
  })

  function retention(days = DEFAULT_EVENT_RETENTION_DAYS, windowDays = 365): EventRetention {
    return new EventRetention({
      store: fixture.store,
      days,
      selfReleaseWindowDays: windowDays,
      clock: fixture.clock.now,
    })
  }

  it('keeps 13 months by default, as the privacy policy says', () => {
    expect(DEFAULT_EVENT_RETENTION_DAYS).toBe(395)
    expect(retention().cutoff()).toBe(NOW - 395 * DAY)
  })

  it('deletes events strictly older than the cutoff and keeps the one exactly on it', () => {
    const cutoffAge = 395 * DAY
    eventAged(fixture, cutoffAge + 1)
    eventAged(fixture, cutoffAge)
    eventAged(fixture, cutoffAge - 1)
    eventAged(fixture, 0)

    expect(retention().prune()).toEqual({
      retentionDays: 395,
      cutoff: NOW - cutoffAge,
      found: 1,
      deleted: 1,
      dryRun: false,
    })

    expect(eventCount(fixture.store)).toBe(3)
    expect(fixture.store.countEventsBefore(NOW - cutoffAge)).toBe(0)
    expect(fixture.store.countEventsBefore(NOW - cutoffAge + 1)).toBe(1)
  })

  it('deletes nothing the second time, so passes may overlap', () => {
    eventAged(fixture, 400 * DAY)
    eventAged(fixture, 500 * DAY)
    eventAged(fixture, 10 * DAY)

    expect(retention().prune()).toMatchObject({ found: 2, deleted: 2 })
    expect(retention().prune()).toMatchObject({ found: 0, deleted: 0 })
    expect(eventCount(fixture.store)).toBe(1)
  })

  it('only counts on a dry run', () => {
    eventAged(fixture, 400 * DAY)
    eventAged(fixture, 10 * DAY)

    expect(retention().prune({ dryRun: true })).toMatchObject({
      found: 1,
      deleted: 0,
      dryRun: true,
    })
    expect(eventCount(fixture.store)).toBe(2)
  })

  it('moves the cutoff with the clock', () => {
    eventAged(fixture, 300 * DAY)
    const policy = retention()

    expect(policy.prune().deleted).toBe(0)
    fixture.clock.advance(95 * DAY)
    expect(policy.prune().deleted).toBe(0)
    fixture.clock.advance(1)
    expect(policy.prune().deleted).toBe(1)
  })

  it('deletes every kind of event, of every licence and of none', () => {
    const [license] = fixture.authority.createLicenses({ edition: 'business' }, CLI).licenses
    const key = license?.key ?? ''
    fixture.authority.activate({ key, machineId: MACHINE_A, product: PRODUCT_ID }, CUSTOMER)
    fixture.clock.advance(396 * DAY)

    eventAged(fixture, 0)
    expect(retention().prune()).toMatchObject({ deleted: 2 })
    expect(fixture.authority.show(key).events).toEqual([])
    // The licence and its seat are records of a sale, not history: they stay.
    expect(fixture.authority.show(key).activeSeats).toBe(1)
  })

  describe('and the self-service move allowance', () => {
    it('refuses a retention shorter than the window the allowance counts in', () => {
      expect(() => retention(364, 365)).toThrow(RangeError)
      expect(() => retention(364, 365)).toThrow(/at least the self-service release window/u)
      expect(retention(365, 365).days).toBe(365)
    })

    it.each([0, -1, 1.5, Number.NaN])('refuses a retention of %s days', (days) => {
      expect(() => checkRetention(days, 1)).toThrow(/whole number of days, at least 1/u)
    })

    it('never changes how many moves the allowance sees, even at the shortest retention', () => {
      // The retention may equal the window, which is the tightest it can be.
      // Moves spread over two windows, the newest exactly on its edge.
      const [license] = fixture.authority.createLicenses({ edition: 'professional' }, CLI).licenses
      const key = license?.key ?? ''
      for (const age of [0, 1, 100 * DAY, 365 * DAY - 1, 365 * DAY, 365 * DAY + 1, 700 * DAY]) {
        eventAged(fixture, age, 'deactivated', key)
      }

      const before = fixture.authority.show(key).selfReleases
      expect(before.recent).toBe(4)

      expect(retention(365, 365).prune().deleted).toBe(2)
      expect(fixture.authority.show(key).selfReleases).toEqual(before)

      // And still the same a day later, with that day's pass done.
      fixture.clock.advance(DAY)
      const nextDay = fixture.authority.show(key).selfReleases
      retention(365, 365).prune()
      expect(fixture.authority.show(key).selfReleases).toEqual(nextDay)
    })
  })
})

describe('the daily pass', () => {
  let fixture: Fixture
  let logs: string[]

  beforeEach(() => {
    fixture = openFixture()
    logs = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    fixture.close()
  })

  const logger = () =>
    createJsonLogger({ write: (line) => logs.push(line), clock: fixture.clock.now })

  const policy = () =>
    new EventRetention({
      store: fixture.store,
      days: 395,
      selfReleaseWindowDays: 365,
      clock: fixture.clock.now,
    })

  it('prunes at once, then once a day, until stopped', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    eventAged(fixture, 400 * DAY)

    const schedule = scheduleEventPruning({ retention: policy(), logger: logger() })
    expect(eventCount(fixture.store)).toBe(0)
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      level: 'info',
      msg: 'Pruned the event log',
      deleted: 1,
      retentionDays: 395,
      cutoff: new Date(NOW - 395 * DAY).toISOString(),
    })

    // An event that turns 13 months old a day from now goes with the next pass.
    eventAged(fixture, 395 * DAY - DAY / 2)
    fixture.clock.advance(DAY)
    vi.advanceTimersByTime(EVENT_PRUNING_INTERVAL_MS - 1)
    expect(eventCount(fixture.store)).toBe(1)
    vi.advanceTimersByTime(1)
    expect(eventCount(fixture.store)).toBe(0)
    expect(logs).toHaveLength(2)

    schedule.stop()
    vi.advanceTimersByTime(10 * EVENT_PRUNING_INTERVAL_MS)
    expect(logs).toHaveLength(2)
  })

  it('never keeps the process alive on its own', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    const schedule = scheduleEventPruning({ retention: policy(), logger: logger() })
    try {
      const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout
      expect(timer.hasRef()).toBe(false)
    } finally {
      schedule.stop()
    }
  })

  it('logs a failed pass and leaves it to the next one instead of throwing', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const retention = policy()
    const prune = vi.spyOn(retention, 'prune').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })

    const schedule = scheduleEventPruning({ retention, logger: logger() })
    try {
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
        level: 'error',
        msg: 'Pruning the event log failed; the next pass will try again',
        error: { message: 'database is locked' },
      })

      vi.advanceTimersByTime(EVENT_PRUNING_INTERVAL_MS)
      expect(prune).toHaveBeenCalledTimes(2)
      expect(JSON.parse(logs[1] ?? '{}')).toMatchObject({ msg: 'Pruned the event log' })
    } finally {
      schedule.stop()
    }
  })
})

describe('the running server', () => {
  it('prunes history that aged out while it was down before taking requests', async () => {
    const dir = tempDir('recoverx-licence-retention-')
    const dbFile = join(dir.path, 'licences.db')
    const keys = freshKeyPair()
    const logs: string[] = []

    try {
      const offline = LicenseStore.open(dbFile)
      for (const age of [800 * DAY, 396 * DAY, 30 * DAY]) {
        offline.recordEvent({
          at: NOW - age,
          type: 'activated',
          key: null,
          machineId: MACHINE_A,
          ip: '198.51.100.20',
          detail: null,
        })
      }
      offline.close()

      const config = readConfig({
        LICENSE_SIGNING_KEY: keys.pem,
        LICENSE_DB_FILE: dbFile,
        PORT: '0',
      })
      expect(config.eventRetentionDays).toBe(395)

      const started = await startServer(
        config,
        createJsonLogger({ write: (line) => logs.push(line) }),
        { clock: () => NOW },
      )
      try {
        expect(eventCount(started.store)).toBe(1)
        expect(logs.map((line) => JSON.parse(line) as unknown)).toContainEqual(
          expect.objectContaining({ msg: 'Pruned the event log', deleted: 2 }),
        )
      } finally {
        await started.stop(100)
      }
    } finally {
      dir.cleanup()
    }
  })

  it('will not start with a retention shorter than the self-service window', () => {
    expect(() =>
      readConfig({ LICENSE_SELF_RELEASE_WINDOW_DAYS: '400', LICENSE_EVENT_RETENTION_DAYS: '399' }),
    ).toThrow(/LICENSE_EVENT_RETENTION_DAYS \(399\) must be at least/u)
  })
})

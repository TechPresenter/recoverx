import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseConnection } from '@main/database/connection'
import { runMigrations } from '@main/database/migrator'
import { HealthRepository } from '@main/database/repositories/health.repository'
import type { Logger } from '@main/logging/logger'
import type { DriveHealth } from '@shared/types/health'

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
}

const HOUR_MS = 60 * 60 * 1000

function reading(overrides: Partial<DriveHealth> = {}): DriveHealth {
  return {
    deviceId: 'disk0',
    capturedAt: 1_700_000_000_000,
    status: 'good',
    score: 100,
    selfAssessmentPassed: true,
    temperatureCelsius: 38,
    powerOnHours: 1200,
    powerCycles: 300,
    lifeRemainingPercent: null,
    reallocatedSectors: 0,
    pendingSectors: 0,
    attributes: [],
    findings: [],
    imageBeforeScanning: false,
    unavailable: null,
    ...overrides,
  }
}

describe('HealthRepository', () => {
  let directory: string
  let connection: DatabaseConnection
  let repository: HealthRepository

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-health-'))
    connection = openDatabase({ filePath: join(directory, 'test.db'), logger: silentLogger })
    runMigrations(connection.db, silentLogger)
    repository = new HealthRepository(connection.db)
  })

  afterEach(() => {
    connection.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('stores a reading and reads it back', () => {
    expect(repository.record(reading())).toBe(true)

    const history = repository.history('disk0')

    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      deviceId: 'disk0',
      status: 'good',
      score: 100,
      temperatureCelsius: 38,
    })
  })

  it('ignores a second reading taken minutes after the first', () => {
    // Opening the health screen five times in a minute must not create five
    // points and flatten the trend that makes the history worth keeping.
    const first = reading()
    repository.record(first)

    const soon = reading({ capturedAt: first.capturedAt + 5 * 60 * 1000 })

    expect(repository.record(soon)).toBe(false)
    expect(repository.history('disk0')).toHaveLength(1)
  })

  it('keeps a reading taken an hour later', () => {
    const first = reading()
    repository.record(first)

    expect(repository.record(reading({ capturedAt: first.capturedAt + HOUR_MS }))).toBe(true)
    expect(repository.history('disk0')).toHaveLength(2)
  })

  it('refuses to store a drive whose health could not be read', () => {
    // Writing zeroes for an unreadable drive would draw a cliff on the chart
    // that never happened.
    expect(repository.record(reading({ status: 'unknown', score: 0 }))).toBe(false)
    expect(repository.history('disk0')).toEqual([])
  })

  it('returns readings newest first', () => {
    const base = reading().capturedAt

    repository.record(reading({ capturedAt: base }))
    repository.record(reading({ capturedAt: base + HOUR_MS, score: 90 }))
    repository.record(reading({ capturedAt: base + 2 * HOUR_MS, score: 80 }))

    expect(repository.history('disk0').map((point) => point.score)).toEqual([80, 90, 100])
  })

  it('keeps drives apart', () => {
    repository.record(reading({ deviceId: 'disk0' }))
    repository.record(reading({ deviceId: 'disk1', score: 70, status: 'caution' }))

    expect(repository.history('disk0')).toHaveLength(1)
    expect(repository.history('disk1')[0]?.score).toBe(70)
  })

  it('does not let one drive suppress another drive reading', () => {
    // The interval check must be per drive: a reading just taken for disk0
    // says nothing about whether disk1 has been sampled.
    const at = reading().capturedAt

    repository.record(reading({ deviceId: 'disk0', capturedAt: at }))

    expect(repository.record(reading({ deviceId: 'disk1', capturedAt: at }))).toBe(true)
  })

  it('preserves the measurements a trend is drawn from', () => {
    const at = reading().capturedAt

    repository.record(
      reading({ capturedAt: at, reallocatedSectors: 8, pendingSectors: 2, powerOnHours: 30_000 }),
    )

    expect(repository.history('disk0')[0]).toMatchObject({
      reallocatedSectors: 8,
      pendingSectors: 2,
      powerOnHours: 30_000,
    })
  })

  it('stores a missing measurement as absent rather than zero', () => {
    // A drive that does not report a temperature is not a drive at 0 °C.
    repository.record(reading({ temperatureCelsius: null, pendingSectors: null }))

    expect(repository.history('disk0')[0]).toMatchObject({
      temperatureCelsius: null,
      pendingSectors: null,
    })
  })

  it('honours the requested limit', () => {
    const base = reading().capturedAt

    for (let index = 0; index < 5; index += 1) {
      repository.record(reading({ capturedAt: base + index * HOUR_MS }))
    }

    expect(repository.history('disk0', 3)).toHaveLength(3)
  })

  it('counts every stored reading', () => {
    const base = reading().capturedAt

    repository.record(reading({ capturedAt: base }))
    repository.record(reading({ deviceId: 'disk1', capturedAt: base }))

    expect(repository.count()).toBe(2)
  })

  it('reports no history for a drive that has never been read', () => {
    expect(repository.history('disk9')).toEqual([])
  })
})

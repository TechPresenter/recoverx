import type { DriveHealth, DriveHealthStatus, HealthHistoryPoint } from '@shared/types/health'
import {
  type SqliteDatabase,
  type SqliteRow,
  type SqliteStatement,
  databaseError,
  readInteger,
  readOptionalInteger,
  readText,
} from '../sqlite'

/**
 * Persistence for drive health readings.
 *
 * Readings are deduplicated by time rather than stored on every refresh. A user
 * who opens the health screen five times in a minute must not create five
 * identical points and flatten the trend line that makes the history useful.
 */

/** Readings closer together than this are treated as the same observation. */
const MIN_READING_INTERVAL_MS = 60 * 60 * 1000

/** How much history to keep per drive. A year of hourly points is ample. */
const MAX_READINGS_PER_DEVICE = 8760

export class HealthRepository {
  private readonly db: SqliteDatabase
  private readonly insertReading: SqliteStatement
  private readonly latestFor: SqliteStatement
  private readonly historyFor: SqliteStatement
  private readonly pruneFor: SqliteStatement

  constructor(db: SqliteDatabase) {
    this.db = db

    this.insertReading = db.prepare(`
      INSERT INTO health_reading (
        device_id, captured_at, status, score,
        temperature_celsius, reallocated_sectors, pending_sectors, power_on_hours
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.latestFor = db.prepare(`
      SELECT captured_at FROM health_reading
      WHERE device_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `)

    this.historyFor = db.prepare(`
      SELECT device_id, captured_at, status, score,
             temperature_celsius, reallocated_sectors, pending_sectors, power_on_hours
      FROM health_reading
      WHERE device_id = ?
      ORDER BY captured_at DESC
      LIMIT ?
    `)

    this.pruneFor = db.prepare(`
      DELETE FROM health_reading
      WHERE device_id = ?
        AND id NOT IN (
          SELECT id FROM health_reading
          WHERE device_id = ?
          ORDER BY captured_at DESC
          LIMIT ?
        )
    `)
  }

  /**
   * Store a reading, unless one was taken recently.
   *
   * Returns `true` when the reading was kept, which is what the caller reports
   * — a silent no-op would look like a failure to record.
   */
  record(health: DriveHealth): boolean {
    // A drive whose health could not be read has nothing worth plotting, and
    // storing zeroes would draw a cliff on the chart that never happened.
    if (health.status === 'unknown') return false

    try {
      const previous = this.latestFor.get(health.deviceId) as SqliteRow | undefined

      if (previous !== undefined) {
        const lastAt = readInteger(previous, 'captured_at')
        if (health.capturedAt - lastAt < MIN_READING_INTERVAL_MS) return false
      }

      this.insertReading.run(
        health.deviceId,
        health.capturedAt,
        health.status,
        health.score,
        health.temperatureCelsius,
        health.reallocatedSectors,
        health.pendingSectors,
        health.powerOnHours,
      )

      this.pruneFor.run(health.deviceId, health.deviceId, MAX_READINGS_PER_DEVICE)

      return true
    } catch (error) {
      throw databaseError('The health reading could not be stored', error)
    }
  }

  /** Recent readings for one drive, newest first. */
  history(deviceId: string, limit = 500): HealthHistoryPoint[] {
    try {
      const rows = this.historyFor.all(deviceId, limit) as SqliteRow[]

      return rows.map((row) => ({
        deviceId: readText(row, 'device_id'),
        capturedAt: readInteger(row, 'captured_at'),
        status: readText(row, 'status') as DriveHealthStatus,
        score: readInteger(row, 'score'),
        temperatureCelsius: readOptionalInteger(row, 'temperature_celsius'),
        reallocatedSectors: readOptionalInteger(row, 'reallocated_sectors'),
        pendingSectors: readOptionalInteger(row, 'pending_sectors'),
        powerOnHours: readOptionalInteger(row, 'power_on_hours'),
      }))
    } catch (error) {
      throw databaseError('The health history could not be read', error)
    }
  }

  /** Total stored readings. Used by the diagnostics screen. */
  count(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS total FROM health_reading').get() as
        SqliteRow | undefined

      return row === undefined ? 0 : readInteger(row, 'total')
    } catch (error) {
      throw databaseError('The health reading count could not be read', error)
    }
  }
}

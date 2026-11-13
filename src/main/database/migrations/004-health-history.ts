import type { Migration } from '../migration-plan'

/**
 * Drive health readings over time.
 *
 * A single SMART reading answers "is this drive healthy?"; a series answers the
 * question that actually predicts failure, which is "is it getting worse?". A
 * drive that has held four reallocated sectors for two years is stable. One
 * that went from zero to four last week is failing, and the two are
 * indistinguishable from a single sample.
 *
 * Only the summary figures are stored. Keeping every attribute of every reading
 * would grow without bound for data nobody queries; the full attribute table is
 * always available live from the drive.
 */
export const migration004: Migration = {
  version: 4,
  name: 'health-history',
  up: (db) => {
    db.exec(`
      CREATE TABLE health_reading (
        id                   INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        device_id            TEXT    NOT NULL,
        captured_at          INTEGER NOT NULL,
        status               TEXT    NOT NULL,
        score                INTEGER NOT NULL,
        temperature_celsius  INTEGER,
        reallocated_sectors  INTEGER,
        pending_sectors      INTEGER,
        power_on_hours       INTEGER
      );
    `)

    // Every query is "the recent history of one drive", newest first.
    db.exec(`
      CREATE INDEX idx_health_reading_device
        ON health_reading (device_id, captured_at DESC);
    `)
  },
}

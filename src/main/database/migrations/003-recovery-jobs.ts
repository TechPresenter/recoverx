import type { Migration } from '../migration-plan'

/**
 * Recovery jobs and their per-file outcomes.
 *
 * The outcomes are persisted, not merely reported: "which of those four
 * thousand files actually came back intact?" is a question users ask days after
 * the run, and a tool that cannot answer it forces them to re-verify by hand.
 */
export const migration003: Migration = {
  version: 3,
  name: 'recovery-jobs',
  up: (db) => {
    db.exec(`
      CREATE TABLE recovery_job (
        id                      TEXT    NOT NULL PRIMARY KEY,
        session_id              TEXT    NOT NULL REFERENCES scan_session(id) ON DELETE CASCADE,
        destination             TEXT    NOT NULL,
        status                  TEXT    NOT NULL,
        restore_structure       INTEGER NOT NULL CHECK (restore_structure IN (0, 1)),
        started_at              INTEGER NOT NULL,
        finished_at             INTEGER,
        total_files             INTEGER NOT NULL DEFAULT 0,
        total_bytes             INTEGER NOT NULL DEFAULT 0,
        recovered_files         INTEGER NOT NULL DEFAULT 0,
        recovered_bytes         INTEGER NOT NULL DEFAULT 0,
        partial_files           INTEGER NOT NULL DEFAULT 0,
        skipped_files           INTEGER NOT NULL DEFAULT 0,
        failed_files            INTEGER NOT NULL DEFAULT 0,
        mismatched_files        INTEGER NOT NULL DEFAULT 0,
        error_message           TEXT
      );
    `)

    db.exec(`
      CREATE TABLE recovery_item (
        id             INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        job_id         TEXT    NOT NULL REFERENCES recovery_job(id) ON DELETE CASCADE,
        file_id        TEXT    NOT NULL,
        name           TEXT    NOT NULL,
        target_path    TEXT    NOT NULL,
        status         TEXT    NOT NULL,
        verification   TEXT    NOT NULL,
        bytes_written  INTEGER NOT NULL,
        expected_bytes INTEGER NOT NULL,
        error          TEXT
      );
    `)

    db.exec(`
      CREATE INDEX idx_recovery_item_job    ON recovery_item (job_id);
      CREATE INDEX idx_recovery_item_status ON recovery_item (job_id, status);
      CREATE INDEX idx_recovery_job_started ON recovery_job (started_at DESC);
    `)
  },
}

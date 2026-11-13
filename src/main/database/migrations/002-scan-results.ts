import type { Migration } from '../migration-plan'

/**
 * Scan sessions and their results.
 *
 * Results go to SQLite rather than staying in memory for one reason: a deep
 * scan of a 4 TB drive can find millions of files, and the UI has to page,
 * search, sort and filter them while the scan is still running. An in-memory
 * array would exhaust the renderer's heap and make every filter an O(n) sweep.
 */
export const migration002: Migration = {
  version: 2,
  name: 'scan-results',
  up: (db) => {
    db.exec(`
      CREATE TABLE scan_session (
        id            TEXT    NOT NULL PRIMARY KEY,
        device_id     TEXT    NOT NULL,
        partition_id  TEXT,
        device_model  TEXT    NOT NULL,
        volume_label  TEXT,
        file_system   TEXT    NOT NULL,
        scan_type     TEXT    NOT NULL,
        status        TEXT    NOT NULL,
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER,
        files_found   INTEGER NOT NULL DEFAULT 0,
        bytes_found   INTEGER NOT NULL DEFAULT 0,
        processed     INTEGER NOT NULL DEFAULT 0,
        total         INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );
    `)

    db.exec(`
      CREATE TABLE recovered_file (
        id            TEXT    NOT NULL PRIMARY KEY,
        session_id    TEXT    NOT NULL REFERENCES scan_session(id) ON DELETE CASCADE,
        name          TEXT    NOT NULL,
        -- Lower-cased copy so search does not need a scan-wide LOWER() call.
        name_lower    TEXT    NOT NULL,
        path          TEXT    NOT NULL,
        extension     TEXT    NOT NULL,
        category      TEXT    NOT NULL,
        size_bytes    INTEGER NOT NULL,
        is_deleted    INTEGER NOT NULL CHECK (is_deleted IN (0, 1)),
        is_directory  INTEGER NOT NULL CHECK (is_directory IN (0, 1)),
        created_at    INTEGER,
        modified_at   INTEGER,
        accessed_at   INTEGER,
        quality       TEXT    NOT NULL,
        -- Ordinal rank of the quality column, so sorting is a numeric comparison
        -- rather than an alphabetical one putting "excellent" below "fair".
        quality_rank  INTEGER NOT NULL,
        source        TEXT    NOT NULL,
        -- JSON array of {offsetBytes, lengthBytes}. Opaque to SQL: nothing
        -- queries inside it, and a child table would cost a join per row on a
        -- table with millions of them.
        extents       TEXT    NOT NULL,
        has_resident  INTEGER NOT NULL CHECK (has_resident IN (0, 1)),
        is_fragmented INTEGER NOT NULL CHECK (is_fragmented IN (0, 1)),
        is_compressed INTEGER NOT NULL CHECK (is_compressed IN (0, 1)),
        is_encrypted  INTEGER NOT NULL CHECK (is_encrypted IN (0, 1))
      );
    `)

    /*
     * Every index is led by `session_id`, because every query the results grid
     * makes is scoped to one session. A composite index in that order serves
     * both the filter and the sort from a single structure.
     */
    db.exec(`
      CREATE INDEX idx_recovered_session   ON recovered_file (session_id);
      CREATE INDEX idx_recovered_category  ON recovered_file (session_id, category);
      CREATE INDEX idx_recovered_name      ON recovered_file (session_id, name_lower);
      CREATE INDEX idx_recovered_size      ON recovered_file (session_id, size_bytes);
      CREATE INDEX idx_recovered_modified  ON recovered_file (session_id, modified_at);
      CREATE INDEX idx_recovered_quality   ON recovered_file (session_id, quality_rank);
      CREATE INDEX idx_recovered_deleted   ON recovered_file (session_id, is_deleted);
      CREATE INDEX idx_session_started     ON scan_session (started_at DESC);
    `)
  },
}

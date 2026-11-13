import type { Migration } from '../migration-plan'

/**
 * Initial schema.
 *
 * Scope is deliberately limited to what the foundation module actually uses:
 * user settings and window geometry. Scan sessions, recovered-file indexes,
 * licence records and disk-health history each arrive with the module that owns
 * them, in their own migration — so the schema history stays readable and every
 * table has an identifiable reason to exist.
 */
export const migration001: Migration = {
  version: 1,
  name: 'initial-schema',
  up: (db) => {
    // --- User settings ----------------------------------------------------
    // One row per setting rather than a single JSON blob: a corrupted value
    // degrades exactly one preference, and concurrent writes to different keys
    // never overwrite each other. See src/main/services/settings-codec.ts.
    db.exec(`
      CREATE TABLE app_settings (
        key        TEXT    NOT NULL PRIMARY KEY,
        value      TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
    `)

    // --- Window geometry --------------------------------------------------
    // Single-row table (enforced by the CHECK) so the restore path never has to
    // decide between competing rows after an unclean shutdown.
    db.exec(`
      CREATE TABLE window_state (
        id           INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
        x            INTEGER,
        y            INTEGER,
        width        INTEGER NOT NULL,
        height       INTEGER NOT NULL,
        is_maximized INTEGER NOT NULL DEFAULT 0 CHECK (is_maximized IN (0, 1)),
        updated_at   INTEGER NOT NULL
      );
    `)
  },
}

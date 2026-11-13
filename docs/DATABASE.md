# Database schema

RecoverX stores user settings, window geometry and — from later modules —
licence activation state and recovery history in a single local SQLite database.

|                        |                                                             |
| ---------------------- | ----------------------------------------------------------- |
| Engine                 | `node:sqlite` (built into the Node runtime Electron embeds) |
| File                   | `%APPDATA%\RecoverX\recoverx.db`                            |
| Journal                | WAL (`recoverx.db-wal`, `recoverx.db-shm`)                  |
| Current schema version | **1**                                                       |

No native addon is involved — see
[ADR-001](ARCHITECTURE.md#adr-001-nodesqlite-over-better-sqlite3).

---

## Connection

Applied to every connection, in `src/main/database/sqlite.ts`:

| Pragma         | Value           | Reason                                                                                               |
| -------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| `journal_mode` | `WAL`           | A long read (the Logs screen) must not block a write                                                 |
| `synchronous`  | `NORMAL`        | Correct pairing with WAL: durable across an application crash, at risk only from OS-level power loss |
| `foreign_keys` | `ON`            | SQLite disables them per-connection by default                                                       |
| `busy_timeout` | `5000` ms       | Prevents a checkpoint surfacing as a user-visible error                                              |
| `temp_store`   | `MEMORY`        | Keeps sort/join scratch off the disk being recovered                                                 |
| `cache_size`   | `-8000` (8 MiB) | Negative values are KiB                                                                              |

`wal_checkpoint(TRUNCATE)` runs on close, so the next start has no WAL to replay
and the size reported on the About screen is real.

---

## Tables

### `schema_migrations`

Owned by the migrator itself, not by a migration — it must be readable before
the migrator can decide what to run.

```sql
CREATE TABLE schema_migrations (
  version     INTEGER NOT NULL PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  INTEGER NOT NULL,  -- epoch ms
  duration_ms INTEGER NOT NULL
);
```

### `app_settings`

```sql
CREATE TABLE app_settings (
  key        TEXT    NOT NULL PRIMARY KEY,
  value      TEXT    NOT NULL,   -- JSON-encoded scalar
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

**One row per setting, not a single JSON blob.** Three reasons:

- A corrupted value degrades exactly one preference instead of all of them.
- Concurrent writers touching different keys never clobber each other.
- Adding a key in a later version needs no data migration.

`WITHOUT ROWID` suits a small table keyed by a short text primary key: the row
lives in the index B-tree, removing one indirection per lookup.

Decoding is handled by the pure codec in `src/main/services/settings-codec.ts`.
A value that is not valid JSON, or that fails its field schema, is replaced by
the default and reported — never fatal. Refusing to start over one bad row would
be a far worse outcome for a user whose only copy of their data is waiting to be
recovered. Repaired values are written back so the next start is clean.

### `window_state`

```sql
CREATE TABLE window_state (
  id           INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  x            INTEGER,
  y            INTEGER,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  is_maximized INTEGER NOT NULL DEFAULT 0 CHECK (is_maximized IN (0, 1)),
  updated_at   INTEGER NOT NULL
);
```

The `CHECK (id = 1)` makes this a single-row table, so the restore path never has
to choose between competing rows after an unclean shutdown. `x`/`y` are nullable,
meaning "centre the window".

A saved position is discarded on load if it no longer intersects a connected
display — restoring a window to an unplugged monitor puts it somewhere the user
cannot reach it.

---

## Conventions

- **Timestamps are epoch milliseconds** stored as `INTEGER`. They survive
  structured cloning without `Date` reconstruction, sort numerically, and remove
  a whole class of timezone bug from persistence. Formatting happens once, at
  the UI edge, in the user's locale.
- **Booleans are `INTEGER` 0/1** with a `CHECK` constraint — SQLite has no
  boolean type.
- **Reads go through typed column readers** (`readText`, `readInteger`,
  `readBoolean`, …). The driver returns `Record<string, primitive>`, so a
  schema mismatch would otherwise propagate an `undefined` into application
  state instead of failing where it happened.

---

## Migrations

Declared in `src/main/database/migrations/`, registered in order in `index.ts`.

**Rules, enforced at startup by `assertValidMigrationList`:**

- Versions are contiguous, ascending, and start at 1.
- A migration that has shipped is never edited — write a new one.
- Every migration has a non-empty name.

**Execution.** Each migration runs inside a transaction _together with_ the
bookkeeping row that records it. That pairing is what makes the process
crash-safe: it is impossible to end up with a schema change whose version was
not recorded, or a recorded version whose change did not apply.

**Downgrade protection.** A `schema_migrations` maximum above anything the build
ships means the user installed an older version over a newer database. This is
refused outright — old code reading a newer schema is silent corruption.

### Adding a migration

```ts
// src/main/database/migrations/002-scan-sessions.ts
import type { Migration } from '../migration-plan'

export const migration002: Migration = {
  version: 2,
  name: 'scan-sessions',
  up: (db) => {
    db.exec(`
      CREATE TABLE scan_session (
        id         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        device_id  TEXT    NOT NULL,
        started_at INTEGER NOT NULL
      );
    `)
  },
}
```

Register it, then add a test to `tests/unit/main/database.test.ts`. That suite
runs against a real SQLite file, so a migration is verified rather than assumed.

---

## Corruption handling

On open, the database is checked with `PRAGMA quick_check(1)` — page structure
and index integrity, without the full table scan `integrity_check` performs, so
startup stays fast as recovery history grows.

If the file cannot be opened or fails the check:

1. The main file is **renamed**, never deleted, to
   `recoverx.db.corrupt-<ISO timestamp>` — support can still extract an
   activation record from it. WAL and SHM companions follow if they move.
2. A fresh database is created and migrated.
3. An `error` record is written naming both paths.

If the rename itself fails — a stale handle, a read-only volume — the user gets
an accurate "damaged and cannot be replaced" error rather than a misleading
"could not create database".

> A subtle failure mode worth knowing about: `sqlite3_open_v2` does not read the
> file header, so opening a corrupt file _succeeds_ and the first pragma is what
> fails. If that handle is not closed, Windows keeps a file lock and the
> quarantine rename fails. `openSqlite` closes on failure for exactly this
> reason, and `tests/unit/main/database.test.ts` covers it.

---

## Planned tables

Added by the module that owns them, so every table has an identifiable reason to
exist:

| Module         | Tables                              |
| -------------- | ----------------------------------- |
| Disk detection | `device`, `volume`, `partition`     |
| Scanning       | `scan_session`, `scan_progress`     |
| Recovery       | `recovered_file`, `recovery_job`    |
| Disk health    | `smart_snapshot`, `smart_attribute` |
| Activation     | `license`, `activation_event`       |

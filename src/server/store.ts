import { LicenseEditionSchema, type LicenseEdition } from '@shared/types/license'
import {
  type SqliteDatabase,
  type SqliteRow,
  checkpoint,
  openSqlite,
  pragmaGet,
  readInteger,
  readOptionalInteger,
  readOptionalText,
  readText,
  toChangeCount,
  withTransaction,
} from '@main/database/sqlite'

/**
 * Persistence for the licence server.
 *
 * Three tables. Nothing is deleted from the first two, and from the third
 * only once it is old enough that the privacy policy says it must go:
 *
 *  - `licenses` is the system of record for what was sold. Revocation and
 *    expiry are columns, not deletions, so a refunded key can be looked up when
 *    its owner writes in asking why it stopped working.
 *  - `activations` holds one row per (key, machine) pair ever activated. A
 *    released seat keeps its row with `released_at` set, which is what lets
 *    support answer "which computers has this key been on?".
 *  - `events` is an append-only audit trail of every state change and every
 *    refusal of a known key. It is also the durable memory behind the
 *    self-service release allowance: a customer's releases are counted from
 *    their `deactivated` events, so the count survives restarts and needs no
 *    column of its own (see `LicenseAuthority.deactivate`). The rows carry
 *    the address each request came from, so they are deleted once they pass
 *    the retention the privacy policy promises (13 months by default; see
 *    `EventRetention` in retention.ts), which is never shorter than the
 *    allowance's window.
 *
 * The SQLite file is the only state the server has. Back it up together with
 * the signing key; see docs/LICENSE-SERVER.md.
 */

/** Editions a licence row may hold. Free needs no licence and has no row. */
export type PaidEdition = Exclude<LicenseEdition, 'free'>

export interface LicenseRecord {
  /** The canonical, formatted key: `RECX-XXXXX-XXXXX-XXXXX-XXXXX`. */
  readonly key: string
  readonly edition: PaidEdition
  readonly registeredTo: string | null
  readonly email: string | null
  /** Machines this licence may be active on at once. `null` is unlimited. */
  readonly maxActivations: number | null
  /** Epoch ms at which the licence stops working. `null` is perpetual. */
  readonly expiresAt: number | null
  readonly createdAt: number
  readonly revokedAt: number | null
  readonly revokeReason: string | null
  /** The shop's order or invoice reference, used to make minting idempotent. */
  readonly orderRef: string | null
  readonly notes: string | null
}

export interface LicenseSummary extends LicenseRecord {
  /** Machines currently holding a seat. */
  readonly activeSeats: number
}

export interface ActivationRecord {
  readonly key: string
  readonly machineId: string
  readonly firstActivatedAt: number
  readonly lastActivatedAt: number
  /** When the seat was given back. `null` while the machine holds it. */
  readonly releasedAt: number | null
}

export const EVENT_TYPES = [
  'license-created',
  'activated',
  'reactivated',
  'activation-refused',
  /**
   * A customer released a seat themselves. Counted by the self-service
   * allowance, so it is written for that and nothing else — an operator's
   * release is `seat-released` or `seats-reset`, which are never counted.
   */
  'deactivated',
  'deactivation-noop',
  /** A self-service release refused because the allowance was spent. */
  'deactivation-refused',
  'offline-issued',
  'revoked',
  'restored',
  'extended',
  'seat-released',
  'seats-reset',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export interface NewEvent {
  readonly at: number
  readonly type: EventType
  readonly key: string | null
  readonly machineId: string | null
  readonly ip: string | null
  /** Small JSON object with event-specific context. */
  readonly detail: string | null
}

export interface EventRecord extends Omit<NewEvent, 'type'> {
  readonly id: number
  /**
   * Read back as plain text: a row written by a newer server release may carry
   * a type this one does not know, and it should still be shown, not hidden.
   */
  readonly type: string
}

export interface LicenseFilter {
  readonly edition?: PaidEdition | undefined
  /** Substring match over key, registered name, e-mail and order reference. */
  readonly search?: string | undefined
  /** Exact order reference. */
  readonly orderRef?: string | undefined
  readonly limit: number
  readonly offset: number
}

interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

/**
 * Schema history, tracked in SQLite's own `user_version` header field.
 *
 * Append only. A migration that has shipped is never edited, because a server
 * that already applied it will not apply it again, and the two databases would
 * silently disagree about their own shape.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE licenses (
        key              TEXT PRIMARY KEY NOT NULL,
        edition          TEXT NOT NULL CHECK (edition <> 'free'),
        registered_to    TEXT,
        email            TEXT,
        max_activations  INTEGER CHECK (max_activations IS NULL OR max_activations >= 1),
        expires_at       INTEGER,
        created_at       INTEGER NOT NULL,
        revoked_at       INTEGER,
        revoke_reason    TEXT,
        order_ref        TEXT,
        notes            TEXT
      ) STRICT;

      CREATE INDEX licenses_order_ref ON licenses (order_ref) WHERE order_ref IS NOT NULL;
      CREATE INDEX licenses_created_at ON licenses (created_at);

      CREATE TABLE activations (
        key                 TEXT NOT NULL REFERENCES licenses (key),
        machine_id          TEXT NOT NULL,
        first_activated_at  INTEGER NOT NULL,
        last_activated_at   INTEGER NOT NULL,
        released_at         INTEGER,
        PRIMARY KEY (key, machine_id)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX activations_live ON activations (key) WHERE released_at IS NULL;

      CREATE TABLE events (
        id          INTEGER PRIMARY KEY,
        at          INTEGER NOT NULL,
        type        TEXT NOT NULL,
        key         TEXT,
        machine_id  TEXT,
        ip          TEXT,
        detail      TEXT
      ) STRICT;

      CREATE INDEX events_key_at ON events (key, at);
    `,
  },
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

/** How long a write waits for another connection's lock unless told otherwise. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

export interface OpenStoreOptions {
  /** How long a write waits for another connection's lock before failing. */
  readonly busyTimeoutMs?: number
}

export class LicenseStore {
  readonly db: SqliteDatabase

  private constructor(db: SqliteDatabase) {
    this.db = db
  }

  /**
   * Open (creating if necessary) and migrate the database.
   *
   * `synchronous = FULL` overrides the desktop application's `NORMAL`. The
   * trade is different here: a licence minted for a customer who has already
   * been e-mailed the key must survive a power cut, and the licence server's
   * write rate is far too low for the extra fsync to matter.
   *
   * The busy timeout is set again with a pragma. `openSqlite` passes it as
   * DatabaseSync's `timeout` option, which older Node releases that still have
   * node:sqlite (22.13 is the documented minimum) silently ignore, leaving a
   * timeout of 0. The server and the admin CLI open the same file, so without
   * it whichever reached `BEGIN IMMEDIATE` second would fail at once with
   * SQLITE_BUSY — a 503 for the customer — instead of waiting its turn.
   */
  static open(filePath: string, options: OpenStoreOptions = {}): LicenseStore {
    const busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))
    const db = openSqlite(filePath, { busyTimeoutMs })

    try {
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
      db.exec('PRAGMA synchronous = FULL')
      migrate(db)
      return new LicenseStore(db)
    } catch (error) {
      try {
        db.close()
      } catch {
        // The migration error is the one worth reporting.
      }
      throw error
    }
  }

  /**
   * Run `fn` atomically.
   *
   * `BEGIN IMMEDIATE` (see `withTransaction`) takes the write lock before the
   * first read, which is what makes "count the live seats, then take one" safe
   * against a second connection — another server process, or the admin CLI
   * issuing an offline activation — doing the same thing at the same moment.
   * With a deferred transaction both could count the same free seat.
   */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn)
  }

  /** Cheap liveness probe for `/healthz`. */
  ping(): void {
    this.db.prepare('SELECT 1').get()
  }

  close(): void {
    checkpoint(this.db)
    this.db.close()
  }

  // --- licences --------------------------------------------------------------

  insertLicense(record: LicenseRecord): void {
    this.db
      .prepare(
        `INSERT INTO licenses
           (key, edition, registered_to, email, max_activations, expires_at, created_at,
            revoked_at, revoke_reason, order_ref, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.key,
        record.edition,
        record.registeredTo,
        record.email,
        record.maxActivations,
        record.expiresAt,
        record.createdAt,
        record.revokedAt,
        record.revokeReason,
        record.orderRef,
        record.notes,
      )
  }

  getLicense(key: string): LicenseRecord | null {
    const row = this.db.prepare('SELECT * FROM licenses WHERE key = ?').get(key)
    return row === undefined ? null : toLicense(row)
  }

  findByOrderRef(orderRef: string): LicenseRecord[] {
    return this.db
      .prepare('SELECT * FROM licenses WHERE order_ref = ? ORDER BY created_at, key')
      .all(orderRef)
      .map(toLicense)
  }

  listLicenses(filter: LicenseFilter): LicenseSummary[] {
    const clauses: string[] = []
    const parameters: Array<string | number> = []

    if (filter.edition !== undefined) {
      clauses.push('l.edition = ?')
      parameters.push(filter.edition)
    }

    if (filter.orderRef !== undefined) {
      clauses.push('l.order_ref = ?')
      parameters.push(filter.orderRef)
    }

    if (filter.search !== undefined && filter.search.length > 0) {
      const pattern = `%${escapeLike(filter.search)}%`
      clauses.push(
        `(l.key LIKE ? ESCAPE '\\' OR l.registered_to LIKE ? ESCAPE '\\'
          OR l.email LIKE ? ESCAPE '\\' OR l.order_ref LIKE ? ESCAPE '\\')`,
      )
      parameters.push(pattern, pattern, pattern, pattern)
    }

    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`

    return this.db
      .prepare(
        `SELECT l.*,
                (SELECT COUNT(*) FROM activations a
                  WHERE a.key = l.key AND a.released_at IS NULL) AS active_seats
           FROM licenses l
           ${where}
          ORDER BY l.created_at DESC, l.key
          LIMIT ? OFFSET ?`,
      )
      .all(...parameters, filter.limit, filter.offset)
      .map((row) => ({ ...toLicense(row), activeSeats: readInteger(row, 'active_seats') }))
  }

  setRevocation(key: string, revokedAt: number | null, reason: string | null): void {
    this.db
      .prepare('UPDATE licenses SET revoked_at = ?, revoke_reason = ? WHERE key = ?')
      .run(revokedAt, reason, key)
  }

  setExpiry(key: string, expiresAt: number | null): void {
    this.db.prepare('UPDATE licenses SET expires_at = ? WHERE key = ?').run(expiresAt, key)
  }

  // --- activations -----------------------------------------------------------

  getActivation(key: string, machineId: string): ActivationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM activations WHERE key = ? AND machine_id = ?')
      .get(key, machineId)
    return row === undefined ? null : toActivation(row)
  }

  listActivations(key: string): ActivationRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM activations WHERE key = ?
          ORDER BY released_at IS NOT NULL, last_activated_at DESC`,
      )
      .all(key)
      .map(toActivation)
  }

  countActiveSeats(key: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM activations WHERE key = ? AND released_at IS NULL')
      .get(key)
    return row === undefined ? 0 : readInteger(row, 'n')
  }

  /**
   * Give a machine a seat, or take a previously released one back.
   *
   * A machine that comes back after deactivating keeps its original
   * `first_activated_at`, so the history reads as one machine that left and
   * returned rather than two unrelated ones.
   */
  claimSeat(key: string, machineId: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO activations (key, machine_id, first_activated_at, last_activated_at, released_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (key, machine_id)
         DO UPDATE SET last_activated_at = excluded.last_activated_at, released_at = NULL`,
      )
      .run(key, machineId, now, now)
  }

  /** Record that a machine already holding a seat activated again. */
  touchSeat(key: string, machineId: string, now: number): void {
    this.db
      .prepare('UPDATE activations SET last_activated_at = ? WHERE key = ? AND machine_id = ?')
      .run(now, key, machineId)
  }

  /** Release one machine's seat. Returns whether a seat was actually held. */
  releaseSeat(key: string, machineId: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE activations SET released_at = ?
          WHERE key = ? AND machine_id = ? AND released_at IS NULL`,
      )
      .run(now, key, machineId)
    return toChangeCount(result.changes) > 0
  }

  /** Release every seat a licence holds. Returns how many were held. */
  releaseAllSeats(key: string, now: number): number {
    const result = this.db
      .prepare('UPDATE activations SET released_at = ? WHERE key = ? AND released_at IS NULL')
      .run(now, key)
    return toChangeCount(result.changes)
  }

  // --- audit -----------------------------------------------------------------

  recordEvent(event: NewEvent): void {
    this.db
      .prepare(
        'INSERT INTO events (at, type, key, machine_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(event.at, event.type, event.key, event.machineId, event.ip, event.detail)
  }

  /**
   * How many events of one type a licence has recorded strictly after `after`.
   *
   * Served by the `events_key_at` index, so counting a year of one key's
   * history reads that key's rows in that range and nothing else.
   */
  countEventsAfter(key: string, type: EventType, after: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE key = ? AND at > ? AND type = ?')
      .get(key, after, type)
    return row === undefined ? 0 : readInteger(row, 'n')
  }

  /**
   * How many events, of any licence, were recorded strictly before `cutoff`.
   *
   * There is no index on `at` alone, so this and `deleteEventsBefore` read
   * the whole table. That is deliberate: they run once a day, the table holds
   * a little over a year of a small shop's activations, and an index would
   * mean a schema version the PHP port, which shares this database format,
   * would then have to apply as well.
   */
  countEventsBefore(cutoff: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE at < ?').get(cutoff)
    return row === undefined ? 0 : readInteger(row, 'n')
  }

  /**
   * Delete every event recorded strictly before `cutoff`, returning how many
   * went. Only `EventRetention` calls this; nothing else deletes history.
   */
  deleteEventsBefore(cutoff: number): number {
    const result = this.db.prepare('DELETE FROM events WHERE at < ?').run(cutoff)
    return toChangeCount(result.changes)
  }

  /** The most recent events for a licence, newest first. */
  listEvents(key: string, limit: number): EventRecord[] {
    return this.db
      .prepare('SELECT * FROM events WHERE key = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(key, limit)
      .map(toEvent)
  }
}

/** Apply every migration newer than the database, each in its own transaction. */
function migrate(db: SqliteDatabase): void {
  const row = pragmaGet(db, 'user_version')
  const current = row === undefined ? 0 : readInteger(row, 'user_version')

  if (current > SCHEMA_VERSION) {
    // Running an older server against a newer database would read columns it
    // does not know about as if they did not exist — and write rows without
    // them. Refusing is the only safe answer.
    throw new Error(
      `The licence database is at schema version ${current}, but this server only understands up to ${SCHEMA_VERSION}. Run the newer server release, or restore a backup taken before the upgrade.`,
    )
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue

    withTransaction(db, () => {
      db.exec(migration.sql)
      // `user_version` is part of the database header and is written inside the
      // transaction, so the schema change and its version commit together.
      db.exec(`PRAGMA user_version = ${migration.version}`)
    })
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/gu, (character) => `\\${character}`)
}

function toLicense(row: SqliteRow): LicenseRecord {
  const edition = LicenseEditionSchema.parse(readText(row, 'edition'))
  if (edition === 'free') {
    // The CHECK constraint makes this unreachable; the narrowing makes it typed.
    throw new Error('A licence row holds the Free edition, which the schema forbids')
  }

  return {
    key: readText(row, 'key'),
    edition,
    registeredTo: readOptionalText(row, 'registered_to'),
    email: readOptionalText(row, 'email'),
    maxActivations: readOptionalInteger(row, 'max_activations'),
    expiresAt: readOptionalInteger(row, 'expires_at'),
    createdAt: readInteger(row, 'created_at'),
    revokedAt: readOptionalInteger(row, 'revoked_at'),
    revokeReason: readOptionalText(row, 'revoke_reason'),
    orderRef: readOptionalText(row, 'order_ref'),
    notes: readOptionalText(row, 'notes'),
  }
}

function toActivation(row: SqliteRow): ActivationRecord {
  return {
    key: readText(row, 'key'),
    machineId: readText(row, 'machine_id'),
    firstActivatedAt: readInteger(row, 'first_activated_at'),
    lastActivatedAt: readInteger(row, 'last_activated_at'),
    releasedAt: readOptionalInteger(row, 'released_at'),
  }
}

function toEvent(row: SqliteRow): EventRecord {
  return {
    id: readInteger(row, 'id'),
    at: readInteger(row, 'at'),
    type: readText(row, 'type'),
    key: readOptionalText(row, 'key'),
    machineId: readOptionalText(row, 'machine_id'),
    ip: readOptionalText(row, 'ip'),
    detail: readOptionalText(row, 'detail'),
  }
}

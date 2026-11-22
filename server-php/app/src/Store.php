<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

use PDO;
use PDOException;

/**
 * Persistence: one SQLite file in the private data directory.
 *
 * The licence tables — `licenses`, `activations` and `events` — are the
 * reference server's schema (src/server/store.ts), migration for migration,
 * tracked in the same `user_version` header field. The file is therefore
 * interchangeable with the Node server's: a vendor who outgrows shared hosting
 * copies `licences.db` and `signing.key` to a VPS and starts the Node server on
 * them, with nothing to convert.
 *
 * PHP serves each request in a fresh process, so state the Node server keeps
 * in memory has to live here too: the rate limiter's token buckets
 * (`rate_limits`), failed admin sign-ins (`login_attempts`) and when periodic
 * work last ran (`housekeeping` — the Node server keeps a timer instead).
 * The website's order form (`Order\OrderForm`) is this server's alone, and so
 * is the table it fills: `orders`, one row per request, which the admin panel
 * lists and the vendor follows up. Those tables are created outside the
 * versioned migrations — they are this server's private bookkeeping, and
 * keeping them out of `user_version` is what keeps the file openable by the
 * reference server, which refuses a database newer than it knows (and ignores
 * tables it does not use).
 *
 * Nothing in `licenses` or `activations` is ever deleted: revocation and
 * expiry are columns, and released seats keep their rows. The event log is
 * append-only until its rows pass the retention the privacy policy promises
 * (13 months by default; see `EventRetention`), when they are deleted. The
 * self-service release allowance is counted from that log, which is why the
 * retention can never be shorter than the allowance's window. The other rows
 * that hold an address — rate-limit buckets and failed sign-ins — are deleted
 * by the same pass, sooner. Orders are deleted by it too, 24 months after
 * they last changed (`EventRetention::ORDER_DAYS`), or at once from the panel.
 *
 * Not final, for testing only: the concurrency tests pause a connection
 * between a count and the write it guards by overriding the count, as the
 * reference's tests do with a Proxy around its store, and the order tests
 * force a reference collision through `newOrderRef`.
 */
class Store
{
    /** How long a write waits for another request's lock before giving up. */
    public const BUSY_TIMEOUT_MS = 5000;

    /**
     * Failed admin sign-ins are kept this long. The longest window that reads
     * them is the panel's fifteen minutes; a day leaves room to read the
     * pattern without keeping anyone's address for long.
     */
    public const LOGIN_FAILURES_KEPT_MS = 86_400_000;

    public const SCHEMA_VERSION = 1;

    public const EVENT_TYPES = [
        'license-created',
        'activated',
        'reactivated',
        'activation-refused',
        'deactivated',
        'deactivation-noop',
        'deactivation-refused',
        'offline-issued',
        'revoked',
        'restored',
        'extended',
        'seat-released',
        'seats-reset',
    ];

    public const PAID_EDITIONS = ['professional', 'business', 'technician', 'enterprise'];

    /**
     * Where an order from the website form stands, as the vendor follows it
     * up, with the label the admin panel shows. New orders start at `new`;
     * creating its licences moves an open order to `licensed`.
     */
    public const ORDER_STATUSES = [
        'new' => 'New',
        'contacted' => 'Contacted',
        'paid' => 'Paid',
        'licensed' => 'Licence sent',
        'cancelled' => 'Cancelled',
    ];

    /** The statuses creating an order's licences moves on to `licensed`. */
    private const OPEN_ORDER_STATUSES = ['new', 'contacted', 'paid'];

    private int $depth = 0;

    private function __construct(public readonly PDO $pdo, public readonly string $file)
    {
    }

    /**
     * Open (creating if necessary) and migrate the database.
     *
     * WAL lets readers proceed while a write commits; `synchronous = FULL`
     * because a licence minted for a customer who has already been e-mailed
     * the key must survive a power cut; foreign keys on, as the reference
     * opens it; and a busy timeout so two requests reaching `BEGIN IMMEDIATE`
     * together queue instead of one failing at once.
     *
     * `secure_delete` overwrites what a DELETE removes with zeros. Without it
     * a deleted event's address stays readable in the file's free pages until
     * SQLite happens to reuse them, and "13 months, then deleted" would only
     * be true of what a query can see. ON rather than FAST, which leaves
     * whole free pages as they were. The cost is a few extra page writes on
     * the rare delete; the database is small.
     */
    public static function open(string $file, int $busyTimeoutMs = self::BUSY_TIMEOUT_MS): static
    {
        $pdo = new PDO('sqlite:' . $file, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => max(1, intdiv($busyTimeoutMs + 999, 1000)),
        ]);

        $pdo->exec('PRAGMA busy_timeout = ' . max(0, $busyTimeoutMs));
        $pdo->query('PRAGMA journal_mode = WAL')->fetchAll();
        $pdo->exec('PRAGMA synchronous = FULL');
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA temp_store = MEMORY');
        $pdo->exec('PRAGMA secure_delete = ON');

        $store = new static($pdo, $file);
        $store->migrate();

        return $store;
    }

    public function sqliteVersion(): string
    {
        return (string) $this->pdo->query('SELECT sqlite_version()')->fetchColumn();
    }

    /**
     * Run `$fn` atomically.
     *
     * `BEGIN IMMEDIATE` takes the write lock before the first read, which is
     * what makes "count the live seats, then take one" — and "count the
     * releases, then release" — safe against another request doing the same
     * at the same moment. Nested calls become savepoints.
     *
     * @template T
     * @param callable(): T $fn
     * @return T
     */
    public function transaction(callable $fn): mixed
    {
        $outermost = $this->depth === 0;
        $savepoint = 'recoverx_sp_' . $this->depth;

        $this->pdo->exec($outermost ? 'BEGIN IMMEDIATE' : "SAVEPOINT {$savepoint}");
        $this->depth += 1;

        try {
            $result = $fn();
        } catch (\Throwable $error) {
            $this->depth -= 1;
            try {
                $this->pdo->exec($outermost ? 'ROLLBACK' : "ROLLBACK TO {$savepoint}; RELEASE {$savepoint}");
            } catch (\Throwable) {
                // The original error is the one the caller needs.
            }
            throw $error;
        }

        $this->depth -= 1;
        $this->pdo->exec($outermost ? 'COMMIT' : "RELEASE {$savepoint}");

        return $result;
    }

    /** Cheap liveness probe for `/healthz`. */
    public function ping(): void
    {
        $this->pdo->query('SELECT 1')->fetchColumn();
    }

    /** Whether a thrown error is SQLite reporting a lock it could not get (BUSY or LOCKED). */
    public static function isBusy(\Throwable $error): bool
    {
        for ($current = $error; $current !== null; $current = $current->getPrevious()) {
            if ($current instanceof PDOException) {
                $code = $current->errorInfo[1] ?? null;
                if (is_int($code) && in_array($code & 0xff, [5, 6], true)) {
                    return true;
                }
                if (preg_match('/database (table )?is locked|database is busy/i', $current->getMessage()) === 1) {
                    return true;
                }
            }
        }

        return false;
    }

    // --- licences ---------------------------------------------------------------

    /** @param array<string, mixed> $record a licence record as built by Authority */
    public function insertLicense(array $record): void
    {
        $this->run(
            'INSERT INTO licenses
               (key, edition, registered_to, email, max_activations, expires_at, created_at,
                revoked_at, revoke_reason, order_ref, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $record['key'], $record['edition'], $record['registeredTo'], $record['email'],
                $record['maxActivations'], $record['expiresAt'], $record['createdAt'],
                $record['revokedAt'], $record['revokeReason'], $record['orderRef'], $record['notes'],
            ],
        );
    }

    /** @return null|array<string, mixed> */
    public function getLicense(string $key): ?array
    {
        $row = $this->run('SELECT * FROM licenses WHERE key = ?', [$key])->fetch();

        return $row === false ? null : self::toLicense($row);
    }

    /** @return list<array<string, mixed>> */
    public function findByOrderRef(string $orderRef): array
    {
        $rows = $this->run('SELECT * FROM licenses WHERE order_ref = ? ORDER BY created_at, key', [$orderRef])->fetchAll();

        return array_map(self::toLicense(...), $rows);
    }

    /**
     * Licences with their live seat counts, newest first.
     *
     * `search` is a substring match over key, registered name, e-mail and
     * order reference; `standing` (active / revoked / expired) is this
     * server's addition for the admin panel's filter.
     *
     * @param array{edition?: ?string, search?: ?string, orderRef?: ?string, standing?: ?string, now?: int, limit: int, offset: int} $filter
     * @return list<array<string, mixed>>
     */
    public function listLicenses(array $filter): array
    {
        $clauses = [];
        $parameters = [];

        if (($filter['edition'] ?? null) !== null) {
            $clauses[] = 'l.edition = ?';
            $parameters[] = $filter['edition'];
        }

        if (($filter['orderRef'] ?? null) !== null) {
            $clauses[] = 'l.order_ref = ?';
            $parameters[] = $filter['orderRef'];
        }

        $search = $filter['search'] ?? null;
        if ($search !== null && $search !== '') {
            $pattern = '%' . self::escapeLike($search) . '%';
            $clauses[] = "(l.key LIKE ? ESCAPE '\\' OR l.registered_to LIKE ? ESCAPE '\\'
                OR l.email LIKE ? ESCAPE '\\' OR l.order_ref LIKE ? ESCAPE '\\')";
            array_push($parameters, $pattern, $pattern, $pattern, $pattern);
        }

        $now = $filter['now'] ?? 0;
        switch ($filter['standing'] ?? null) {
            case 'revoked':
                $clauses[] = 'l.revoked_at IS NOT NULL';
                break;
            case 'expired':
                $clauses[] = 'l.revoked_at IS NULL AND l.expires_at IS NOT NULL AND l.expires_at <= ?';
                $parameters[] = $now;
                break;
            case 'active':
                $clauses[] = 'l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?)';
                $parameters[] = $now;
                break;
        }

        $where = $clauses === [] ? '' : 'WHERE ' . implode(' AND ', $clauses);
        array_push($parameters, $filter['limit'], $filter['offset']);

        $rows = $this->run(
            "SELECT l.*,
                    (SELECT COUNT(*) FROM activations a
                      WHERE a.key = l.key AND a.released_at IS NULL) AS active_seats
               FROM licenses l
               {$where}
              ORDER BY l.created_at DESC, l.key
              LIMIT ? OFFSET ?",
            $parameters,
        )->fetchAll();

        return array_map(
            static fn (array $row): array => self::toLicense($row) + ['activeSeats' => (int) $row['active_seats']],
            $rows,
        );
    }

    public function setRevocation(string $key, ?int $revokedAt, ?string $reason): void
    {
        $this->run('UPDATE licenses SET revoked_at = ?, revoke_reason = ? WHERE key = ?', [$revokedAt, $reason, $key]);
    }

    public function setExpiry(string $key, ?int $expiresAt): void
    {
        $this->run('UPDATE licenses SET expires_at = ? WHERE key = ?', [$expiresAt, $key]);
    }

    /** Replace the personal details a licence was sold with: who it is registered to, their e-mail, the vendor's notes. */
    public function setDetails(string $key, ?string $registeredTo, ?string $email, ?string $notes): void
    {
        $this->run('UPDATE licenses SET registered_to = ?, email = ?, notes = ? WHERE key = ?', [$registeredTo, $email, $notes, $key]);
    }

    public function clearOrderRef(string $key): void
    {
        $this->run('UPDATE licenses SET order_ref = NULL WHERE key = ?', [$key]);
    }

    // --- activations ------------------------------------------------------------

    /** @return null|array<string, mixed> */
    public function getActivation(string $key, string $machineId): ?array
    {
        $row = $this->run('SELECT * FROM activations WHERE key = ? AND machine_id = ?', [$key, $machineId])->fetch();

        return $row === false ? null : self::toActivation($row);
    }

    /** @return list<array<string, mixed>> */
    public function listActivations(string $key): array
    {
        $rows = $this->run(
            'SELECT * FROM activations WHERE key = ?
              ORDER BY released_at IS NOT NULL, last_activated_at DESC',
            [$key],
        )->fetchAll();

        return array_map(self::toActivation(...), $rows);
    }

    public function countActiveSeats(string $key): int
    {
        return (int) $this->run(
            'SELECT COUNT(*) FROM activations WHERE key = ? AND released_at IS NULL',
            [$key],
        )->fetchColumn();
    }

    /**
     * Give a machine a seat, or take a previously released one back, keeping
     * its original `first_activated_at` so the history reads as one machine
     * that left and returned.
     *
     * An update-then-insert rather than `ON CONFLICT … DO UPDATE`, which needs
     * SQLite 3.24; shared hosts sometimes link older ones. The caller holds
     * the write lock, so the two statements cannot interleave with another
     * request's.
     */
    public function claimSeat(string $key, string $machineId, int $now): void
    {
        $updated = $this->run(
            'UPDATE activations SET last_activated_at = ?, released_at = NULL WHERE key = ? AND machine_id = ?',
            [$now, $key, $machineId],
        )->rowCount();

        if ($updated === 0) {
            $this->run(
                'INSERT INTO activations (key, machine_id, first_activated_at, last_activated_at, released_at)
                 VALUES (?, ?, ?, ?, NULL)',
                [$key, $machineId, $now, $now],
            );
        }
    }

    /** Record that a machine already holding a seat activated again. */
    public function touchSeat(string $key, string $machineId, int $now): void
    {
        $this->run('UPDATE activations SET last_activated_at = ? WHERE key = ? AND machine_id = ?', [$now, $key, $machineId]);
    }

    /** Release one machine's seat. Returns whether a seat was actually held. */
    public function releaseSeat(string $key, string $machineId, int $now): bool
    {
        return $this->run(
            'UPDATE activations SET released_at = ?
              WHERE key = ? AND machine_id = ? AND released_at IS NULL',
            [$now, $key, $machineId],
        )->rowCount() > 0;
    }

    /** Release every seat a licence holds. Returns how many were held. */
    public function releaseAllSeats(string $key, int $now): int
    {
        return $this->run(
            'UPDATE activations SET released_at = ? WHERE key = ? AND released_at IS NULL',
            [$now, $key],
        )->rowCount();
    }

    // --- audit --------------------------------------------------------------------

    /** @param array{at: int, type: string, key: ?string, machineId: ?string, ip: ?string, detail: ?string} $event */
    public function recordEvent(array $event): void
    {
        $this->run(
            'INSERT INTO events (at, type, key, machine_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?)',
            [$event['at'], $event['type'], $event['key'], $event['machineId'], $event['ip'], $event['detail']],
        );
    }

    /** How many events of one type a licence has recorded strictly after `$after`. */
    public function countEventsAfter(string $key, string $type, int $after): int
    {
        return (int) $this->run(
            'SELECT COUNT(*) FROM events WHERE key = ? AND at > ? AND type = ?',
            [$key, $after, $type],
        )->fetchColumn();
    }

    /** How many events, of any licence, were recorded strictly before `$cutoff`. */
    public function countEventsBefore(int $cutoff): int
    {
        return (int) $this->run('SELECT COUNT(*) FROM events WHERE at < ?', [$cutoff])->fetchColumn();
    }

    /**
     * Delete every event recorded strictly before `$cutoff`. Returns how many
     * went. Only `EventRetention` calls this; nothing else deletes history.
     */
    public function deleteEventsBefore(int $cutoff): int
    {
        return $this->run('DELETE FROM events WHERE at < ?', [$cutoff])->rowCount();
    }

    /**
     * Forget the addresses in one licence's history, keeping what happened
     * and when. Returns how many events held one.
     */
    public function eraseEventAddresses(string $key): int
    {
        return $this->run('UPDATE events SET ip = NULL WHERE key = ? AND ip IS NOT NULL', [$key])->rowCount();
    }

    /** @return list<array<string, mixed>> the most recent events for a licence, newest first */
    public function listEvents(string $key, int $limit): array
    {
        $rows = $this->run('SELECT * FROM events WHERE key = ? ORDER BY at DESC, id DESC LIMIT ?', [$key, $limit])->fetchAll();

        return array_map(self::toEvent(...), $rows);
    }

    /** @return list<array<string, mixed>> the most recent events across all licences, for the dashboard */
    public function recentEvents(int $limit): array
    {
        $rows = $this->run('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?', [$limit])->fetchAll();

        return array_map(self::toEvent(...), $rows);
    }

    /**
     * Licence counts by edition and standing, for the dashboard.
     *
     * @return array<string, array{active: int, expired: int, revoked: int, seats: int}>
     */
    public function countsByEdition(int $now): array
    {
        $counts = [];
        foreach (self::PAID_EDITIONS as $edition) {
            $counts[$edition] = ['active' => 0, 'expired' => 0, 'revoked' => 0, 'seats' => 0];
        }

        $rows = $this->run(
            "SELECT edition,
                    CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                         WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 'expired'
                         ELSE 'active' END AS standing,
                    COUNT(*) AS n
               FROM licenses GROUP BY 1, 2",
            [$now],
        )->fetchAll();

        foreach ($rows as $row) {
            $counts[$row['edition']][$row['standing']] = (int) $row['n'];
        }

        $seats = $this->run(
            'SELECT l.edition, COUNT(*) AS n FROM activations a JOIN licenses l ON l.key = a.key
              WHERE a.released_at IS NULL GROUP BY 1',
        )->fetchAll();

        foreach ($seats as $row) {
            $counts[$row['edition']]['seats'] = (int) $row['n'];
        }

        return $counts;
    }

    // --- orders from the website form ----------------------------------------------

    /**
     * Store an order request as `OrderForm::parse` returns it, with status
     * `new`, under a fresh reference (`RX-` and eight hex digits). Empty
     * optional fields are stored as NULL. A reference that is already taken
     * is drawn again.
     *
     * @param array{edition: string, quantity: int, name: string, email: string, phoneCountry: string, phone: string, registerTo: string, gstin: string, message: string} $order
     * @return array{id: int, ref: string}
     */
    public function insertOrder(array $order, ?string $ip, int $now): array
    {
        $optional = static fn (string $value): ?string => $value === '' ? null : $value;

        for ($attempt = 1; ; $attempt++) {
            $ref = $this->newOrderRef();
            try {
                $this->run(
                    "INSERT INTO orders
                       (ref, created_at, updated_at, status, edition, quantity, name, email, phone, phone_country,
                        register_to, gstin, message, ip, notes, mailed_at)
                     VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
                    [
                        $ref, $now, $now, $order['edition'], $order['quantity'], $order['name'], $order['email'],
                        $order['phone'], $order['phoneCountry'], $optional($order['registerTo']), $optional($order['gstin']),
                        $optional($order['message']), $ip === '' ? null : $ip,
                    ],
                );
            } catch (PDOException $error) {
                if ($attempt < 5 && self::isRefCollision($error)) {
                    continue;
                }
                throw $error;
            }

            return ['id' => (int) $this->pdo->lastInsertId(), 'ref' => $ref];
        }
    }

    /** Record that the vendor was e-mailed about an order. */
    public function markOrderMailed(int $id, int $at): void
    {
        $this->run('UPDATE orders SET mailed_at = ? WHERE id = ?', [$at, $id]);
    }

    /** @return null|array<string, mixed> */
    public function getOrder(int $id): ?array
    {
        $row = $this->run('SELECT * FROM orders WHERE id = ?', [$id])->fetch();

        return $row === false ? null : self::toOrder($row);
    }

    /**
     * Orders, newest first.
     *
     * `search` is a substring match over the name, e-mail, mobile number,
     * reference, "register to" and GSTIN; a search made only of digits (and
     * the spaces, dashes and brackets people type in phone numbers) also
     * finds the mobile number whatever its spacing.
     *
     * @param array{status?: ?string, search?: ?string, limit: int, offset: int} $filter
     * @return list<array<string, mixed>>
     */
    public function listOrders(array $filter): array
    {
        $clauses = [];
        $parameters = [];

        if (($filter['status'] ?? null) !== null) {
            $clauses[] = 'status = ?';
            $parameters[] = $filter['status'];
        }

        $search = $filter['search'] ?? null;
        if ($search !== null && $search !== '') {
            $pattern = '%' . self::escapeLike($search) . '%';
            $match = ["name LIKE ? ESCAPE '\\'", "email LIKE ? ESCAPE '\\'", "phone LIKE ? ESCAPE '\\'", "ref LIKE ? ESCAPE '\\'",
                "register_to LIKE ? ESCAPE '\\'", "gstin LIKE ? ESCAPE '\\'"];
            array_push($parameters, $pattern, $pattern, $pattern, $pattern, $pattern, $pattern);

            $digits = preg_replace('/[\s()\-]+/', '', $search) ?? '';
            if (preg_match('/^\+?\d+$/D', $digits) === 1) {
                $match[] = "REPLACE(phone, ' ', '') LIKE ? ESCAPE '\\'";
                $parameters[] = '%' . self::escapeLike($digits) . '%';
            }

            $clauses[] = '(' . implode(' OR ', $match) . ')';
        }

        $where = $clauses === [] ? '' : 'WHERE ' . implode(' AND ', $clauses);
        array_push($parameters, $filter['limit'], $filter['offset']);

        $rows = $this->run("SELECT * FROM orders {$where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", $parameters)->fetchAll();

        return array_map(self::toOrder(...), $rows);
    }

    /**
     * How many orders are in each status, every status listed.
     *
     * @return array<string, int>
     */
    public function countOrdersByStatus(): array
    {
        $counts = array_fill_keys(array_keys(self::ORDER_STATUSES), 0);
        foreach ($this->run('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')->fetchAll() as $row) {
            $counts[(string) $row['status']] = (int) $row['n'];
        }

        return $counts;
    }

    /** Set an order's status and the vendor's notes. Returns whether the order exists. */
    public function updateOrder(int $id, string $status, ?string $notes, int $now): bool
    {
        if (!array_key_exists($status, self::ORDER_STATUSES)) {
            throw new \InvalidArgumentException("Unknown order status {$status}");
        }

        return $this->run('UPDATE orders SET status = ?, notes = ?, updated_at = ? WHERE id = ?', [$status, $notes, $now, $id])->rowCount() > 0;
    }

    /**
     * Mark the order with this reference as licensed once its licences have
     * been created — only while it is still open (new, contacted or paid), so
     * a cancelled order stays cancelled. Returns whether an order changed.
     */
    public function markOrderLicensed(string $ref, int $now): bool
    {
        $open = implode(', ', array_fill(0, count(self::OPEN_ORDER_STATUSES), '?'));

        return $this->run(
            "UPDATE orders SET status = 'licensed', updated_at = ? WHERE ref = ? AND status IN ({$open})",
            [$now, $ref, ...self::OPEN_ORDER_STATUSES],
        )->rowCount() > 0;
    }

    /** Delete one order. Returns whether it existed. */
    public function deleteOrder(int $id): bool
    {
        return $this->run('DELETE FROM orders WHERE id = ?', [$id])->rowCount() > 0;
    }

    /** Delete the orders last changed strictly before `$cutoff`. Returns how many went. */
    public function deleteOrdersBefore(int $cutoff): int
    {
        return $this->run('DELETE FROM orders WHERE updated_at < ?', [$cutoff])->rowCount();
    }

    /** Delete the orders with this reference (erasing a licence's personal details). Returns how many went. */
    public function deleteOrdersByRef(string $ref): int
    {
        return $this->run('DELETE FROM orders WHERE ref = ?', [$ref])->rowCount();
    }

    /**
     * Delete the order form's rate-limit buckets that have refilled by their
     * own burst and refill: those whose id matches `$like` (and not
     * `$notLike`), except `$exceptIds`. A full bucket changes no decision, so
     * this only forgets addresses sooner.
     *
     * @param list<string> $exceptIds
     */
    public function deleteRefilledOrderBuckets(string $like, ?string $notLike, array $exceptIds, int $burst, float $refillPerMs, int $now): int
    {
        $sql = "DELETE FROM rate_limits WHERE id LIKE ? ESCAPE '\\'";
        $parameters = [$like];
        if ($notLike !== null) {
            $sql .= " AND id NOT LIKE ? ESCAPE '\\'";
            $parameters[] = $notLike;
        }
        if ($exceptIds !== []) {
            $sql .= ' AND id NOT IN (' . implode(', ', array_fill(0, count($exceptIds), '?')) . ')';
            array_push($parameters, ...$exceptIds);
        }
        $sql .= ' AND tokens + (? - updated_at) * ? >= ?';
        array_push($parameters, $now, (string) $refillPerMs, $burst);

        return $this->run($sql, $parameters)->rowCount();
    }

    /** A new order reference: `RX-` and eight upper-case hex digits. */
    protected function newOrderRef(): string
    {
        return 'RX-' . strtoupper(bin2hex(random_bytes(4)));
    }

    // --- rate limiting and sign-in throttling ---------------------------------------

    /**
     * Spend one token from a persisted bucket, or say how long until one is
     * available. The arithmetic is the reference's `RateLimiter.take`; only
     * where the bucket lives differs.
     *
     * @return array{allowed: bool, retryAfterSeconds: int}
     */
    public function takeToken(string $id, int $burst, float $refillPerMs, int $now, int $maxClients): array
    {
        return $this->transaction(function () use ($id, $burst, $refillPerMs, $now, $maxClients): array {
            $row = $this->run('SELECT tokens, updated_at FROM rate_limits WHERE id = ?', [$id])->fetch();

            if ($row === false) {
                // Judging other buckets by the order form's slow refill would
                // forget partly drained ones, so order inserts evict by age only.
                $this->makeRoom($burst, $refillPerMs, $now, $maxClients, !str_starts_with($id, 'order|'));
                $tokens = (float) $burst;
                $updatedAt = $now;
            } else {
                $tokens = (float) $row['tokens'];
                $updatedAt = (int) $row['updated_at'];
            }

            $elapsed = max(0, $now - $updatedAt);
            $tokens = min((float) $burst, $tokens + $elapsed * $refillPerMs);

            $allowed = $tokens >= 1;
            if ($allowed) {
                $tokens -= 1;
            }

            if ($row === false) {
                $this->run('INSERT INTO rate_limits (id, tokens, updated_at) VALUES (?, ?, ?)', [$id, $tokens, $now]);
            } else {
                $this->run('UPDATE rate_limits SET tokens = ?, updated_at = ? WHERE id = ?', [$tokens, $now, $id]);
            }

            if ($allowed) {
                return ['allowed' => true, 'retryAfterSeconds' => 0];
            }

            $waitMs = (1 - $tokens) / $refillPerMs;

            return ['allowed' => false, 'retryAfterSeconds' => max(1, (int) ceil($waitMs / 1000))];
        });
    }

    /** Buckets currently stored. */
    public function rateLimitCount(): int
    {
        return (int) $this->pdo->query('SELECT COUNT(*) FROM rate_limits')->fetchColumn();
    }

    /**
     * Delete the buckets that have refilled completely. A full bucket is
     * indistinguishable from one never seen, so this changes no decision; it
     * only forgets addresses.
     */
    public function deleteRefilledBuckets(int $burst, float $refillPerMs, int $now): int
    {
        // The order form's buckets (`order|…`) refill far more slowly than the
        // activation limiter's: judged by these parameters they would look
        // refilled within a minute and be deleted, which would reset the
        // order caps. They are left to age out (`deleteBucketsBefore`) or to
        // least-recently-used eviction instead.
        return $this->run(
            "DELETE FROM rate_limits WHERE id NOT LIKE 'order|%' AND tokens + (? - updated_at) * ? >= ?",
            [$now, (string) $refillPerMs, $burst],
        )->rowCount();
    }

    /** Delete the buckets last charged strictly before `$cutoff`, full or not. */
    public function deleteBucketsBefore(int $cutoff): int
    {
        return $this->run('DELETE FROM rate_limits WHERE updated_at < ?', [$cutoff])->rowCount();
    }

    public function recordLoginFailure(string $client, int $now): void
    {
        $this->run('INSERT INTO login_attempts (client, at) VALUES (?, ?)', [$client, $now]);
        // Old rows are worthless; keep the table small.
        $this->deleteLoginFailuresBefore($now - self::LOGIN_FAILURES_KEPT_MS);
    }

    /** Delete the failed sign-ins recorded strictly before `$cutoff`. */
    public function deleteLoginFailuresBefore(int $cutoff): int
    {
        return $this->run('DELETE FROM login_attempts WHERE at < ?', [$cutoff])->rowCount();
    }

    public function countLoginFailures(?string $client, int $since): int
    {
        if ($client === null) {
            return (int) $this->run('SELECT COUNT(*) FROM login_attempts WHERE at > ?', [$since])->fetchColumn();
        }

        return (int) $this->run('SELECT COUNT(*) FROM login_attempts WHERE client = ? AND at > ?', [$client, $since])->fetchColumn();
    }

    /** The oldest failure in the window, to say when the client may try again. */
    public function oldestLoginFailure(?string $client, int $since): ?int
    {
        $statement = $client === null
            ? $this->run('SELECT MIN(at) FROM login_attempts WHERE at > ?', [$since])
            : $this->run('SELECT MIN(at) FROM login_attempts WHERE client = ? AND at > ?', [$client, $since]);
        $value = $statement->fetchColumn();

        return $value === null || $value === false ? null : (int) $value;
    }

    /** Forget one client's failed sign-ins, or everyone's (`null`), as re-running setup does. */
    public function clearLoginFailures(?string $client): void
    {
        if ($client === null) {
            $this->run('DELETE FROM login_attempts');

            return;
        }

        $this->run('DELETE FROM login_attempts WHERE client = ?', [$client]);
    }

    // --- periodic work ------------------------------------------------------------------

    /** When a periodic task last ran (epoch ms), or `null` if it never has. */
    public function lastRunOf(string $task): ?int
    {
        $value = $this->run('SELECT last_run_at FROM housekeeping WHERE task = ?', [$task])->fetchColumn();

        return $value === false || $value === null ? null : (int) $value;
    }

    public function recordRunOf(string $task, int $at): void
    {
        // INSERT OR REPLACE rather than an upsert, which needs SQLite 3.24.
        $this->run('INSERT OR REPLACE INTO housekeeping (task, last_run_at) VALUES (?, ?)', [$task, $at]);
    }

    /**
     * Copy the write-ahead log into the database and empty it.
     *
     * The log is reused from its start after each automatic checkpoint, not
     * shortened, so its tail can still hold old copies of pages — rows
     * deleted since included. Truncating it after a deletion pass leaves
     * those copies nowhere. Best effort: while another request is reading,
     * SQLite does what it can and the next pass finishes the job.
     */
    public function checkpoint(): void
    {
        $this->pdo->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetchAll();
    }

    // --- backups ------------------------------------------------------------------

    /**
     * Write a consistent copy of the database to `$target`.
     *
     * `VACUUM INTO` (SQLite 3.27+) makes a transactionally consistent,
     * compacted copy while the server keeps running. On an older SQLite the
     * copy is made table by table inside one read transaction, which is just as
     * consistent, from the schema SQLite itself recorded.
     */
    public function snapshot(string $target): void
    {
        if (file_exists($target)) {
            throw new \RuntimeException('The snapshot target already exists.');
        }

        if (version_compare($this->sqliteVersion(), '3.27.0', '>=')) {
            $this->run('VACUUM INTO ?', [$target]);

            return;
        }

        $copy = new PDO('sqlite:' . $target, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $this->pdo->exec('BEGIN');
        try {
            $objects = $this->pdo->query(
                "SELECT type, name, sql FROM sqlite_master
                  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
                  ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
            )->fetchAll();

            $copy->exec('BEGIN');
            foreach ($objects as $object) {
                $copy->exec($object['sql']);
            }

            foreach ($objects as $object) {
                if ($object['type'] !== 'table') {
                    continue;
                }

                $rows = $this->pdo->query('SELECT * FROM "' . str_replace('"', '""', $object['name']) . '"');
                $insert = null;
                foreach ($rows as $row) {
                    if ($insert === null) {
                        $columns = implode(', ', array_map(static fn (string $c): string => '"' . str_replace('"', '""', $c) . '"', array_keys($row)));
                        $marks = implode(', ', array_fill(0, count($row), '?'));
                        $insert = $copy->prepare('INSERT INTO "' . str_replace('"', '""', $object['name']) . "\" ({$columns}) VALUES ({$marks})");
                    }
                    $insert->execute(array_values($row));
                }
            }

            $copy->exec('PRAGMA user_version = ' . $this->userVersion());
            $copy->exec('COMMIT');
        } finally {
            $this->pdo->exec('COMMIT');
        }
    }

    // --- internals ----------------------------------------------------------------

    /** @param list<mixed> $parameters */
    private function run(string $sql, array $parameters = []): \PDOStatement
    {
        $statement = $this->pdo->prepare($sql);

        foreach (array_values($parameters) as $index => $value) {
            $type = match (true) {
                $value === null => PDO::PARAM_NULL,
                is_int($value) => PDO::PARAM_INT,
                is_bool($value) => PDO::PARAM_BOOL,
                default => PDO::PARAM_STR,
            };
            $statement->bindValue($index + 1, is_float($value) ? (string) $value : $value, $type);
        }

        $statement->execute();

        return $statement;
    }

    private function userVersion(): int
    {
        return (int) $this->pdo->query('PRAGMA user_version')->fetchColumn();
    }

    /** Make room for a new rate-limit bucket: drop refilled ones, then the least recently used. */
    private function makeRoom(int $burst, float $refillPerMs, int $now, int $maxClients, bool $dropRefilled = true): void
    {
        if ($this->rateLimitCount() < $maxClients) {
            return;
        }

        if ($dropRefilled) {
            $this->deleteRefilledBuckets($burst, $refillPerMs, $now);
        }

        $excess = $this->rateLimitCount() - $maxClients + 1;
        if ($excess > 0) {
            // The order form's overall cap is one bucket for everyone, so a
            // flood of new addresses must not evict it.
            $this->run(
                "DELETE FROM rate_limits WHERE id IN (SELECT id FROM rate_limits WHERE id NOT IN ('order|*', 'order|to|*') ORDER BY updated_at, id LIMIT ?)",
                [$excess],
            );
        }
    }

    /**
     * Apply every migration newer than the database, each in its own
     * transaction, then make sure this server's private tables exist.
     */
    private function migrate(): void
    {
        $current = $this->userVersion();

        if ($current > self::SCHEMA_VERSION) {
            throw new \RuntimeException(
                "The licence database is at schema version {$current}, but this server only understands up to "
                . self::SCHEMA_VERSION . '. Install the newer server release, or restore a backup taken before the upgrade.',
            );
        }

        foreach (self::migrations($this->supportsStrictTables()) as $version => $sql) {
            if ($version <= $current) {
                continue;
            }

            $this->transaction(function () use ($sql, $version): void {
                $this->pdo->exec($sql);
                $this->pdo->exec("PRAGMA user_version = {$version}");
            });
        }

        $this->pdo->exec(
            'CREATE TABLE IF NOT EXISTS rate_limits (
               id          TEXT PRIMARY KEY NOT NULL,
               tokens      REAL NOT NULL,
               updated_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS rate_limits_updated_at ON rate_limits (updated_at);
             CREATE TABLE IF NOT EXISTS login_attempts (
               id      INTEGER PRIMARY KEY,
               client  TEXT NOT NULL,
               at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS login_attempts_client_at ON login_attempts (client, at);
             CREATE TABLE IF NOT EXISTS housekeeping (
               task         TEXT PRIMARY KEY NOT NULL,
               last_run_at  INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS orders (
               id             INTEGER PRIMARY KEY,
               ref            TEXT NOT NULL UNIQUE,
               created_at     INTEGER NOT NULL,
               updated_at     INTEGER NOT NULL,
               status         TEXT NOT NULL DEFAULT \'new\',
               edition        TEXT NOT NULL,
               quantity       INTEGER NOT NULL,
               name           TEXT NOT NULL,
               email          TEXT NOT NULL,
               phone          TEXT NOT NULL,
               phone_country  TEXT NOT NULL,
               register_to    TEXT,
               gstin          TEXT,
               message        TEXT,
               ip             TEXT,
               notes          TEXT,
               mailed_at      INTEGER
             );
             CREATE INDEX IF NOT EXISTS orders_created_at ON orders (created_at);
             CREATE INDEX IF NOT EXISTS orders_updated_at ON orders (updated_at);',
        );
    }

    /** Whether an insert failed because the order reference it drew is taken. */
    private static function isRefCollision(PDOException $error): bool
    {
        $code = $error->errorInfo[1] ?? null;

        return ((is_int($code) && ($code & 0xff) === 19) || str_contains($error->getMessage(), 'constraint'))
            && str_contains($error->getMessage(), 'orders.ref');
    }

    /** STRICT tables arrived in SQLite 3.37; older hosts get the same schema without the keyword. */
    private function supportsStrictTables(): bool
    {
        return version_compare($this->sqliteVersion(), '3.37.0', '>=');
    }

    /**
     * Schema history — append only, identical to the reference server's.
     *
     * @return array<int, string>
     */
    private static function migrations(bool $strict): array
    {
        $s = $strict ? ' STRICT' : '';
        $sw = $strict ? ' STRICT, WITHOUT ROWID' : ' WITHOUT ROWID';

        return [
            1 => "
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
              ){$s};

              CREATE INDEX licenses_order_ref ON licenses (order_ref) WHERE order_ref IS NOT NULL;
              CREATE INDEX licenses_created_at ON licenses (created_at);

              CREATE TABLE activations (
                key                 TEXT NOT NULL REFERENCES licenses (key),
                machine_id          TEXT NOT NULL,
                first_activated_at  INTEGER NOT NULL,
                last_activated_at   INTEGER NOT NULL,
                released_at         INTEGER,
                PRIMARY KEY (key, machine_id)
              ){$sw};

              CREATE INDEX activations_live ON activations (key) WHERE released_at IS NULL;

              CREATE TABLE events (
                id          INTEGER PRIMARY KEY,
                at          INTEGER NOT NULL,
                type        TEXT NOT NULL,
                key         TEXT,
                machine_id  TEXT,
                ip          TEXT,
                detail      TEXT
              ){$s};

              CREATE INDEX events_key_at ON events (key, at);
            ",
        ];
    }

    private static function escapeLike(string $text): string
    {
        return preg_replace('/[\\\\%_]/', '\\\\$0', $text) ?? $text;
    }

    /** @param array<string, mixed> $row */
    private static function toLicense(array $row): array
    {
        return [
            'key' => (string) $row['key'],
            'edition' => (string) $row['edition'],
            'registeredTo' => self::text($row['registered_to']),
            'email' => self::text($row['email']),
            'maxActivations' => self::integer($row['max_activations']),
            'expiresAt' => self::integer($row['expires_at']),
            'createdAt' => (int) $row['created_at'],
            'revokedAt' => self::integer($row['revoked_at']),
            'revokeReason' => self::text($row['revoke_reason']),
            'orderRef' => self::text($row['order_ref']),
            'notes' => self::text($row['notes']),
        ];
    }

    /** @param array<string, mixed> $row */
    private static function toOrder(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'ref' => (string) $row['ref'],
            'createdAt' => (int) $row['created_at'],
            'updatedAt' => (int) $row['updated_at'],
            'status' => (string) $row['status'],
            'edition' => (string) $row['edition'],
            'quantity' => (int) $row['quantity'],
            'name' => (string) $row['name'],
            'email' => (string) $row['email'],
            'phone' => (string) $row['phone'],
            'phoneCountry' => (string) $row['phone_country'],
            'registerTo' => self::text($row['register_to']),
            'gstin' => self::text($row['gstin']),
            'message' => self::text($row['message']),
            'ip' => self::text($row['ip']),
            'notes' => self::text($row['notes']),
            'mailedAt' => self::integer($row['mailed_at']),
        ];
    }

    /** @param array<string, mixed> $row */
    private static function toActivation(array $row): array
    {
        return [
            'key' => (string) $row['key'],
            'machineId' => (string) $row['machine_id'],
            'firstActivatedAt' => (int) $row['first_activated_at'],
            'lastActivatedAt' => (int) $row['last_activated_at'],
            'releasedAt' => self::integer($row['released_at']),
        ];
    }

    /** @param array<string, mixed> $row */
    private static function toEvent(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'at' => (int) $row['at'],
            'type' => (string) $row['type'],
            'key' => self::text($row['key']),
            'machineId' => self::text($row['machine_id']),
            'ip' => self::text($row['ip']),
            'detail' => self::text($row['detail']),
        ];
    }

    private static function text(mixed $value): ?string
    {
        return $value === null ? null : (string) $value;
    }

    private static function integer(mixed $value): ?int
    {
        return $value === null ? null : (int) $value;
    }
}

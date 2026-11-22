<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

use RecoverX\Licensing\Order\OrderLimits;

/**
 * How long the activation history is kept.
 *
 * The `events` table records every activation, release and refusal with the
 * address it came from. The privacy policy promises that log is kept for 13
 * months and then deleted, so events older than `event_retention_days` (395
 * by default) are removed — the same rule as the Node server's
 * LICENSE_EVENT_RETENTION_DAYS and its `prune-events` command.
 *
 * Shared hosting gives a PHP application no scheduler it can rely on, so the
 * pass rides on ordinary requests instead: whichever request comes first once
 * a day has passed since the last pass (`App::housekeeping`), plus a button
 * in the admin panel. The time of the last pass is kept in the database,
 * because PHP remembers nothing between requests.
 *
 * The monthly request logs in `data/logs/` hold the same addresses, so a log
 * file is deleted too once every line in it is past the retention. So are the
 * rows of the two tables named after addresses: rate-limit buckets once they
 * have refilled (a full bucket changes no decision), and in any case once they
 * are past the retention; failed admin sign-ins once they are a day old
 * (`Store::LOGIN_FAILURES_KEPT_MS`). The privacy policy lists the rate-limit
 * counters with the event log. The Node server keeps both in memory only.
 *
 * Orders from the website form (`orders`, this server's alone) are deleted by
 * the same pass once nothing has changed on them for 24 months
 * (`ORDER_DAYS`), long enough to answer a customer about last year's
 * purchase. The licences an order led to keep their own records.
 *
 * Deleted means gone from the file: the store overwrites deleted rows
 * (`secure_delete`), and the write-ahead log is emptied after each pass, so
 * no address is left in free pages for a file-carving tool to find.
 *
 * The self-service release allowance is counted from the same `events`
 * table, so the retention may never be shorter than the allowance's window:
 * a deleted `deactivated` event is a move the allowance has forgotten. Config
 * refuses such a setting, and so does the constructor here.
 */
final class EventRetention
{
    /** About 13 months: 365 + 30. */
    public const DEFAULT_DAYS = 395;

    /** Orders are deleted this many days after they last changed: 24 months. */
    public const ORDER_DAYS = 730;

    /** Automatic passes are at least this far apart. */
    public const INTERVAL_MS = Expiry::DAY_MS;

    /** The name of the pass in the `housekeeping` table. */
    public const TASK = 'prune-events';

    /** @var callable(): int */
    private $clock;

    /** @param null|callable(): int $clock epoch milliseconds; defaults to the real time */
    public function __construct(
        private readonly Store $store,
        public readonly int $days,
        int $selfReleaseWindowDays,
        ?callable $clock = null,
        private readonly ?string $logDirectory = null,
        private readonly ?RateLimiter $rateLimiter = null,
    ) {
        if ($days < 1) {
            throw new \RangeException("The event retention must be a whole number of days, at least 1, not {$days}");
        }
        if ($days < $selfReleaseWindowDays) {
            throw new \RangeException(
                "The event retention ({$days} days) must be at least the self-service release window "
                . "({$selfReleaseWindowDays} days), because moves are counted from the event log",
            );
        }

        $this->clock = $clock ?? Authority::systemClock(...);
    }

    /** Events recorded strictly before this instant are past the retention. */
    public function cutoff(): int
    {
        return Expiry::addDays(($this->clock)(), -$this->days);
    }

    /** How many events a pass would delete now. */
    public function pending(): int
    {
        return $this->store->countEventsBefore($this->cutoff());
    }

    /** When the last pass ran, automatic or not (epoch ms), or `null`. */
    public function lastRun(): ?int
    {
        return $this->store->lastRunOf(self::TASK);
    }

    /**
     * Delete everything past the retention now. Deleting what is already gone
     * deletes nothing, so a second pass is harmless.
     *
     * @return array{deleted: int, cutoff: int, rateLimits: int, loginAttempts: int, logFiles: int, orders: int}
     */
    public function prune(): array
    {
        $result = $this->store->transaction(fn (): array => $this->pass(($this->clock)()));

        return $this->afterPass($result);
    }

    /**
     * Delete everything past the retention if a day has passed since the last
     * pass; `null` when it is not yet due.
     *
     * The common answer — not due — is read without taking the write lock,
     * so ordinary requests do not queue behind one another for it; the check
     * is repeated under the lock, so two requests arriving together run one
     * pass between them. A last pass dated in the future (the clock was set
     * back) counts as due rather than postponing every pass until then.
     *
     * @return null|array{deleted: int, cutoff: int, rateLimits: int, loginAttempts: int, logFiles: int, orders: int}
     */
    public function pruneIfDue(): ?array
    {
        if (!$this->isDue()) {
            return null;
        }

        $result = $this->store->transaction(function (): ?array {
            $now = ($this->clock)();

            return self::dueAt($now, $this->lastRun()) ? $this->pass($now) : null;
        });

        return $result === null ? null : $this->afterPass($result);
    }

    /**
     * A pass's result as log fields, named as the Node server logs its own
     * passes (`Pruned the event log`), plus what only this server keeps: the
     * log files, the rate-limit buckets, the failed sign-ins and the orders.
     *
     * @param array{deleted: int, cutoff: int, rateLimits: int, loginAttempts: int, logFiles: int, orders: int} $result
     * @return array{deleted: int, retentionDays: int, cutoff: string, logFiles: int, rateLimits: int, loginAttempts: int, orders: int}
     */
    public function logFields(array $result): array
    {
        $cutoff = $result['cutoff'];

        return [
            'deleted' => $result['deleted'],
            'retentionDays' => $this->days,
            // As JavaScript's toISOString().
            'cutoff' => gmdate('Y-m-d\TH:i:s', intdiv($cutoff, 1000)) . sprintf('.%03dZ', $cutoff % 1000),
            'logFiles' => $result['logFiles'],
            'rateLimits' => $result['rateLimits'],
            'loginAttempts' => $result['loginAttempts'],
            'orders' => $result['orders'],
        ];
    }

    /** Whether an automatic pass is due: never run, or a day or more ago. */
    public function isDue(): bool
    {
        return self::dueAt(($this->clock)(), $this->lastRun());
    }

    private static function dueAt(int $now, ?int $lastRun): bool
    {
        return $lastRun === null || $lastRun > $now || $now - $lastRun >= self::INTERVAL_MS;
    }

    /**
     * The database half of a pass, inside the caller's transaction. The log
     * files are tidied after it commits, so the write lock is not held for
     * file-system work.
     *
     * Telling a refilled bucket needs the limiter's burst and refill, so
     * without a limiter only the retention applies to buckets; with one, the
     * retention is the backstop for limits so slow that a bucket would take
     * longer to refill.
     *
     * @return array{deleted: int, cutoff: int, rateLimits: int, loginAttempts: int, orders: int}
     */
    private function pass(int $now): array
    {
        $cutoff = Expiry::addDays($now, -$this->days);
        $deleted = $this->store->deleteEventsBefore($cutoff);
        $rateLimits = $this->store->deleteBucketsBefore($cutoff) + ($this->rateLimiter?->forgetRefilled($now) ?? 0)
            + OrderLimits::forgetRefilled($this->store, $now);
        // A day is shorter than any retention, so this is the stricter rule.
        $loginAttempts = $this->store->deleteLoginFailuresBefore($now - Store::LOGIN_FAILURES_KEPT_MS);
        // Orders have their own period, whatever the event retention.
        $orders = $this->store->deleteOrdersBefore(Expiry::addDays($now, -self::ORDER_DAYS));
        $this->store->recordRunOf(self::TASK, $now);

        return ['deleted' => $deleted, 'cutoff' => $cutoff, 'rateLimits' => $rateLimits, 'loginAttempts' => $loginAttempts, 'orders' => $orders];
    }

    /**
     * What follows a committed pass: empty the write-ahead log, which can
     * still hold old copies of the pages just cleared, then tidy the log
     * files. Neither can undo the pass, and neither fails it.
     *
     * @param array{deleted: int, cutoff: int, rateLimits: int, loginAttempts: int, orders: int} $result
     * @return array{deleted: int, cutoff: int, rateLimits: int, loginAttempts: int, logFiles: int, orders: int}
     */
    private function afterPass(array $result): array
    {
        try {
            $this->store->checkpoint();
        } catch (\PDOException) {
            // Another request held the log; the next pass empties it.
        }

        return [
            'deleted' => $result['deleted'],
            'cutoff' => $result['cutoff'],
            'rateLimits' => $result['rateLimits'],
            'loginAttempts' => $result['loginAttempts'],
            'logFiles' => $this->pruneLogFiles($result['cutoff']),
            'orders' => $result['orders'],
        ];
    }

    /**
     * Delete the monthly request logs (`licensing-YYYY-MM.log`) whose whole
     * month lies before the cutoff. A file that cannot be deleted is left for
     * the next pass rather than failing this one.
     */
    private function pruneLogFiles(int $cutoff): int
    {
        if ($this->logDirectory === null || !is_dir($this->logDirectory)) {
            return 0;
        }

        $deleted = 0;
        foreach (scandir($this->logDirectory) ?: [] as $name) {
            if (preg_match('/^licensing-(\d{4})-(\d{2})\.log$/D', $name, $match) !== 1) {
                continue;
            }

            $month = (int) $match[2];
            if ($month < 1 || $month > 12) {
                continue;
            }

            // The first instant of the following month, in UTC as the file
            // names are: every line in the file was written before it.
            $ends = gmmktime(0, 0, 0, $month + 1, 1, (int) $match[1]);
            if ($ends !== false && $ends * 1000 <= $cutoff && @unlink($this->logDirectory . '/' . $name)) {
                $deleted += 1;
            }
        }

        return $deleted;
    }
}

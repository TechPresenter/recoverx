<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\Authority;
use RecoverX\Licensing\Config;
use RecoverX\Licensing\ConfigError;
use RecoverX\Licensing\EventRetention;
use RecoverX\Licensing\RateLimiter;
use RecoverX\Licensing\Store;

/*
 * Event retention: the activation history (with customers' addresses) is
 * deleted once it is older than the privacy policy's 13 months — daily on the
 * back of ordinary requests, or from the admin panel — and never so early
 * that the self-service release allowance forgets a move it must count.
 */

/** Record an event of `$type` at `$at`, as the authority would. */
function eventAt(Store $store, int $at, string $type = 'activated', ?string $key = null): void
{
    $store->recordEvent(['at' => $at, 'type' => $type, 'key' => $key, 'machineId' => Kit::MACHINE_A, 'ip' => '203.0.113.7', 'detail' => null]);
}

/** @return list<int> the instants of every event left, oldest first */
function eventTimes(Store $store): array
{
    return array_map('intval', $store->pdo->query('SELECT at FROM events ORDER BY at, id')->fetchAll(\PDO::FETCH_COLUMN));
}

/** A rate-limit bucket as the limiter leaves it. */
function bucketAt(Store $store, string $id, float $tokens, int $updatedAt): void
{
    $store->pdo->prepare('INSERT INTO rate_limits (id, tokens, updated_at) VALUES (?, ?, ?)')->execute([$id, $tokens, $updatedAt]);
}

/** @return list<string> the buckets left, by id */
function bucketIds(Store $store): array
{
    return array_map('strval', $store->pdo->query('SELECT id FROM rate_limits ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN));
}

/** A failed admin sign-in, written directly so the trimming in recordLoginFailure stays out of the way. */
function signInFailureAt(Store $store, string $client, int $at): void
{
    $store->pdo->prepare('INSERT INTO login_attempts (client, at) VALUES (?, ?)')->execute([$client, $at]);
}

/** @return list<int> the instants of the failed sign-ins left, oldest first */
function signInFailureTimes(Store $store): array
{
    return array_map('intval', $store->pdo->query('SELECT at FROM login_attempts ORDER BY at, id')->fetchAll(\PDO::FETCH_COLUMN));
}

test('keeps 395 days — 13 months — by default, and refuses less than the release window', function (): void {
    Assert::same(395, Config::DEFAULTS['event_retention_days']);
    Assert::same(395, EventRetention::DEFAULT_DAYS);
    Assert::same(395, Config::validate([])['event_retention_days']);

    // Equal to the window is the shortest that still counts every move.
    Assert::same(365, Config::validate(['event_retention_days' => 365])['event_retention_days']);
    Assert::same(30, Config::validate(['event_retention_days' => 30, 'self_release_window_days' => 30])['event_retention_days']);
    Assert::throws(ConfigError::class, static fn () => Config::validate(['event_retention_days' => 364]),
        '/event_retention_days \(364\) must be at least self_release_window_days \(365\)/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['self_release_window_days' => 400]),
        '/event_retention_days \(395\) must be at least self_release_window_days \(400\)/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['event_retention_days' => 0]), '/event_retention_days must be a whole number/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['event_retention_days' => '395']), '/event_retention_days must be a whole number/');

    $f = Kit::fixture();
    Assert::throws(\RangeException::class, static fn () => new EventRetention($f['store'], 100, 365, $f['clock']), '/at least the self-service release window/');
    Assert::throws(\RangeException::class, static fn () => new EventRetention($f['store'], 0, 0, $f['clock']));
});

test('deletes events strictly older than the cutoff and keeps the rest', function (): void {
    $f = Kit::fixture();
    $retention = new EventRetention($f['store'], 395, 365, $f['clock']);
    $cutoff = Kit::NOW - 395 * Kit::DAY;
    Assert::same($cutoff, $retention->cutoff());

    foreach ([$cutoff - Kit::DAY, $cutoff - 1, $cutoff, $cutoff + 1, Kit::NOW] as $at) {
        eventAt($f['store'], $at);
    }

    Assert::same(2, $retention->pending());
    $result = $retention->prune();
    Assert::same(['deleted' => 2, 'cutoff' => $cutoff, 'rateLimits' => 0, 'loginAttempts' => 0, 'logFiles' => 0], $result);
    Assert::same([$cutoff, $cutoff + 1, Kit::NOW], eventTimes($f['store']));
    Assert::same(0, $retention->pending());
    Assert::same(Kit::NOW, $retention->lastRun());
});

test('is idempotent: a second pass deletes nothing more', function (): void {
    $f = Kit::fixture();
    $retention = new EventRetention($f['store'], 395, 365, $f['clock']);
    eventAt($f['store'], Kit::NOW - 400 * Kit::DAY);
    eventAt($f['store'], Kit::NOW - Kit::DAY);

    Assert::same(1, $retention->prune()['deleted']);
    Assert::same(0, $retention->prune()['deleted']);
    Assert::same([Kit::NOW - Kit::DAY], eventTimes($f['store']));
});

test('deletes rate-limit buckets — named after addresses — once they are past the retention, whatever the limits', function (): void {
    $f = Kit::fixture();
    $retention = new EventRetention($f['store'], 395, 365, $f['clock']);
    $cutoff = Kit::NOW - 395 * Kit::DAY;

    // Without a limiter to say which buckets have refilled, the retention
    // alone applies, at the same boundary as the events'.
    bucketAt($f['store'], 'public|203.0.113.1', 0.0, $cutoff - 1);
    bucketAt($f['store'], 'public|203.0.113.2', 0.0, $cutoff);
    bucketAt($f['store'], 'admin-auth|2001:db8:1:2::/64', 0.0, Kit::NOW - Kit::DAY);

    Assert::same(1, $retention->prune()['rateLimits']);
    Assert::same(['admin-auth|2001:db8:1:2::/64', 'public|203.0.113.2'], bucketIds($f['store']));
    Assert::same(0, $retention->prune()['rateLimits']);
});

test('deletes every bucket that has refilled, which changes no decision', function (): void {
    $f = Kit::fixture();
    // Two at once, then one a second.
    $limiter = new RateLimiter($f['store'], 2, 60, $f['clock']);
    $retention = new EventRetention($f['store'], 395, 365, $f['clock'], null, $limiter);

    // Emptied five seconds ago: full again by now.
    $f['clock']->current = Kit::NOW - 5000;
    $limiter->take('203.0.113.7');
    $limiter->take('203.0.113.7');
    // Emptied a second ago: one token back.
    $f['clock']->current = Kit::NOW - 1000;
    $limiter->take('198.51.100.4');
    $limiter->take('198.51.100.4');
    // Charged just now.
    $f['clock']->current = Kit::NOW;
    $limiter->take('2001:db8::1', 'admin-auth');

    Assert::same(['admin-auth|2001:db8:0:0::/64', 'public|198.51.100.4', 'public|203.0.113.7'], bucketIds($f['store']));
    Assert::same(1, $retention->prune()['rateLimits']);
    Assert::same(['admin-auth|2001:db8:0:0::/64', 'public|198.51.100.4'], bucketIds($f['store']));
    Assert::same(0, $retention->prune()['rateLimits']);

    // The forgotten address starts from a full burst — as it would have.
    Assert::same([true, true, false], array_map(static fn (): bool => $limiter->take('203.0.113.7')['allowed'], [1, 2, 3]));
    // The one still refilling keeps its debt.
    Assert::same([true, false], array_map(static fn (): bool => $limiter->take('198.51.100.4')['allowed'], [1, 2]));
});

test('deletes failed admin sign-ins once they are a day old', function (): void {
    $f = Kit::fixture();
    $retention = new EventRetention($f['store'], 395, 365, $f['clock']);
    foreach ([Kit::NOW - 30 * Kit::DAY, Kit::NOW - Kit::DAY - 1, Kit::NOW - Kit::DAY, Kit::NOW - 60_000] as $at) {
        signInFailureAt($f['store'], '203.0.113.7', $at);
    }

    Assert::same(2, $retention->prune()['loginAttempts']);
    Assert::same([Kit::NOW - Kit::DAY, Kit::NOW - 60_000], signInFailureTimes($f['store']));
    Assert::same(0, $retention->prune()['loginAttempts']);
});

test('leaves no copy of what it deleted in the database file or its log', function (): void {
    $f = Kit::fixture();
    $store = $f['store'];
    $retention = new EventRetention($store, 395, 365, $f['clock']);
    Assert::same(1, (int) $store->pdo->query('PRAGMA secure_delete')->fetchColumn());

    $old = Kit::NOW - 400 * Kit::DAY;
    $store->recordEvent(['at' => $old, 'type' => 'activated', 'key' => null, 'machineId' => Kit::MACHINE_A, 'ip' => '192.0.2.201', 'detail' => null]);
    bucketAt($store, 'public|192.0.2.202', 0.0, $old);
    signInFailureAt($store, '192.0.2.203', $old);
    eventAt($store, Kit::NOW);

    // Written long ago: in the database file itself, not only in the log.
    $store->checkpoint();
    $bytes = static fn (): string => (string) file_get_contents($f['file']) . (string) @file_get_contents($f['file'] . '-wal');
    foreach (['192.0.2.201', '192.0.2.202', '192.0.2.203', '203.0.113.7'] as $address) {
        Assert::true(str_contains($bytes(), $address), "{$address} is in the file before the pass");
    }

    $retention->prune();

    foreach (['192.0.2.201', '192.0.2.202', '192.0.2.203'] as $address) {
        Assert::same(false, str_contains($bytes(), $address), "{$address} is still in the file after the pass");
    }
    Assert::true(str_contains($bytes(), '203.0.113.7'), 'the recent event is kept');
    Assert::same(0, (int) @filesize($f['file'] . '-wal'), 'the write-ahead log is emptied');
});

test('runs by itself at most once a day, and again once a day has passed', function (): void {
    $f = Kit::fixture();
    $retention = new EventRetention($f['store'], 395, 365, $f['clock']);
    eventAt($f['store'], Kit::NOW - 396 * Kit::DAY);

    Assert::true($retention->isDue(), 'a pass that never ran is due');
    Assert::same(1, $retention->pruneIfDue()['deleted'] ?? null);

    // Within the day nothing runs, even though there is now work to do.
    eventAt($f['store'], Kit::NOW - 500 * Kit::DAY);
    $f['clock']->advance(Kit::DAY - 1);
    Assert::same(false, $retention->isDue());
    Assert::same(null, $retention->pruneIfDue());
    Assert::same(1, $retention->pending());

    $f['clock']->advance(1);
    Assert::same(
        ['deleted' => 1, 'cutoff' => Kit::NOW + Kit::DAY - 395 * Kit::DAY, 'rateLimits' => 0, 'loginAttempts' => 0, 'logFiles' => 0],
        $retention->pruneIfDue(),
    );
    Assert::same(null, $retention->pruneIfDue());
});

test('treats a last pass dated in the future as due, so a clock set back cannot postpone it', function (): void {
    $f = Kit::fixture();
    $f['store']->recordRunOf(EventRetention::TASK, Kit::NOW + 30 * Kit::DAY);
    $retention = new EventRetention($f['store'], 395, 365, $f['clock']);

    Assert::true($retention->isDue());
    Assert::true($retention->pruneIfDue() !== null);
    Assert::same(Kit::NOW, $retention->lastRun());
});

test('never shortens the release window, even when the retention equals it', function (): void {
    $f = Kit::fixture(['limit' => 1, 'windowDays' => 30]);
    $retention = new EventRetention($f['store'], 30, 30, $f['clock']);
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);

    $token = $f['authority']->activate($key, Kit::MACHINE_A, Authority::PRODUCT_ID, Kit::CUSTOMER)['token'];
    Assert::same(true, $f['authority']->deactivate($token, Kit::CUSTOMER)['released']);
    $held = $f['authority']->activate($key, Kit::MACHINE_A, Authority::PRODUCT_ID, Kit::CUSTOMER)['token'];

    // One millisecond before the move leaves the window, a pass keeps it, and
    // the allowance still refuses the next move.
    $f['clock']->advance(30 * Kit::DAY - 1);
    $retention->prune();
    Assert::same(1, $f['authority']->show($key)['selfReleases']['recent']);
    Assert::refuses('self-release-limit', static fn () => $f['authority']->deactivate($held, Kit::CUSTOMER));

    // Once it has left the window it no longer counts, kept or not.
    $f['clock']->advance(1);
    Assert::same(0, $f['authority']->show($key)['selfReleases']['recent']);
    Assert::same(true, $f['authority']->deactivate($held, Kit::CUSTOMER)['released']);
});

test('deletes the monthly request logs once every line in them is past the retention', function (): void {
    $f = Kit::fixture();
    $logs = Kit::tempDir('rx-logs-');
    foreach (['licensing-2025-09.log', 'licensing-2025-10.log', 'licensing-2025-11.log', 'licensing-2026-11.log', 'notes.log', 'licensing-2025-13.log'] as $name) {
        file_put_contents("{$logs}/{$name}", "{}\n");
    }

    // 395 days before 12 November 2026 12:00 UTC is 13 October 2025 12:00:
    // September 2025 has ended by then, October has not.
    $retention = new EventRetention($f['store'], 395, 365, $f['clock'], $logs);
    Assert::same(1, $retention->prune()['logFiles']);

    $left = array_values(array_diff(scandir($logs) ?: [], ['.', '..']));
    sort($left);
    Assert::same(['licensing-2025-10.log', 'licensing-2025-11.log', 'licensing-2025-13.log', 'licensing-2026-11.log', 'notes.log'], $left);
});

test('a request does the daily pass after answering, and never fails because of it', function (): void {
    ['app' => $app, 'paths' => $paths, 'clock' => $clock] = Kit::installation();
    $store = $app->store();
    eventAt($store, Kit::NOW - 400 * Kit::DAY);
    eventAt($store, Kit::NOW - 10 * Kit::DAY);
    // Refilled long since under the default limits (20 at once, 30 a minute),
    // and a failed sign-in from the day before yesterday.
    bucketAt($store, 'public|198.51.100.23', 0.0, Kit::NOW - 10 * 60_000);
    signInFailureAt($store, '198.51.100.23', Kit::NOW - 2 * Kit::DAY);

    $app->housekeeping();
    Assert::same([Kit::NOW - 10 * Kit::DAY], eventTimes($store));
    Assert::same([], bucketIds($store));
    Assert::same([], signInFailureTimes($store));
    Assert::matches(
        '/"msg":"Pruned the event log","via":"daily","deleted":1,"retentionDays":395,"cutoff":"2025-10-13T12:00:00.000Z","logFiles":0,"rateLimits":1,"loginAttempts":1/',
        (string) file_get_contents($app->logger()->currentFile() ?? ''),
    );

    // Not due again today.
    eventAt($store, Kit::NOW - 500 * Kit::DAY);
    $app->housekeeping();
    Assert::same(2, count(eventTimes($store)));

    // A database that cannot be written is logged, not thrown.
    $clock->advance(Kit::DAY);
    $store->pdo->exec('CREATE TRIGGER no_deletes BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, \'read only\'); END');
    $app->housekeeping();
    Assert::same(2, count(eventTimes($store)));
    Assert::matches(
        '/"level":"error","msg":"Pruning the event log failed; a later request will try again".*read only/',
        (string) file_get_contents($app->logger()->currentFile() ?? ''),
    );

    // Nothing was recorded as done, so the next request tries again.
    $store->pdo->exec('DROP TRIGGER no_deletes');
    $app->housekeeping();
    Assert::same([Kit::NOW - 10 * Kit::DAY], eventTimes($store));

    // A server that is not set up has nothing to tidy, and says nothing.
    unlink($paths->lockFile());
    $before = (string) file_get_contents($app->logger()->currentFile() ?? '');
    $clock->advance(Kit::DAY);
    $app->housekeeping();
    Assert::same($before, (string) file_get_contents($app->logger()->currentFile() ?? ''));
});

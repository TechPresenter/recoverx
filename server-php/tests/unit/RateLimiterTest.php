<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\RateLimiter;
use RecoverX\Licensing\Store;

/* The persisted token bucket, case for case with the reference's in-memory one. */

function limiter(int $burst, int $perMinute, FakeClock $clock, int $maxClients = 50_000): array
{
    $store = Store::open(Kit::tempDir() . '/limits.db');

    return [new RateLimiter($store, $burst, $perMinute, $clock, $maxClients), $store];
}

test('allows a burst, then refills at the sustained rate', function (): void {
    $clock = new FakeClock(0);
    [$limiter] = limiter(3, 60, $clock);

    Assert::same([true, true, true], array_map(static fn () => $limiter->take('192.0.2.1')['allowed'], [1, 2, 3]));
    Assert::same(['allowed' => false, 'retryAfterSeconds' => 1], $limiter->take('192.0.2.1'));
    Assert::same(true, $limiter->take('192.0.2.2')['allowed'], 'other clients are unaffected');

    $clock->advance(1000);
    Assert::same(true, $limiter->take('192.0.2.1')['allowed']);
    Assert::same(false, $limiter->take('192.0.2.1')['allowed']);
});

test('says how long to wait, as the reference does', function (): void {
    $clock = new FakeClock(0);
    [$limiter] = limiter(2, 6, $clock);

    $limiter->take('192.0.2.1');
    $limiter->take('192.0.2.1');
    Assert::same(['allowed' => false, 'retryAfterSeconds' => 10], $limiter->take('192.0.2.1'));

    $clock->advance(10_000);
    Assert::same(true, $limiter->take('192.0.2.1')['allowed']);
});

test('keeps scopes apart', function (): void {
    [$limiter] = limiter(1, 1, new FakeClock(0));

    Assert::same(true, $limiter->take('192.0.2.1')['allowed']);
    Assert::same(true, $limiter->take('192.0.2.1', 'admin-auth')['allowed']);
    Assert::same(false, $limiter->take('192.0.2.1')['allowed']);
});

test('remembers buckets across requests, because they live in the database', function (): void {
    $clock = new FakeClock(0);
    [$first, $store] = limiter(1, 1, $clock);
    $second = new RateLimiter(Store::open($store->file), 1, 1, $clock);

    Assert::same(true, $first->take('192.0.2.1')['allowed']);
    Assert::same(false, $second->take('192.0.2.1')['allowed']);
});

test('groups an IPv6 client by its /64 and unwraps IPv4-mapped addresses', function (): void {
    Assert::same('2001:db8:aa:bb::/64', RateLimiter::clientBucketId('2001:db8:aa:bb:1:2:3:4'));
    Assert::same('2001:db8:aa:bb::/64', RateLimiter::clientBucketId('2001:db8:aa:bb::9'));
    Assert::same('2001:db8:aa:0::/64', RateLimiter::clientBucketId('2001:0db8:00aa::'));
    Assert::same('0:0:0:0::/64', RateLimiter::clientBucketId('::1'));
    Assert::same('192.0.2.7', RateLimiter::clientBucketId('::ffff:192.0.2.7'));
    Assert::same('192.0.2.7', RateLimiter::clientBucketId('192.0.2.7'));
    Assert::same('unknown', RateLimiter::clientBucketId('unknown'));
    Assert::same('fe80:0:0:0::/64', RateLimiter::clientBucketId('fe80::1%eth0'));
});

test('bounds the table without ever forgetting the client it is charging', function (): void {
    $clock = new FakeClock(0);
    [$limiter, $store] = limiter(2, 1, $clock, 2);

    $limiter->take('192.0.2.1');
    $limiter->take('192.0.2.2');

    Assert::same(true, $limiter->take('192.0.2.3')['allowed']);
    Assert::same(2, $store->rateLimitCount());
    Assert::same(true, $limiter->take('192.0.2.3')['allowed']);
    Assert::same(false, $limiter->take('192.0.2.3')['allowed']);

    // Buckets that have refilled are indistinguishable from new ones, and go first.
    $clock->advance(10 * 60_000);
    $limiter->take('192.0.2.4');
    Assert::same(1, $store->rateLimitCount());
});

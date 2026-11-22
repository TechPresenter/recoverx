<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Order;

use RecoverX\Licensing\RateLimiter;
use RecoverX\Licensing\Store;

/**
 * The order form's abuse limits, as token buckets in `rate_limits`:
 *
 * - `order|<address>` — requests from one address: a burst, then a few an hour;
 * - `order|*` — requests from everywhere together: a burst, then a cap a day;
 * - `order|to|<hash>` — confirmations to one customer address (normalised,
 *   hashed), one a day;
 * - `order|to|*` — confirmations to anyone, a small cap a day, so anonymous
 *   input can drive only a little of the SES volume.
 *
 * The daily retention pass forgets each kind once it has refilled by its own
 * parameters (`forgetRefilled`); the activation limiter's pruning leaves them
 * alone (`Store::deleteRefilledBuckets`).
 */
final class OrderLimits
{
    public const PER_ADDRESS_BURST = 5;
    public const PER_ADDRESS_PER_HOUR = 5;

    public const OVERALL_BURST = 100;
    public const OVERALL_PER_DAY = 200;

    public const CONFIRMATIONS_PER_RECIPIENT_PER_DAY = 1;

    public const CONFIRMATIONS_OVERALL_BURST = 10;
    public const CONFIRMATIONS_OVERALL_PER_DAY = 20;

    public const ALL = 'order|*';
    public const ALL_CONFIRMATIONS = 'order|to|*';

    private const HOUR_MS = 3_600_000;
    private const DAY_MS = 86_400_000;

    /** The rate limiter's table bound, shared with the activation limiter. */
    private const MAX_BUCKETS = 10_000;

    /** @return array{allowed: bool, retryAfterSeconds: int} */
    public static function takeRequest(Store $store, string $ip, int $now): array
    {
        $mine = $store->takeToken('order|' . RateLimiter::clientBucketId($ip), self::PER_ADDRESS_BURST, self::PER_ADDRESS_PER_HOUR / self::HOUR_MS, $now, self::MAX_BUCKETS);

        return $mine['allowed']
            ? $store->takeToken(self::ALL, self::OVERALL_BURST, self::OVERALL_PER_DAY / self::DAY_MS, $now, self::MAX_BUCKETS)
            : $mine;
    }

    /** Whether a confirmation may go to this address now; takes a token from both of its buckets when it may. */
    public static function takeConfirmation(Store $store, string $email, int $now): bool
    {
        $recipient = 'order|to|' . substr(hash('sha256', self::normaliseAddress($email)), 0, 32);
        if (!$store->takeToken($recipient, self::CONFIRMATIONS_PER_RECIPIENT_PER_DAY, self::CONFIRMATIONS_PER_RECIPIENT_PER_DAY / self::DAY_MS, $now, self::MAX_BUCKETS)['allowed']) {
            return false;
        }

        return $store->takeToken(self::ALL_CONFIRMATIONS, self::CONFIRMATIONS_OVERALL_BURST, self::CONFIRMATIONS_OVERALL_PER_DAY / self::DAY_MS, $now, self::MAX_BUCKETS)['allowed'];
    }

    /**
     * One mailbox, however it is spelt: lower-case, without a `+tag`, and for
     * Gmail without the dots it ignores.
     */
    public static function normaliseAddress(string $email): string
    {
        $email = strtolower(trim($email));
        $at = strrpos($email, '@');
        if ($at === false) {
            return $email;
        }

        $local = substr($email, 0, $at);
        $domain = substr($email, $at + 1);
        $plus = strpos($local, '+');
        if ($plus !== false) {
            $local = substr($local, 0, $plus);
        }
        if ($domain === 'googlemail.com') {
            $domain = 'gmail.com';
        }
        if ($domain === 'gmail.com') {
            $local = str_replace('.', '', $local);
        }

        return $local . '@' . $domain;
    }

    /** Delete the order buckets that have refilled by their own parameters. Returns how many went. */
    public static function forgetRefilled(Store $store, int $now): int
    {
        return $store->deleteRefilledOrderBuckets('order|%', 'order|to|%', [self::ALL], self::PER_ADDRESS_BURST, self::PER_ADDRESS_PER_HOUR / self::HOUR_MS, $now)
            + $store->deleteRefilledOrderBuckets('order|to|%', null, [self::ALL_CONFIRMATIONS], self::CONFIRMATIONS_PER_RECIPIENT_PER_DAY, self::CONFIRMATIONS_PER_RECIPIENT_PER_DAY / self::DAY_MS, $now)
            + $store->deleteRefilledOrderBuckets(self::ALL, null, [], self::OVERALL_BURST, self::OVERALL_PER_DAY / self::DAY_MS, $now)
            + $store->deleteRefilledOrderBuckets(self::ALL_CONFIRMATIONS, null, [], self::CONFIRMATIONS_OVERALL_BURST, self::CONFIRMATIONS_OVERALL_PER_DAY / self::DAY_MS, $now);
    }
}

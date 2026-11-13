<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * Per-client token-bucket rate limiting, persisted in SQLite.
 *
 * The same buckets as the reference server's src/server/rate-limit.ts — a
 * burst that absorbs an office activating three computers at once, then a
 * sustained refill — with one difference forced by PHP: every request is a
 * fresh process, so the buckets cannot live in memory. They live in the
 * `rate_limits` table and are charged inside a write transaction.
 *
 * The threat is enumeration (walking the key space), not denial of service:
 * the key body has 95 random bits, so the limit mostly bounds the load and the
 * noise such a script makes.
 *
 * A bucket is named after the client's address, so it is personal data: the
 * daily retention pass deletes the ones that have refilled (`forgetRefilled`).
 * With the default limits a bucket refills within a minute, so an address
 * stays in the table for about a day at most.
 */
final class RateLimiter
{
    private const DEFAULT_MAX_CLIENTS = 50_000;

    private readonly int $burst;

    private readonly float $refillPerMs;

    /** @var callable(): int */
    private $clock;

    /** @param null|callable(): int $clock */
    public function __construct(
        private readonly Store $store,
        int $burst,
        int $perMinute,
        ?callable $clock = null,
        private readonly int $maxClients = self::DEFAULT_MAX_CLIENTS,
    ) {
        $this->burst = max(1, $burst);
        $this->refillPerMs = max(1, $perMinute) / 60_000;
        $this->clock = $clock ?? Authority::systemClock(...);
    }

    /**
     * Spend one token for `$client`, or say how long until one is available.
     * `$scope` keeps unrelated limits apart: failed admin authentication is
     * counted separately from activations made from the same address.
     *
     * @return array{allowed: bool, retryAfterSeconds: int}
     */
    public function take(string $client, string $scope = 'public'): array
    {
        return $this->store->takeToken(
            $scope . '|' . self::clientBucketId($client),
            $this->burst,
            $this->refillPerMs,
            ($this->clock)(),
            $this->maxClients,
        );
    }

    /**
     * Delete every bucket that has refilled by `$now` — the daily retention
     * pass calls this, because each bucket is named after an address. Both
     * scopes share this limiter's burst and refill, so one rule fits all.
     * Returns how many went.
     */
    public function forgetRefilled(int $now): int
    {
        return $this->store->deleteRefilledBuckets($this->burst, $this->refillPerMs, $now);
    }

    /**
     * The identity a client is rate limited under: IPv4 addresses as they
     * are (unwrapping IPv4-mapped IPv6), IPv6 addresses by their /64 — one
     * subscriber is routinely given a whole /64.
     */
    public static function clientBucketId(string $address): string
    {
        if (preg_match('/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iD', $address, $match) === 1) {
            return $match[1];
        }

        if (filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
            return $address;
        }

        $withoutZone = explode('%', $address)[0];
        if (filter_var($withoutZone, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
            return $address;
        }

        $groups = self::expandIPv6($withoutZone);

        return $groups === null ? $address : implode(':', array_slice($groups, 0, 4)) . '::/64';
    }

    /**
     * Expand `::` shorthand into eight hextets (leading zeros dropped), or
     * `null` if the form is unexpected.
     *
     * @return null|list<string>
     */
    private static function expandIPv6(string $address): ?array
    {
        $halves = explode('::', strtolower($address));
        if (count($halves) > 2) {
            return null;
        }

        $head = $halves[0] === '' ? [] : explode(':', $halves[0]);
        $tail = count($halves) === 2 && $halves[1] !== '' ? explode(':', $halves[1]) : [];

        // An embedded IPv4 tail occupies two hextets.
        $tailWidth = 0;
        foreach ($tail as $part) {
            $tailWidth += str_contains($part, '.') ? 2 : 1;
        }
        $missing = 8 - count($head) - $tailWidth;

        if (count($halves) === 1 && $missing !== 0) {
            return null;
        }
        if ($missing < 0) {
            return null;
        }

        $groups = [...$head, ...array_fill(0, $missing, '0'), ...$tail];

        return array_map(
            static fn (string $group): string => str_contains($group, '.') ? $group : (preg_replace('/^0+(?=.)/', '', $group) ?? $group),
            $groups,
        );
    }
}

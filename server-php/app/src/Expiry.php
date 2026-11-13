<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * Turning an operator's idea of "when this licence ends" into an instant
 * (epoch milliseconds).
 *
 * Ported from src/server/expiry.ts, including its edge cases, so that
 * `"expires": "2027-03-31"` from a payment webhook means the same moment here
 * as on the reference server. The arithmetic is done on integers rather than
 * with `DateTime`, which would quietly roll 30 February over into March.
 */
final class Expiry
{
    public const DAY_MS = 86_400_000;

    /** Upper bound on a term, mostly to catch a misplaced digit. */
    public const MAX_TERM_DAYS = 36_500;

    private const DATE_ONLY = '/^(\d{4})-(\d{2})-(\d{2})$/D';

    /** An ISO 8601 instant with an explicit zone; a zone-less time is ambiguous. */
    private const DATE_TIME = '/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/D';

    private function __construct()
    {
    }

    /**
     * Parse an expiry date.
     *
     * A bare date means the licence works *through* that day: it ends at
     * 23:59:59.999 UTC, the reading that never ends a term early.
     */
    public static function parseDate(string $text): int
    {
        $trimmed = Js::trim($text);

        if (preg_match(self::DATE_ONLY, $trimmed, $match) === 1) {
            [$year, $month, $day] = [(int) $match[1], (int) $match[2], (int) $match[3]];
            if (!self::isCalendarDate($year, $month, $day)) {
                throw LicenseError::invalidArgument("{$trimmed} is not a real date.");
            }

            return self::utc($year, $month, $day, 23, 59, 59, 999);
        }

        if (preg_match(self::DATE_TIME, $trimmed, $match) === 1) {
            // The date part is checked on its own digits first, as the
            // reference does, so an impossible day is "not a real date"
            // rather than a silently shifted one.
            if (!self::isCalendarDate((int) $match[1], (int) $match[2], (int) $match[3])) {
                throw LicenseError::invalidArgument("{$trimmed} is not a real date.");
            }

            $instant = self::isoInstant($match);
            if ($instant !== null) {
                return $instant;
            }
        }

        throw LicenseError::invalidArgument(
            "\"{$trimmed}\" is not a date. Use YYYY-MM-DD, or a full ISO 8601 time with a zone such as 2027-03-31T12:00:00Z.",
        );
    }

    /** `$days` from `$from`. */
    public static function addDays(int $from, int $days): int
    {
        return $from + $days * self::DAY_MS;
    }

    /**
     * The expiry of a new licence: an absolute date, a term, or neither
     * (`null`, perpetual). A date already in the past is always a typo.
     */
    public static function resolveNew(?string $expires, ?int $days, int $now): ?int
    {
        if ($expires !== null && $days !== null) {
            throw LicenseError::invalidArgument('Give an expiry date or a number of days, not both.');
        }

        if ($days !== null) {
            return self::addDays($now, self::checkedDays($days));
        }

        if ($expires !== null) {
            $instant = self::parseDate($expires);
            if ($instant <= $now) {
                throw LicenseError::invalidArgument('The expiry date is already in the past.');
            }

            return $instant;
        }

        return null;
    }

    /**
     * A renewal. `$days` extends from whichever is later, now or the current
     * expiry: renewing early keeps what was paid for, renewing late does not
     * back-date a month that was not.
     */
    public static function resolveExtension(?string $expires, ?int $days, bool $perpetual, ?int $current, int $now): ?int
    {
        $chosen = (int) ($expires !== null) + (int) ($days !== null) + (int) $perpetual;

        if ($chosen !== 1) {
            throw LicenseError::invalidArgument('Give exactly one of: an expiry date, a number of days, or perpetual.');
        }

        if ($perpetual) {
            return null;
        }

        if ($days !== null) {
            if ($current === null) {
                throw LicenseError::invalidArgument(
                    'This licence is perpetual, so there is no term to extend. Set an expiry date instead if you mean to limit it.',
                );
            }

            return self::addDays(max($now, $current), self::checkedDays($days));
        }

        $instant = self::parseDate($expires ?? '');
        if ($instant <= $now) {
            throw LicenseError::invalidArgument('The expiry date is already in the past.');
        }

        return $instant;
    }

    /**
     * Whether year-month-day names a day that exists.
     *
     * Years 0–99 are refused as JavaScript's `Date.UTC` refuses them (it reads
     * them as 1900–1999), so both servers call `0099-01-01` "not a real date".
     */
    public static function isCalendarDate(int $year, int $month, int $day): bool
    {
        return $year >= 100 && checkdate($month, $day, $year);
    }

    /** Epoch milliseconds for a UTC calendar time, proleptic Gregorian. */
    public static function utc(int $year, int $month, int $day, int $hour = 0, int $minute = 0, int $second = 0, int $millisecond = 0): int
    {
        // Days from civil (Howard Hinnant's algorithm), exact for any year.
        $y = $month <= 2 ? $year - 1 : $year;
        $era = intdiv($y >= 0 ? $y : $y - 399, 400);
        $yearOfEra = $y - $era * 400;
        $dayOfYear = intdiv(153 * ($month + ($month > 2 ? -3 : 9)) + 2, 5) + $day - 1;
        $dayOfEra = $yearOfEra * 365 + intdiv($yearOfEra, 4) - intdiv($yearOfEra, 100) + $dayOfYear;
        $days = $era * 146097 + $dayOfEra - 719468;

        return (($days * 24 + $hour) * 60 + $minute) * 60_000 + $second * 1000 + $millisecond;
    }

    /**
     * The instant an ISO 8601 match names, or `null` for a time V8's
     * `Date.parse` refuses (25:00, 23:60, an offset of 24 hours, …).
     *
     * @param array<int, string> $match
     */
    private static function isoInstant(array $match): ?int
    {
        $hour = (int) $match[4];
        $minute = (int) $match[5];
        $second = isset($match[6]) && $match[6] !== '' ? (int) $match[6] : 0;
        $fraction = isset($match[7]) && $match[7] !== '' ? (int) str_pad($match[7], 3, '0') : 0;

        if ($minute > 59 || $second > 59 || $hour > 24) {
            return null;
        }

        // ISO 8601's end-of-day midnight, and nothing past it.
        if ($hour === 24 && ($minute !== 0 || $second !== 0 || $fraction !== 0)) {
            return null;
        }

        $offsetMinutes = 0;
        if ($match[8] !== 'Z') {
            $offsetHours = (int) $match[10];
            $offsetMins = (int) $match[11];
            if ($offsetHours > 23 || $offsetMins > 59) {
                return null;
            }
            $offsetMinutes = ($match[9] === '-' ? -1 : 1) * ($offsetHours * 60 + $offsetMins);
        }

        $local = self::utc((int) $match[1], (int) $match[2], (int) $match[3], $hour, $minute, $second, $fraction);

        return $local - $offsetMinutes * 60_000;
    }

    private static function checkedDays(int $days): int
    {
        if ($days < 1 || $days > self::MAX_TERM_DAYS) {
            throw LicenseError::invalidArgument(
                'The number of days must be a whole number from 1 to ' . self::MAX_TERM_DAYS . '.',
            );
        }

        return $days;
    }
}

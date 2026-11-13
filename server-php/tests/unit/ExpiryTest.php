<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\Expiry;
use RecoverX\Licensing\LicenseError;

/* Expiry arithmetic, case for case with tests/unit/server/config.test.ts. */

test('reads a bare date as the end of that day, UTC', function (): void {
    Assert::same(Expiry::utc(2027, 3, 31, 23, 59, 59, 999), Expiry::parseDate('2027-03-31'));
    Assert::same(Expiry::utc(2028, 2, 29, 23, 59, 59, 999), Expiry::parseDate(' 2028-02-29 '));
    Assert::same(1_806_537_599_999, Expiry::parseDate('2027-03-31'));
});

test('reads an ISO instant only with an explicit zone', function (): void {
    Assert::same(Expiry::utc(2027, 3, 31, 12), Expiry::parseDate('2027-03-31T12:00:00Z'));
    Assert::same(Expiry::utc(2027, 3, 31, 6, 30), Expiry::parseDate('2027-03-31T12:00+05:30'));
    Assert::same(Expiry::utc(2027, 3, 31, 12, 0, 0, 500), Expiry::parseDate('2027-03-31T12:00:00.5Z'));
    Assert::same(Expiry::utc(2027, 3, 31, 12, 0, 0, 120), Expiry::parseDate('2027-03-31T12:00:00.12Z'));
    Assert::same(1_806_408_060_000, Expiry::parseDate('2027-03-31T12:00+23:59'));
    Assert::throws(LicenseError::class, static fn () => Expiry::parseDate('2027-03-31T12:00:00'), '/not a date/');
});

test('refuses dates that do not exist', function (): void {
    Assert::throws(LicenseError::class, static fn () => Expiry::parseDate('2027-02-29'), '/not a real date/');
    Assert::throws(LicenseError::class, static fn () => Expiry::parseDate('2027-13-01'), '/not a real date/');
    // JavaScript's Date.UTC reads years 0–99 as 1900–1999, so the reference
    // calls them unreal; so does this server.
    Assert::throws(LicenseError::class, static fn () => Expiry::parseDate('0099-01-01'), '/not a real date/');
});

test('refuses impossible days in a full ISO time too', function (): void {
    foreach (['2027-02-30T12:00:00Z', '2027-04-31T23:59:59Z', '2027-02-29T00:00Z', '2027-02-31T00:00:00+14:00', '2027-00-10T00:00:00Z'] as $text) {
        Assert::throws(LicenseError::class, static fn () => Expiry::parseDate($text), '/not a real date/');
    }

    Assert::same(Expiry::utc(2028, 2, 29, 23, 59, 59), Expiry::parseDate('2028-02-29T23:59:59Z'));
    // ISO 8601's end-of-day midnight is the start of the next day.
    Assert::same(Expiry::utc(2027, 4, 1), Expiry::parseDate('2027-03-31T24:00:00Z'));
    Assert::same(Expiry::utc(2027, 4, 1), Expiry::parseDate('2027-03-31T24:00:00.000Z'));

    foreach (['2027-03-31T25:00:00Z', '2027-03-31T24:00:01Z', '2027-03-31T24:01Z', '2027-03-31T23:60Z', '2027-03-31T23:59:60Z', '2027-03-31T12:00+24:00', '2027-03-31T12:00+23:60', '2027-03-31T24:00:00.001Z'] as $text) {
        Assert::throws(LicenseError::class, static fn () => Expiry::parseDate($text), '/not a date/');
    }
});

test('says what a date must look like', function (): void {
    Assert::throws(LicenseError::class, static fn () => Expiry::parseDate('next tuesday'), '/^"next tuesday" is not a date\. Use YYYY-MM-DD/');
});

test('resolves new terms and renewals', function (): void {
    $now = Kit::NOW;
    $day = Kit::DAY;

    Assert::same(null, Expiry::resolveNew(null, null, $now));
    Assert::same($now + $day, Expiry::resolveNew(null, 1, $now));
    Assert::throws(LicenseError::class, static fn () => Expiry::resolveNew(null, 36_501, $now), '/36500/');
    Assert::throws(LicenseError::class, static fn () => Expiry::resolveNew('2027-01-01', 30, $now), '/not both/');
    Assert::throws(LicenseError::class, static fn () => Expiry::resolveNew('2020-01-01', null, $now), '/already in the past/');

    Assert::same($now + 11 * $day, Expiry::resolveExtension(null, 10, false, $now + $day, $now));
    Assert::same($now + 10 * $day, Expiry::resolveExtension(null, 10, false, $now - $day, $now));
    Assert::same(null, Expiry::resolveExtension(null, null, true, $now, $now));
    Assert::throws(LicenseError::class, static fn () => Expiry::resolveExtension('2001-01-01', null, false, null, $now), '/past/');
    Assert::throws(LicenseError::class, static fn () => Expiry::resolveExtension(null, 10, false, null, $now), '/perpetual/');
    Assert::throws(LicenseError::class, static fn () => Expiry::resolveExtension(null, 10, true, $now, $now), '/exactly one/');
    Assert::throws(LicenseError::class, static fn () => Expiry::resolveExtension(null, null, false, $now, $now), '/exactly one/');
});

test('computes civil dates exactly, across centuries and leap years', function (): void {
    Assert::same(0, Expiry::utc(1970, 1, 1));
    Assert::same(951_782_400_000, Expiry::utc(2000, 2, 29));
    Assert::same(-62_167_219_200_000, Expiry::utc(0, 1, 1));
    Assert::same(253_402_300_799_999, Expiry::utc(9999, 12, 31, 23, 59, 59, 999));
    Assert::same(Kit::NOW, Expiry::utc(2026, 11, 12, 12));
});

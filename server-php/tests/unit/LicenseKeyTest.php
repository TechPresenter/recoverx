<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\LicenseKey;

/*
 * The key format, as src/shared/utils/license-key.ts defines it. The
 * contract-parity test (tests/unit/server/php-contract.test.ts) additionally
 * runs a shared corpus through both implementations; these cases pin the
 * behaviour on the PHP side alone.
 */

test('every generated key validates and is already canonical', function (): void {
    for ($index = 0; $index < 2000; $index += 1) {
        $key = LicenseKey::generate();
        Assert::same(['ok' => true, 'key' => $key, 'problem' => null], LicenseKey::validate($key));
        Assert::matches('/^RECX(-[0-9A-HJKMNP-TV-Z]{5}){4}$/', $key);
    }
});

test('a random body that begins like the prefix survives generation', function (): void {
    // RECX is spelled entirely in the key alphabet, so a random body can
    // begin with it; such a body must not be stripped as if it were the prefix.
    $key = LicenseKey::generate(Kit::picksFor('RECXBCDEFGHJKMNPQRS'));

    Assert::true(str_starts_with($key, 'RECX-RECXB-'), $key);
    Assert::same(['ok' => true, 'key' => $key, 'problem' => null], LicenseKey::validate($key));
});

test('the generator refuses an out-of-range random index instead of producing a short key', function (): void {
    foreach ([32, -1, 0.5, '1', null] as $bad) {
        Assert::throws(\RangeException::class, static fn () => LicenseKey::generate(static fn (int $max): mixed => $bad));
    }
});

test('keys are accepted the way customers type them', function (): void {
    $key = LicenseKey::generate();
    $body = substr(str_replace('-', '', $key), 4);

    foreach ([
        strtolower($key),
        str_replace('-', '', $key),
        ' ' . str_replace('-', ' ', $key) . "\t",
        'RECX' . $body,
        'recx-' . strtolower($body),
        "RECX\u{00A0}" . $body . "\u{3000}",
        'RECX--' . chunk_split($body, 2, '-'),
    ] as $typed) {
        Assert::same($key, LicenseKey::validate($typed)['key'], json_encode($typed, JSON_UNESCAPED_UNICODE) ?: '');
    }
});

test('confusable letters are read as the digits they stand for', function (): void {
    Assert::same('RECX10101V', LicenseKey::normalize('recx-IO-LO-1U'));
    Assert::same('RECX', LicenseKey::normalize('recx'));
    Assert::same('ABC', LicenseKey::normalize('abc'));
});

test('a prefix is recognised as typed with the confusions the body allows', function (): void {
    // RECX has no confusable letter, so it is its own only spelling; the rule
    // stays general for a prefix that has one, as in license-key.ts.
    Assert::same(['RECX'], LicenseKey::prefixForms());
    Assert::same(['SOLO', 'S010'], LicenseKey::prefixForms('SOLO'));
    Assert::same(['ABCD'], LicenseKey::prefixForms('ABCD'));
});

test('each kind of malformed key gets its own problem', function (): void {
    $key = LicenseKey::generate();
    $last = substr($key, -1);
    $wrongChecksum = substr($key, 0, -1) . ($last === '0' ? '1' : '0');

    Assert::same('empty', LicenseKey::validate('')['problem']);
    Assert::same('empty', LicenseKey::validate(" - \t")['problem']);
    Assert::same('wrong-product', LicenseKey::validate('ABCD-12345-12345-12345-12345')['problem']);
    Assert::same('wrong-length', LicenseKey::validate('RECX-12345')['problem']);
    Assert::same('bad-character', LicenseKey::validate('RECX-1234!-12345-12345-12345')['problem']);
    Assert::same('bad-character', LicenseKey::validate('RECX-1234é-12345-12345-12345')['problem']);
    Assert::same('checksum', LicenseKey::validate($wrongChecksum)['problem']);
    Assert::same('checksum', LicenseKey::validate('RECX-AAAAA-AAAAA-AAAAA-AAAAB')['problem']);
});

test('lengths are counted the way JavaScript counts them', function (): void {
    // é is one UTF-16 unit: 19 + 1 = 20, so the problem is the character,
    // not the length. 😀 is two units, making 21.
    Assert::same('bad-character', LicenseKey::validate('RECX' . str_repeat('A', 19) . 'é')['problem']);
    Assert::same('wrong-length', LicenseKey::validate('RECX' . str_repeat('A', 19) . '😀')['problem']);
});

test('upper-casing follows Unicode, as toUpperCase does', function (): void {
    if (!function_exists('mb_strtoupper')) {
        return;
    }

    // The dotless ı upper-cases to I, which then reads as the digit 1.
    Assert::same('RECX1', LicenseKey::normalize('recxı'));
    Assert::same('RECXSS', LicenseKey::normalize('recxß'));
});

test('swapping two neighbouring characters is caught', function (): void {
    $canonical = LicenseKey::complete('0123456789ABCDEFGHJ');
    Assert::true($canonical !== null);
    $compact = str_replace('-', '', (string) $canonical);

    for ($position = 4; $position < 22; $position += 1) {
        $swapped = substr($compact, 0, $position) . $compact[$position + 1] . $compact[$position] . substr($compact, $position + 2);
        Assert::same('checksum', LicenseKey::validate($swapped)['problem'], "swap at {$position}");
    }
});

test('masking hides all but the last group', function (): void {
    Assert::same('RECX-•••••-•••••-•••••-MNPQR', LicenseKey::mask('RECX-ABCDE-FGHJK-12345-MNPQR'));
    Assert::same('RECX-ABC', LicenseKey::mask('recx abc'));
});

test('formatting groups a partial key as the customer types', function (): void {
    Assert::same('RECX-ABCDE-FG', LicenseKey::format('recxabcdefg'));
    Assert::same('RECX-12345', LicenseKey::format('12345'));
    Assert::same('RECX', LicenseKey::format(''));
});

test('completing a payload adds the checksum, and refuses the wrong length', function (): void {
    $key = LicenseKey::complete('0123456789ABCDEFGHJ');
    Assert::true($key !== null);
    Assert::same(true, LicenseKey::validate((string) $key)['ok']);
    Assert::same($key, LicenseKey::complete('RECX-01234-56789-ABCDE-FGHJ'));
    Assert::same(null, LicenseKey::complete('0123'));
    Assert::same(null, LicenseKey::complete('0123456789ABCDEFGH!'));
});

test('the checksum is a weighted sum over the alphabet', function (): void {
    Assert::same('0', LicenseKey::checksumCharacter(''));
    Assert::same('1', LicenseKey::checksumCharacter('1'));
    // 1·1 + 2·2 = 5
    Assert::same('5', LicenseKey::checksumCharacter('12'));
    Assert::same('', LicenseKey::checksumCharacter('1I'));
});

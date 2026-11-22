<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\Authority;
use RecoverX\Licensing\Expiry;
use RecoverX\Licensing\LicenseKey;
use RecoverX\Licensing\Messages;
use RecoverX\Licensing\Store;
use RecoverX\Licensing\TokenSigner;

/*
 * The licensing rules, following tests/unit/server/authority.test.ts: what the
 * reference server does, this one must do.
 */

function activate(array $f, string $key, string $machine): array
{
    return $f['authority']->activate($key, $machine, Authority::PRODUCT_ID, Kit::CUSTOMER);
}

/** @return list<string> event types of a licence, oldest first */
function eventTypes(array $f, string $key): array
{
    return array_reverse(array_map(static fn (array $e): string => $e['type'], $f['store']->listEvents($key, 100)));
}

// --- minting ------------------------------------------------------------------------------

test('gives each paid edition its standard seat count, perpetual by default', function (): void {
    $f = Kit::fixture();
    foreach (['professional' => 1, 'business' => 3, 'technician' => null, 'enterprise' => null] as $edition => $seats) {
        $licence = $f['authority']->createLicenses((object) ['edition' => $edition], Kit::CLI)['licenses'][0];
        Assert::same($seats, $licence['maxActivations'], $edition);
        Assert::same(null, $licence['expiresAt']);
        Assert::same(Kit::NOW, $licence['createdAt']);
    }
});

test('mints keys the desktop client accepts, in canonical form', function (): void {
    $f = Kit::fixture();
    $licences = $f['authority']->createLicenses((object) ['edition' => 'business', 'count' => 25], Kit::CLI)['licenses'];

    Assert::same(25, count($licences));
    Assert::same(25, count(array_unique(array_column($licences, 'key'))));
    foreach ($licences as $licence) {
        Assert::same(['ok' => true, 'key' => $licence['key'], 'problem' => null], LicenseKey::validate($licence['key']));
    }
});

test('refuses the Free edition and editions that do not exist', function (): void {
    $f = Kit::fixture();
    Assert::refuses('invalid-argument', static fn () => Kit::mint($f['authority'], ['edition' => 'free']), '/Free edition needs no licence key/');
    Assert::refuses('invalid-argument', static fn () => Kit::mint($f['authority'], ['edition' => 'ultimate']));
});

test('overrides the seat count, including to unlimited', function (): void {
    $f = Kit::fixture();
    Assert::same(5, $f['authority']->createLicenses((object) ['edition' => 'professional', 'seats' => 5], Kit::CLI)['licenses'][0]['maxActivations']);
    Assert::same(null, $f['authority']->createLicenses((object) ['edition' => 'professional', 'seats' => null], Kit::CLI)['licenses'][0]['maxActivations']);
});

test('ends a dated licence at the end of that day, and a term licence days from now', function (): void {
    $f = Kit::fixture();
    $dated = $f['authority']->createLicenses((object) ['edition' => 'professional', 'expires' => '2027-03-31'], Kit::CLI)['licenses'][0];
    Assert::same(Expiry::utc(2027, 3, 31, 23, 59, 59, 999), $dated['expiresAt']);

    $term = $f['authority']->createLicenses((object) ['edition' => 'business', 'days' => 365], Kit::CLI)['licenses'][0];
    Assert::same(Kit::NOW + 365 * Kit::DAY, $term['expiresAt']);
});

test('refuses impossible minting requests with an explanation', function (): void {
    $f = Kit::fixture();
    foreach ([
        [['expires' => '2027-01-01', 'days' => 30], '/not both/'],
        [['expires' => '2020-01-01'], '/already in the past/'],
        [['expires' => '2027-02-30'], '/not a real date/'],
        [['expires' => 'next tuesday'], '/not a date/'],
        [['days' => 0], '/days/'],
        [['count' => 0], '/count/'],
        [['count' => 1001], '/count/'],
        [['seats' => 0], '/seats/'],
        [['email' => 'not-an-address'], '/email/'],
        [['registered_to' => 'Jane'], '/registered_to/'],
    ] as [$extra, $pattern]) {
        Assert::refuses('invalid-argument', static fn () => Kit::mint($f['authority'], ['edition' => 'professional'] + $extra), $pattern);
    }
});

test('is idempotent per order reference, so a retried webhook mints nothing new', function (): void {
    $f = Kit::fixture();
    $input = (object) ['edition' => 'business', 'count' => 2, 'orderRef' => 'INV-1042', 'registeredTo' => 'Contoso Ltd'];
    $first = $f['authority']->createLicenses($input, Kit::CLI);
    $again = $f['authority']->createLicenses($input, Kit::CLI);

    Assert::same(true, $first['created']);
    Assert::same(false, $again['created']);
    $keys = array_column($first['licenses'], 'key');
    sort($keys);
    $replayed = array_column($again['licenses'], 'key');
    sort($replayed);
    Assert::same($keys, $replayed);
    Assert::same(2, count($f['authority']->list(['orderRef' => 'INV-1042'])));
});

test('draws again when a generated key is already taken, and gives up loudly when it keeps repeating', function (): void {
    $repeat = static fn (int $max): int => 7;
    $f = Kit::fixture(['randomIndex' => $repeat]);
    $taken = Kit::mint($f['authority'], ['edition' => 'professional']);

    Assert::throws(\RuntimeException::class, static fn () => Kit::mint($f['authority'], ['edition' => 'professional']), '/8 attempts/');

    // A source that repeats once and then varies succeeds on the second draw.
    $calls = 0;
    $once = static function (int $max) use (&$calls): int {
        $calls += 1;

        return $calls <= 19 ? 7 : random_int(0, $max - 1);
    };
    $g = Kit::fixture(['randomIndex' => $once]);
    $first = Kit::mint($g['authority'], ['edition' => 'professional']);
    $calls = 0;
    $second = Kit::mint($g['authority'], ['edition' => 'professional']);
    Assert::same($taken, $first);
    Assert::true($first !== $second);
});

// --- activation ---------------------------------------------------------------------------

test('issues a token for the canonical key and the machine, carrying the licence', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'business', 'registeredTo' => 'Contoso Ltd', 'days' => 365]);
    $typed = strtolower(str_replace('-', '', $key));

    $result = activate($f, $typed, Kit::MACHINE_A);
    $check = $f['signer']->verifySignature($result['token']);

    Assert::same(true, $check['ok']);
    Assert::same([
        'v' => 1,
        'edition' => 'business',
        'key' => $key,
        'machine' => Kit::MACHINE_A,
        'issuedAt' => Kit::NOW,
        'expiresAt' => Kit::NOW + 365 * Kit::DAY,
        'registeredTo' => 'Contoso Ltd',
    ], $check['claims']);
    Assert::same(false, $result['reused']);
    Assert::same(1, $result['activeSeats']);
});

test('re-activating the same machine is idempotent and takes no extra seat', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);

    activate($f, $key, Kit::MACHINE_A);
    $f['clock']->advance(Kit::DAY);
    $again = activate($f, $key, Kit::MACHINE_A);

    Assert::same(true, $again['reused']);
    Assert::same(1, $again['activeSeats']);
    Assert::same(['license-created', 'activated', 'reactivated'], eventTypes($f, $key));
    $activation = $f['store']->getActivation($key, Kit::MACHINE_A);
    Assert::same(Kit::NOW, $activation['firstActivatedAt']);
    Assert::same(Kit::NOW + Kit::DAY, $activation['lastActivatedAt']);
});

test('refuses a second machine once the seats are taken, in the customer’s terms', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    activate($f, $key, Kit::MACHINE_A);

    $error = Assert::refuses('seats-exhausted', static fn () => activate($f, $key, Kit::MACHINE_B));
    Assert::same(409, $error->status);
    Assert::same(Messages::seatsExhausted(1), $error->getMessage());
    Assert::matches('/already active on another computer/', $error->getMessage());

    $business = Kit::mint($f['authority'], ['edition' => 'business']);
    foreach ([Kit::MACHINE_A, Kit::MACHINE_B, Kit::MACHINE_C] as $machine) {
        activate($f, $business, $machine);
    }
    Assert::refuses('seats-exhausted', static fn () => activate($f, $business, Kit::MACHINE_D), '/already active on 3 computers/');
});

test('does not cap an unlimited licence', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'technician']);
    for ($index = 0; $index < 12; $index += 1) {
        activate($f, $key, sprintf('MACH-INE%02d-AAAA-BBBB-CCCC-DDDD', $index));
    }
    Assert::same(12, $f['store']->countActiveSeats($key));
});

test('refuses unknown, mistyped, wrong-product and malformed-machine requests', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);

    $unknown = Assert::refuses('unknown-key', static fn () => activate($f, LicenseKey::generate(static fn (): int => 9), Kit::MACHINE_A));
    Assert::same(404, $unknown->status);
    Assert::same(Messages::UNKNOWN_KEY, $unknown->getMessage());

    Assert::refuses('invalid-key', static fn () => activate($f, 'RECX-AAAAA-AAAAA-AAAAA-AAAAB', Kit::MACHINE_A), '/typing error/');
    Assert::refuses('invalid-key', static fn () => activate($f, 'ABCD-AAAAA', Kit::MACHINE_A), '/different product/');
    Assert::refuses('wrong-product', static fn () => $f['authority']->activate($key, Kit::MACHINE_A, 'other', Kit::CUSTOMER));
    Assert::refuses('invalid-machine', static fn () => activate($f, $key, 'abcd-efgh-jkmn-pqrs-tvwx-yz12'));
    Assert::refuses('invalid-machine', static fn () => activate($f, $key, 'SHORT'));

    // Unknown and malformed keys are not written to the audit trail.
    Assert::same(['license-created'], eventTypes($f, $key));
});

test('refuses a revoked licence, including on a machine that already held a seat', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    activate($f, $key, Kit::MACHINE_A);
    $f['authority']->revoke($key, 'refund', Kit::CLI);

    $error = Assert::refuses('revoked', static fn () => activate($f, $key, Kit::MACHINE_A));
    Assert::same(403, $error->status);
    Assert::same(Messages::REVOKED, $error->getMessage());
});

test('refuses an expired licence and says when it ended', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional', 'days' => 30]);
    $f['clock']->advance(31 * Kit::DAY);

    $error = Assert::refuses('expired', static fn () => activate($f, $key, Kit::MACHINE_A));
    Assert::same(403, $error->status);
    Assert::same(
        'This licence ended on 12 December 2026. Renew it by emailing info@appsgain.in (see https://recoverx.snapkio.com/support/#renew) to recover without limit again.',
        $error->getMessage(),
    );
});

test('records refusals of a known licence, but not renewal checks from a computer that holds a seat', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional', 'days' => 30]);
    activate($f, $key, Kit::MACHINE_A);
    Assert::refuses('seats-exhausted', static fn () => activate($f, $key, Kit::MACHINE_B));

    $f['clock']->advance(31 * Kit::DAY);
    Assert::refuses('expired', static fn () => activate($f, $key, Kit::MACHINE_A));
    Assert::refuses('expired', static fn () => activate($f, $key, Kit::MACHINE_A));
    Assert::refuses('expired', static fn () => activate($f, $key, Kit::MACHINE_B));

    Assert::same(['license-created', 'activated', 'activation-refused', 'activation-refused'], eventTypes($f, $key));
    $details = array_map(static fn (array $e): string => (string) $e['detail'], array_reverse($f['store']->listEvents($key, 10)));
    Assert::same('{"actor":"customer","reason":"seats-exhausted"}', $details[2]);
    Assert::same('{"actor":"customer","reason":"expired"}', $details[3]);
});

// --- deactivation ---------------------------------------------------------------------------

test('releases the seat, and the licence can then move to another machine', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    $token = activate($f, $key, Kit::MACHINE_A)['token'];

    Assert::same(['released' => true, 'key' => $key, 'machineId' => Kit::MACHINE_A], $f['authority']->deactivate($token, Kit::CUSTOMER));
    Assert::same(1, activate($f, $key, Kit::MACHINE_B)['activeSeats']);

    // Idempotent: the seat is already free.
    Assert::same(false, $f['authority']->deactivate($token, Kit::CUSTOMER)['released']);
});

test('keeps a returning machine’s history as one machine', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    $token = activate($f, $key, Kit::MACHINE_A)['token'];
    $f['authority']->deactivate($token, Kit::CUSTOMER);
    $f['clock']->advance(Kit::DAY);
    activate($f, $key, Kit::MACHINE_A);

    $activations = $f['store']->listActivations($key);
    Assert::same(1, count($activations));
    Assert::same(Kit::NOW, $activations[0]['firstActivatedAt']);
    Assert::same(null, $activations[0]['releasedAt']);
});

test('still releases the seat of a licence whose term has ended', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional', 'days' => 1]);
    $token = activate($f, $key, Kit::MACHINE_A)['token'];
    $f['clock']->advance(10 * Kit::DAY);

    Assert::same(true, $f['authority']->deactivate($token, Kit::CUSTOMER)['released']);
});

test('refuses a token signed with another key, an unreadable one, and one for a licence that is gone', function (): void {
    $f = Kit::fixture();
    $other = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    activate($f, $key, Kit::MACHINE_A);
    $foreign = Kit::mint($other['authority'], ['edition' => 'professional']);
    $foreignToken = activate($other, $foreign, Kit::MACHINE_A)['token'];

    $forged = Assert::refuses('forged-token', static fn () => $f['authority']->deactivate($foreignToken, Kit::CUSTOMER));
    Assert::same(403, $forged->status);
    Assert::same(Messages::TOKEN_FORGED, $forged->getMessage());

    $unreadable = Assert::refuses('invalid-token', static fn () => $f['authority']->deactivate('not-a-token', Kit::CUSTOMER));
    Assert::same(400, $unreadable->status);

    // Signed by this server's key, for a key it never issued.
    $orphan = $f['signer']->issue(['v' => 1, 'edition' => 'professional', 'key' => LicenseKey::generate(), 'machine' => Kit::MACHINE_A, 'issuedAt' => Kit::NOW, 'expiresAt' => null, 'registeredTo' => null]);
    $missing = Assert::refuses('unknown-key', static fn () => $f['authority']->deactivate($orphan, Kit::CUSTOMER));
    Assert::same(Messages::TOKEN_LICENCE_MISSING, $missing->getMessage());
    Assert::same(Kit::MACHINE_A, $missing->subject['machineId'] ?? null);
});

// --- renewal ----------------------------------------------------------------------------------

test('gives the same machine a token carrying the extended end date, without a new seat', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'business', 'days' => 30, 'registeredTo' => 'Contoso']);
    $before = activate($f, $key, Kit::MACHINE_A);

    $f['authority']->extend($key, (object) ['days' => 365], Kit::CLI);
    $after = activate($f, $key, Kit::MACHINE_A);

    Assert::same(Kit::NOW + 30 * Kit::DAY, $before['claims']['expiresAt']);
    Assert::same(Kit::NOW + 395 * Kit::DAY, $after['claims']['expiresAt']);
    Assert::same(true, $after['reused']);
    Assert::same(1, $after['activeSeats']);
});

// --- the self-service release allowance -------------------------------------------------------------

/** Activate and release on one machine, `$times` times. */
function move(array $f, string $key, int $times, string $machine = Kit::MACHINE_A): void
{
    for ($index = 0; $index < $times; $index += 1) {
        $token = activate($f, $key, $machine)['token'];
        Assert::same(true, $f['authority']->deactivate($token, Kit::CUSTOMER)['released'], "move {$index}");
    }
}

test('defaults to four moves in a rolling year', function (): void {
    $f = Kit::fixture();
    Assert::same(['limit' => 4, 'windowDays' => 365], $f['authority']->selfReleasePolicy());
});

test('refuses the move past the allowance with 409, and the seat stays held', function (): void {
    $f = Kit::fixture(['limit' => 2]);
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    move($f, $key, 2);
    $held = activate($f, $key, Kit::MACHINE_A)['token'];

    $error = Assert::refuses('self-release-limit', static fn () => $f['authority']->deactivate($held, Kit::CUSTOMER));
    Assert::same(409, $error->status);
    Assert::same(
        'This licence has already been moved between computers twice in the last 12 months. '
        . 'It is still active on this computer. To move it again, contact info@appsgain.in with your licence key.',
        $error->getMessage(),
    );
    Assert::same(1, $f['store']->countActiveSeats($key));
    Assert::same(['recent' => 2, 'limit' => 2, 'windowDays' => 365], $f['authority']->show($key)['selfReleases']);
    Assert::same('deactivation-refused', eventTypes($f, $key)[count(eventTypes($f, $key)) - 1]);
});

test('counts only releases inside the rolling window', function (): void {
    $f = Kit::fixture(['limit' => 1, 'windowDays' => 30]);
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    move($f, $key, 1);
    $held = activate($f, $key, Kit::MACHINE_A)['token'];
    Assert::refuses('self-release-limit', static fn () => $f['authority']->deactivate($held, Kit::CUSTOMER), '/once in the last 30 days/');

    $f['clock']->advance(31 * Kit::DAY);
    Assert::same(true, $f['authority']->deactivate($held, Kit::CUSTOMER)['released']);
});

test('with a limit of 0, refuses every self-service release of a held seat', function (): void {
    $f = Kit::fixture(['limit' => 0]);
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    $token = activate($f, $key, Kit::MACHINE_A)['token'];

    $error = Assert::refuses('self-release-limit', static fn () => $f['authority']->deactivate($token, Kit::CUSTOMER));
    Assert::same(Messages::SELF_RELEASE_DISABLED, $error->getMessage());
});

test('never refuses or counts a repeated release of a seat that is already free', function (): void {
    $f = Kit::fixture(['limit' => 1]);
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    $token = activate($f, $key, Kit::MACHINE_A)['token'];
    $f['authority']->deactivate($token, Kit::CUSTOMER);

    for ($index = 0; $index < 3; $index += 1) {
        Assert::same(false, $f['authority']->deactivate($token, Kit::CUSTOMER)['released']);
    }
    Assert::same(1, $f['authority']->show($key)['selfReleases']['recent']);
});

test('lets support release and reset past the allowance, without counting either', function (): void {
    $f = Kit::fixture(['limit' => 2]);
    $key = Kit::mint($f['authority'], ['edition' => 'business']);
    move($f, $key, 2);
    $held = activate($f, $key, Kit::MACHINE_A)['token'];
    Assert::refuses('self-release-limit', static fn () => $f['authority']->deactivate($held, Kit::CUSTOMER));

    Assert::same(true, $f['authority']->release($key, strtolower(Kit::MACHINE_A), Kit::CLI));
    Assert::same(false, $f['authority']->deactivate($held, Kit::CUSTOMER)['released']);

    activate($f, $key, Kit::MACHINE_B);
    activate($f, $key, Kit::MACHINE_C);
    Assert::same(2, $f['authority']->resetSeats($key, Kit::CLI));

    $show = $f['authority']->show($key);
    Assert::same(0, $show['activeSeats']);
    Assert::same(['recent' => 2, 'limit' => 2, 'windowDays' => 365], $show['selfReleases']);
});

test('never limits a licence with unlimited seats, even at a limit of 0, but still counts its moves', function (): void {
    $f = Kit::fixture(['limit' => 0]);
    $technician = Kit::mint($f['authority'], ['edition' => 'technician']);
    $custom = Kit::mint($f['authority'], ['edition' => 'professional', 'seats' => null]);

    move($f, $technician, 3);
    move($f, $custom, 2);

    Assert::same(['recent' => 3, 'limit' => null, 'windowDays' => 365], $f['authority']->show($technician)['selfReleases']);
    Assert::same(['recent' => 2, 'limit' => null, 'windowDays' => 365], $f['authority']->show($custom)['selfReleases']);
});

test('keeps the count across a restart, because it is read from the database', function (): void {
    $f = Kit::fixture(['limit' => 1]);
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    move($f, $key, 1);

    $reopened = new Authority(Store::open($f['file']), $f['signer'], $f['clock'], null, 1, 365);
    $token = $reopened->activate($key, Kit::MACHINE_A, Authority::PRODUCT_ID, Kit::CUSTOMER)['token'];
    Assert::refuses('self-release-limit', static fn () => $reopened->deactivate($token, Kit::CUSTOMER), '/once in the last 12 months/');
});

test('says a count and a window the way a person would', function (): void {
    Assert::matches('/once in the last 12 months\. /', Messages::selfReleaseLimit(1, 365));
    Assert::matches('/3 times in the last 24 months\. /', Messages::selfReleaseLimit(3, 730));
    Assert::matches('/twice in the last 30 days\. /', Messages::selfReleaseLimit(2, 30));
    Assert::matches('/once in the last day\. /', Messages::selfReleaseLimit(1, 1));
    Assert::same('12 December 2026', Messages::formatCustomerDate(Kit::NOW + 30 * Kit::DAY));
    Assert::same('1 January 2027', Messages::formatCustomerDate(Expiry::utc(2027, 1, 1)));
});

// --- offline issuance and administration ------------------------------------------------------

test('offline issuance follows the same seat rules and forgives how a person types the machine id', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);

    $result = $f['authority']->issueOffline($key, '  ' . strtolower(Kit::MACHINE_C) . "\n", Kit::CLI);
    Assert::same(Kit::MACHINE_C, $result['claims']['machine']);
    Assert::same('offline-issued', eventTypes($f, $key)[1]);

    Assert::refuses('seats-exhausted', static fn () => $f['authority']->issueOffline($key, Kit::MACHINE_A, Kit::CLI));
    Assert::refuses('invalid-machine', static fn () => $f['authority']->issueOffline($key, 'nope', Kit::CLI), '/"nope" is not a RecoverX machine identifier/');
});

test('needs a signing key to issue or release', function (): void {
    $f = Kit::fixture();
    $authority = new Authority($f['store'], null, $f['clock']);
    $key = Kit::mint($authority, ['edition' => 'professional']);

    Assert::throws(\RuntimeException::class, static fn () => $authority->issueOffline($key, Kit::MACHINE_A, Kit::CLI), '/No signing key/');
});

test('revoking twice keeps the original date and reason; restoring undoes it', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);

    $first = $f['authority']->revoke($key, '  refund #1  ', Kit::CLI);
    $f['clock']->advance(Kit::DAY);
    $second = $f['authority']->revoke($key, 'chargeback', Kit::CLI);

    Assert::same(Kit::NOW, $second['revokedAt']);
    Assert::same('refund #1', $second['revokeReason']);
    Assert::same($first['revokedAt'], $second['revokedAt']);
    Assert::same(null, $f['authority']->restore($key, Kit::CLI)['revokedAt']);
    Assert::same('{"actor":"cli","revokedAt":' . Kit::NOW . ',"reason":"refund #1"}', $f['store']->listEvents($key, 1)[0]['detail']);
});

test('extends a term from its current end, or from today once it has lapsed', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional', 'days' => 10]);

    Assert::same(Kit::NOW + 40 * Kit::DAY, $f['authority']->extend($key, (object) ['days' => 30], Kit::CLI)['expiresAt']);
    $f['clock']->advance(100 * Kit::DAY);
    Assert::same(Kit::NOW + 130 * Kit::DAY, $f['authority']->extend($key, (object) ['days' => 30], Kit::CLI)['expiresAt']);
    Assert::same(Expiry::utc(2030, 1, 1, 23, 59, 59, 999), $f['authority']->extend($key, (object) ['expires' => '2030-01-01'], Kit::CLI)['expiresAt']);
    Assert::same(null, $f['authority']->extend($key, (object) ['perpetual' => true], Kit::CLI)['expiresAt']);
    Assert::refuses('invalid-argument', static fn () => $f['authority']->extend($key, (object) ['days' => 5, 'perpetual' => true], Kit::CLI), '/exactly one/');
    Assert::refuses('invalid-argument', static fn () => $f['authority']->extend($key, (object) ['weeks' => 5], Kit::CLI), '/weeks/');
});

test('extending lets an expired licence activate again', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional', 'days' => 1]);
    $f['clock']->advance(2 * Kit::DAY);
    Assert::refuses('expired', static fn () => activate($f, $key, Kit::MACHINE_A));

    $f['authority']->extend($key, (object) ['days' => 365], Kit::CLI);
    Assert::same(Kit::NOW + 367 * Kit::DAY, activate($f, $key, Kit::MACHINE_A)['claims']['expiresAt']);
});

test('releases one machine, and says when it never held a seat', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    activate($f, $key, Kit::MACHINE_A);

    Assert::same(true, $f['authority']->release($key, Kit::MACHINE_A, Kit::CLI));
    Assert::same(false, $f['authority']->release($key, Kit::MACHINE_A, Kit::CLI));
    Assert::refuses('not-found', static fn () => $f['authority']->release($key, Kit::MACHINE_B, Kit::CLI), '/never been activated/');
});

test('answers admin operations on a missing or malformed key with operator-facing errors', function (): void {
    $f = Kit::fixture();
    $missing = Assert::refuses('not-found', static fn () => $f['authority']->show(LicenseKey::generate(static fn (): int => 5)));
    Assert::same(404, $missing->status);
    $malformed = Assert::refuses('invalid-argument', static fn () => $f['authority']->revoke('RECX-12345', null, Kit::CLI));
    Assert::same(400, $malformed->status);
    Assert::matches('/^"RECX-12345" is not a well-formed licence key: That licence key is the wrong length/', $malformed->getMessage());
});

test('lists and filters licences, newest first', function (): void {
    $f = Kit::fixture();
    $jane = Kit::mint($f['authority'], ['edition' => 'professional', 'registeredTo' => 'Jane Doe', 'orderRef' => 'INV-1']);
    $f['clock']->advance(1000);
    $acme = Kit::mint($f['authority'], ['edition' => 'business', 'email' => 'it@acme.example', 'orderRef' => 'INV-2']);
    $f['clock']->advance(1000);
    $revoked = Kit::mint($f['authority'], ['edition' => 'business', 'days' => 1]);
    $f['authority']->revoke($revoked, null, Kit::CLI);
    activate($f, $acme, Kit::MACHINE_A);

    Assert::same([$revoked, $acme, $jane], array_column($f['authority']->list(), 'key'));
    Assert::same([$acme], array_column($f['authority']->list(['search' => 'acme']), 'key'));
    Assert::same([$jane], array_column($f['authority']->list(['search' => 'jane d']), 'key'));
    Assert::same([$acme], array_column($f['authority']->list(['search' => substr($acme, -7)]), 'key'));
    Assert::same([], array_column($f['authority']->list(['search' => '%']), 'key'));
    Assert::same([$revoked, $acme], array_column($f['authority']->list(['edition' => 'business']), 'key'));
    Assert::same([$jane], array_column($f['authority']->list(['orderRef' => 'INV-1']), 'key'));
    Assert::same([$revoked], array_column($f['authority']->list(['standing' => 'revoked']), 'key'));
    Assert::same([$acme], array_column($f['authority']->list(['limit' => 1, 'offset' => 1]), 'key'));
    Assert::same(1, $f['authority']->list(['search' => 'acme'])[0]['activeSeats']);
});

test('keeps the reference server’s schema, so the database can move to the Node server', function (): void {
    $f = Kit::fixture();
    $pdo = $f['store']->pdo;

    Assert::same(1, (int) $pdo->query('PRAGMA user_version')->fetchColumn());
    Assert::same('wal', strtolower((string) $pdo->query('PRAGMA journal_mode')->fetchColumn()));
    Assert::same(1, (int) $pdo->query('PRAGMA foreign_keys')->fetchColumn());
    $tables = $pdo->query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")->fetchAll(\PDO::FETCH_COLUMN);
    // The reference's three tables, and this server's private ones (outside user_version).
    Assert::same(['activations', 'events', 'housekeeping', 'licenses', 'login_attempts', 'orders', 'rate_limits'], $tables);

    // The schema's own constraints hold.
    Assert::throws(\PDOException::class, static fn () => $pdo->exec("INSERT INTO licenses (key, edition, created_at) VALUES ('K', 'free', 1)"));
    Assert::throws(\PDOException::class, static fn () => $pdo->exec("INSERT INTO licenses (key, edition, created_at, max_activations) VALUES ('K', 'business', 1, 0)"));
    Assert::throws(\PDOException::class, static fn () => $pdo->exec("INSERT INTO activations (key, machine_id, first_activated_at, last_activated_at) VALUES ('nope', 'M', 1, 1)"));
});

test('recognises a database locked by another request, which the API answers with 503', function (): void {
    $f = Kit::fixture();
    $impatient = Store::open($f['file'], 0);
    $other = new \PDO('sqlite:' . $f['file'], null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
    $other->exec('BEGIN IMMEDIATE');

    try {
        $error = Assert::throws(\PDOException::class, static fn () => $impatient->transaction(static fn () => null));
        Assert::true(Store::isBusy($error));
        Assert::true(Store::isBusy(new \RuntimeException('wrapped', 0, $error)));
        Assert::same(false, Store::isBusy(new \RuntimeException('database is fine')));
    } finally {
        $other->exec('ROLLBACK');
    }
});

// --- two requests at once -------------------------------------------------------------------
//
// PHP-FPM answers requests in parallel processes; `php -S`, which the contract
// suite serves through, answers one at a time, so only here do two requests
// overlap. Two connections to one file stand in for two processes, and one of
// them is stopped at the most dangerous moment — it has counted, and not yet
// written what the count allowed — while the other tries the same thing.

/**
 * A store that, the first time it has counted seats or moves, runs
 * `$interleave` before handing the count back — as the reference's tests do
 * with a Proxy around its store.
 */
final class PausingStore extends Store
{
    public ?\Closure $interleave = null;

    public function countActiveSeats(string $key): int
    {
        $counted = parent::countActiveSeats($key);
        $this->pause();

        return $counted;
    }

    public function countEventsAfter(string $key, string $type, int $after): int
    {
        $counted = parent::countEventsAfter($key, $type, $after);
        $this->pause();

        return $counted;
    }

    private function pause(): void
    {
        $interleave = $this->interleave;
        $this->interleave = null;
        if ($interleave !== null) {
            $interleave();
        }
    }
}

test('the last seat cannot go to two connections at once', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional']);
    $storeA = Store::open($f['file'], 50);
    $storeB = PausingStore::open($f['file'], 50);
    $authorityA = new Authority($storeA, $f['signer'], $f['clock']);
    $authorityB = new Authority($storeB, $f['signer'], $f['clock']);

    // B has counted one free seat and not yet taken it; A tries for it then.
    $raced = null;
    $storeB->interleave = static function () use (&$raced, $authorityA, $key): void {
        try {
            $raced = $authorityA->activate($key, Kit::MACHINE_A, Authority::PRODUCT_ID, Kit::CUSTOMER);
        } catch (\Throwable $error) {
            $raced = $error;
        }
    };

    $winner = $authorityB->activate($key, Kit::MACHINE_B, Authority::PRODUCT_ID, Kit::CUSTOMER);
    Assert::same(null, $storeB->interleave, 'B was stopped after counting');
    Assert::same(Kit::MACHINE_B, $winner['claims']['machine']);
    // A could not even begin while B held the write lock…
    Assert::true($raced instanceof \Throwable && Store::isBusy($raced), 'A is told the database is busy, not given the seat');
    // …so exactly one seat was taken, and A now gets the honest answer.
    Assert::same(1, $storeA->countActiveSeats($key));
    Assert::refuses('seats-exhausted', static fn () => $authorityA->activate($key, Kit::MACHINE_A, Authority::PRODUCT_ID, Kit::CUSTOMER));
});

test('the last allowed move cannot go to two releases at once', function (): void {
    $f = Kit::fixture(['limit' => 1]);
    $key = Kit::mint($f['authority'], ['edition' => 'business']);
    $tokenA = activate($f, $key, Kit::MACHINE_A)['token'];
    $tokenB = activate($f, $key, Kit::MACHINE_B)['token'];
    $storeA = Store::open($f['file'], 50);
    $storeB = PausingStore::open($f['file'], 50);
    $authorityA = new Authority($storeA, $f['signer'], $f['clock'], null, 1);
    $authorityB = new Authority($storeB, $f['signer'], $f['clock'], null, 1);

    // B has counted no moves yet and not yet released; A releases then.
    $raced = null;
    $storeB->interleave = static function () use (&$raced, $authorityA, $tokenA): void {
        try {
            $raced = $authorityA->deactivate($tokenA, Kit::CUSTOMER);
        } catch (\Throwable $error) {
            $raced = $error;
        }
    };

    Assert::same(true, $authorityB->deactivate($tokenB, Kit::CUSTOMER)['released']);
    Assert::same(null, $storeB->interleave, 'B was stopped after counting');
    Assert::true($raced instanceof \Throwable && Store::isBusy($raced), 'A is told the database is busy, not given the move');
    Assert::refuses('self-release-limit', static fn () => $authorityA->deactivate($tokenA, Kit::CUSTOMER));
    Assert::same(1, $storeA->countActiveSeats($key));
});

test('refuses a database written by a newer server release', function (): void {
    $f = Kit::fixture();
    $f['store']->pdo->exec('PRAGMA user_version = 99');

    Assert::throws(\RuntimeException::class, static fn () => Store::open($f['file']), '/schema version 99/');
});

test('backs the database up into a consistent snapshot', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'professional', 'registeredTo' => 'Jane']);
    activate($f, $key, Kit::MACHINE_A);

    $target = Kit::tempDir() . '/snapshot.db';
    $f['store']->snapshot($target);

    $copy = Store::open($target);
    Assert::same('Jane', $copy->getLicense($key)['registeredTo'] ?? null);
    Assert::same(1, $copy->countActiveSeats($key));
    Assert::throws(\RuntimeException::class, static fn () => $f['store']->snapshot($target), '/already exists/');
});

test('signs exactly the claims it returns', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'enterprise', 'registeredTo' => 'Ünïcødé GmbH']);
    $result = $f['authority']->issueOffline($key, Kit::MACHINE_A, Kit::CLI);
    [$payload] = explode('.', $result['token']);

    Assert::same(json_encode($result['claims'], TokenSigner::JSON_FLAGS), TokenSigner::base64urlDecode($payload));
    Assert::same('Ünïcødé GmbH', $result['claims']['registeredTo']);
});

// --- personal details ------------------------------------------------------------------------

test('corrects a licence’s personal details, which the next activation carries', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'business', 'registeredTo' => 'Jane Dough', 'email' => 'jane@example.com', 'notes' => 'VIP']);
    activate($f, $key, Kit::MACHINE_A);

    $licence = $f['authority']->updateDetails($key, (object) ['registeredTo' => '  Jane Doe ', 'email' => 'jane.doe@example.com']);
    Assert::same(['Jane Doe', 'jane.doe@example.com', null], [$licence['registeredTo'], $licence['email'], $licence['notes']]);
    Assert::same('Jane Doe', activate($f, $key, Kit::MACHINE_A)['claims']['registeredTo']);

    // The same rules as when it was created, and only for a licence that exists.
    Assert::refuses('invalid-argument', static fn () => $f['authority']->updateDetails($key, (object) ['email' => 'not an address']), '/email: Invalid email address/');
    Assert::refuses('invalid-argument', static fn () => $f['authority']->updateDetails($key, (object) ['name' => 'Jane']), '/name/');
    Assert::refuses('invalid-argument', static fn () => $f['authority']->updateDetails($key, (object) ['registeredTo' => str_repeat('x', 201)]));
    Assert::refuses('not-found', static fn () => $f['authority']->updateDetails(LicenseKey::generate(static fn (): int => 5), (object) []));
    Assert::refuses('not-found', static fn () => $f['authority']->erasePersonalDetails(LicenseKey::generate(static fn (): int => 5)));
    Assert::same('jane.doe@example.com', $f['store']->getLicense($key)['email']);
});

test('erases a licence’s personal details and the addresses in its history, keeping the licence working', function (): void {
    $f = Kit::fixture();
    $key = Kit::mint($f['authority'], ['edition' => 'business', 'registeredTo' => 'Jane Doe', 'email' => 'jane@example.com', 'notes' => 'called on 1 May', 'orderRef' => 'razorpay:pay_1', 'days' => 365]);
    activate($f, $key, Kit::MACHINE_A);
    activate($f, $key, Kit::MACHINE_B);
    $events = count($f['store']->listEvents($key, 100));

    $erased = $f['authority']->erasePersonalDetails($key);
    Assert::same(2, $erased['addresses']);
    Assert::same(false, $erased['orderRefErased']);
    $licence = $erased['license'];
    Assert::same([null, null, null, 'razorpay:pay_1'], [$licence['registeredTo'], $licence['email'], $licence['notes'], $licence['orderRef']]);
    Assert::same([], array_values(array_filter($f['store']->listEvents($key, 100), static fn (array $e): bool => $e['ip'] !== null)));
    Assert::same($events, count($f['store']->listEvents($key, 100)), 'what happened, and when, is kept');
    Assert::same(2, $f['store']->countActiveSeats($key));
    Assert::same(null, activate($f, $key, Kit::MACHINE_A)['claims']['registeredTo']);

    // Only what was recorded since is left to erase, and then nothing.
    Assert::same(1, $f['authority']->erasePersonalDetails($key)['addresses']);
    Assert::same(0, $f['authority']->erasePersonalDetails($key)['addresses']);
});

test('erases the order reference too once the sale’s records need no longer be kept', function (): void {
    $f = Kit::fixture();
    $expired = Kit::mint($f['authority'], ['edition' => 'professional', 'orderRef' => 'order-expired', 'days' => 30]);
    $revoked = Kit::mint($f['authority'], ['edition' => 'professional', 'orderRef' => 'order-revoked']);
    $perpetual = Kit::mint($f['authority'], ['edition' => 'professional', 'orderRef' => 'order-perpetual']);
    $f['authority']->revoke($revoked, 'refund', Kit::CLI);

    // One day short of eight years after the term ended: kept.
    $f['clock']->advance((30 + Authority::RECORDS_KEPT_DAYS) * Kit::DAY - 1);
    Assert::same(false, $f['authority']->erasePersonalDetails($expired)['orderRefErased']);
    Assert::same('order-expired', $f['store']->getLicense($expired)['orderRef']);

    $f['clock']->advance(1);
    Assert::same(true, $f['authority']->erasePersonalDetails($expired)['orderRefErased']);
    Assert::same(null, $f['store']->getLicense($expired)['orderRef']);
    Assert::same(true, $f['authority']->erasePersonalDetails($revoked)['orderRefErased']);
    // A licence that never ends is a sale still in use.
    Assert::same(false, $f['authority']->erasePersonalDetails($perpetual)['orderRefErased']);
    Assert::same('order-perpetual', $f['store']->getLicense($perpetual)['orderRef']);
});

test('erasing a licence’s personal details deletes the website order behind it', function (): void {
    $f = Kit::fixture();
    $order = $f['store']->insertOrder([
        'edition' => 'business', 'quantity' => 1, 'name' => 'Jane Doe', 'email' => 'jane@example.com', 'phoneCountry' => 'IN',
        'phone' => '+91 9876543210', 'registerTo' => '', 'gstin' => '', 'message' => '',
    ], null, Kit::NOW);
    $f['store']->insertOrder([
        'edition' => 'business', 'quantity' => 1, 'name' => 'Someone Else', 'email' => 'else@example.com', 'phoneCountry' => 'IN',
        'phone' => '+91 9876500000', 'registerTo' => '', 'gstin' => '', 'message' => '',
    ], null, Kit::NOW);
    $key = Kit::mint($f['authority'], ['edition' => 'business', 'email' => 'jane@example.com', 'orderRef' => $order['ref'], 'days' => 365]);

    Assert::same(1, $f['authority']->erasePersonalDetails($key)['orders']);
    Assert::same(null, $f['store']->getOrder($order['id']));
    Assert::same(1, (int) $f['store']->pdo->query('SELECT COUNT(*) FROM orders')->fetchColumn(), 'other orders stay');
    Assert::same($order['ref'], $f['store']->getLicense($key)['orderRef'], 'the reference stays for the accounts');
});

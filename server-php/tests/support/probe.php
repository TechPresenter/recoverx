<?php

/*
 * Parity probe: answers questions about the PHP implementation as JSON, so
 * the contract-parity test (tests/unit/server/php-contract.test.ts) can put
 * the same inputs to this server and to the TypeScript reference and compare.
 *
 *   echo '[{"op":"validateKey","input":"recx…"}]' | php -d extension=sodium tests/support/probe.php
 *
 * Reads a JSON array of requests on stdin and writes a JSON array of answers,
 * one per request, in order. Never deployed.
 */

declare(strict_types=1);

require dirname(__DIR__, 2) . '/app/bootstrap.php';

use RecoverX\Licensing\EventRetention;
use RecoverX\Licensing\Expiry;
use RecoverX\Licensing\LicenseError;
use RecoverX\Licensing\LicenseKey;
use RecoverX\Licensing\Messages;
use RecoverX\Licensing\RateLimiter;
use RecoverX\Licensing\SigningKey;
use RecoverX\Licensing\Store;

$requests = json_decode((string) stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);

$answer = static function (array $request): mixed {
    switch ($request['op']) {
        case 'validateKey':
            return LicenseKey::validate($request['input']);
        case 'normalizeKeyInput':
            return LicenseKey::normalize($request['input']);
        case 'formatKey':
            return LicenseKey::format($request['input']);
        case 'maskKey':
            return LicenseKey::mask($request['input']);
        case 'completeKey':
            return LicenseKey::complete($request['input']);
        case 'generateKeys':
            return array_map(static fn (): string => LicenseKey::generate(), range(1, $request['count']));
        case 'generateKeyFromPicks':
            $picks = $request['picks'];
            $index = 0;

            return LicenseKey::generate(static function () use ($picks, &$index): int {
                return $picks[$index++] ?? 0;
            });
        case 'parseExpiry':
            try {
                return ['ok' => true, 'value' => Expiry::parseDate($request['input'])];
            } catch (LicenseError $error) {
                return ['ok' => false, 'error' => $error->getMessage()];
            }
        case 'clientBucketId':
            return RateLimiter::clientBucketId($request['input']);
        case 'formatCustomerDate':
            return Messages::formatCustomerDate($request['input']);
        case 'keyFromPem':
            $key = SigningKey::fromPem($request['pem']);

            return ['publicKey' => $key->publicKeySpki(), 'fingerprint' => $key->fingerprint(), 'pem' => $key->toPem()];
        case 'retention':
            // A throwaway in-memory database holding events at the given
            // instants, pruned at a fixed "now".
            $store = Store::open(':memory:');
            foreach ($request['events'] as $at) {
                $store->recordEvent(['at' => $at, 'type' => 'activated', 'key' => null, 'machineId' => null, 'ip' => null, 'detail' => null]);
            }
            try {
                $retention = new EventRetention($store, $request['days'], $request['windowDays'], static fn (): int => $request['now']);
            } catch (RangeException $error) {
                return ['ok' => false, 'error' => $error->getMessage()];
            }
            $result = $retention->prune();

            return [
                'ok' => true,
                'cutoff' => $result['cutoff'],
                'deleted' => $result['deleted'],
                'remaining' => array_map('intval', $store->pdo->query('SELECT at FROM events ORDER BY at, id')->fetchAll(PDO::FETCH_COLUMN)),
            ];
        case 'messages':
            $static = (new \ReflectionClass(Messages::class))->getConstants();
            unset($static['SUPPORT'], $static['WEBSITE']);

            return [
                'static' => $static,
                'expired' => Messages::expired('12 December 2026'),
                'seatsExhausted' => [Messages::seatsExhausted(1), Messages::seatsExhausted(3)],
                'selfReleaseLimit' => [
                    Messages::selfReleaseLimit(1, 365),
                    Messages::selfReleaseLimit(2, 730),
                    Messages::selfReleaseLimit(3, 30),
                    Messages::selfReleaseLimit(4, 1),
                ],
                'keyProblems' => array_map(
                    static fn (?string $problem): string => Messages::describeKeyProblem($problem),
                    [null, 'empty', 'wrong-product', 'wrong-length', 'bad-character', 'checksum'],
                ),
            ];
        default:
            throw new InvalidArgumentException("Unknown probe op {$request['op']}");
    }
};

echo json_encode(array_map($answer, $requests), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

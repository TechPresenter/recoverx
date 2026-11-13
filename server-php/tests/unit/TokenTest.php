<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\SigningKey;
use RecoverX\Licensing\TokenSigner;

/*
 * The signing key encodings and the activation token format. The
 * contract-parity test verifies PHP-issued tokens with the desktop client's
 * own verifier; these cases pin the pieces underneath.
 */

/** RFC 8032 §7.1, test 1: the empty message. */
const RFC8032_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC8032_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const RFC8032_SIGNATURE = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

function claims(array $overrides = []): array
{
    return array_merge([
        'v' => 1,
        'edition' => 'business',
        'key' => 'RECX-ABCDE-FGHJK-12345-MNPQR',
        'machine' => Kit::MACHINE_A,
        'issuedAt' => Kit::NOW,
        'expiresAt' => Kit::NOW + 365 * Kit::DAY,
        'registeredTo' => 'Contoso Ltd',
    ], $overrides);
}

test('signs exactly as RFC 8032 specifies Ed25519', function (): void {
    $key = SigningKey::fromSeed((string) hex2bin(RFC8032_SEED));

    Assert::same(RFC8032_PUBLIC, bin2hex($key->publicKey));
    Assert::same(RFC8032_SIGNATURE, bin2hex($key->sign('')));
    Assert::true($key->verify((string) hex2bin(RFC8032_SIGNATURE), ''));
    Assert::true(!$key->verify((string) hex2bin(RFC8032_SIGNATURE), 'x'));
    Assert::true(!$key->verify('short', ''));
});

test('writes and reads the PKCS#8 PEM that npm run licensing:keys produces', function (): void {
    $key = SigningKey::fromSeed((string) hex2bin(RFC8032_SEED));
    $pem = $key->toPem();

    // The DER is the fixed Ed25519 PrivateKeyInfo prefix followed by the seed.
    Assert::same("-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/Vpguo"
        . "RK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n", $pem);

    $again = SigningKey::fromPem($pem);
    Assert::same(bin2hex($key->publicKey), bin2hex($again->publicKey));

    // A PEM pasted from an environment variable, with literal \n sequences.
    $escaped = SigningKey::fromPem(str_replace("\n", '\\n', $pem));
    Assert::same(bin2hex($key->publicKey), bin2hex($escaped->publicKey));
});

test('reads the PKCS#8 v2 form that carries the public key too', function (): void {
    $key = SigningKey::fromSeed((string) hex2bin(RFC8032_SEED));
    $der = hex2bin('3051020101300506032b657004220420') . hex2bin(RFC8032_SEED) . hex2bin('812100') . $key->publicKey;
    $pem = "-----BEGIN PRIVATE KEY-----\n" . chunk_split(base64_encode((string) $der), 64, "\n") . "-----END PRIVATE KEY-----\n";

    Assert::same(RFC8032_PUBLIC, bin2hex(SigningKey::fromPem($pem)->publicKey));

    $tampered = hex2bin('3051020101300506032b657004220420') . hex2bin(RFC8032_SEED) . hex2bin('812100') . str_repeat("\0", 32);
    $bad = "-----BEGIN PRIVATE KEY-----\n" . base64_encode((string) $tampered) . "\n-----END PRIVATE KEY-----\n";
    Assert::throws(\InvalidArgumentException::class, static fn () => SigningKey::fromPem($bad), '/inconsistent/');
});

test('explains why a PEM is not a usable signing key', function (): void {
    Assert::throws(\InvalidArgumentException::class, static fn () => SigningKey::fromPem('hello'), '/not a PEM private key/');
    Assert::throws(\InvalidArgumentException::class, static fn () => SigningKey::fromPem("-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----"), '/public key/');
    Assert::throws(\InvalidArgumentException::class, static fn () => SigningKey::fromPem("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----"), '/passphrase/');
    // An RSA-shaped PKCS#8 body.
    Assert::throws(\InvalidArgumentException::class, static fn () => SigningKey::fromPem("-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8\n-----END PRIVATE KEY-----"), '/not an Ed25519 key/');
    Assert::throws(\InvalidArgumentException::class, static fn () => SigningKey::fromPem("-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----"), '/base64/');
});

test('encodes the public key as SPKI DER and fingerprints it like the reference', function (): void {
    $key = SigningKey::fromSeed((string) hex2bin(RFC8032_SEED));
    $spki = $key->publicKeySpki();

    Assert::same('302a300506032b6570032100' . RFC8032_PUBLIC, bin2hex((string) base64_decode($spki, true)));
    Assert::matches('/^SHA256:[A-Za-z0-9+\/]{43}$/', $key->fingerprint());
    Assert::same('SHA256:' . rtrim(base64_encode(hash('sha256', (string) base64_decode($spki), true)), '='), $key->fingerprint());
    Assert::same($key->fingerprint(), SigningKey::fingerprintOf(" {$spki}\n"));
});

test('issues payload.signature over the encoded payload, with claims in the fixed order', function (): void {
    $signer = new TokenSigner(SigningKey::generate());
    $token = $signer->issue(claims(['registeredTo' => 'Ünïcødé GmbH / Ltd' . "\u{2028}"]));
    [$payload, $signature] = explode('.', $token);

    Assert::same(
        '{"v":1,"edition":"business","key":"RECX-ABCDE-FGHJK-12345-MNPQR","machine":"' . Kit::MACHINE_A
        . '","issuedAt":' . Kit::NOW . ',"expiresAt":' . (Kit::NOW + 365 * Kit::DAY) . ',"registeredTo":"Ünïcødé GmbH / Ltd' . "\u{2028}" . '"}',
        TokenSigner::base64urlDecode($payload),
    );
    Assert::matches('/^[A-Za-z0-9_-]+$/', $payload);
    Assert::matches('/^[A-Za-z0-9_-]{86}$/', $signature);
    Assert::true($signer->key()->verify(TokenSigner::base64urlDecode($signature), $payload));
});

test('verifies its own tokens and returns the claims', function (): void {
    $signer = new TokenSigner(SigningKey::generate());
    $token = $signer->issue(claims(['expiresAt' => null, 'registeredTo' => null]));

    $check = $signer->verifySignature("  {$token}\n");
    Assert::same(true, $check['ok']);
    Assert::same(claims(['expiresAt' => null, 'registeredTo' => null]), $check['claims']);
});

test('tells a forged token from an unreadable one', function (): void {
    $signer = new TokenSigner(SigningKey::generate());
    $other = new TokenSigner(SigningKey::generate());
    $token = $signer->issue(claims());
    [$payload, $signature] = explode('.', $token);

    Assert::same(['ok' => false, 'failure' => 'bad-signature'], $other->verifySignature($token));

    $altered = TokenSigner::base64url(str_replace('"business"', '"enterprise"', TokenSigner::base64urlDecode($payload)));
    Assert::same(['ok' => false, 'failure' => 'bad-signature'], $signer->verifySignature("{$altered}.{$signature}"));
    Assert::same(['ok' => false, 'failure' => 'bad-signature'], $signer->verifySignature("{$payload}.AAAA"));

    foreach (['', 'not-a-token', "{$token}.extra", "{$payload}.", ".{$signature}", "{$payload}.{$signature}!", str_repeat('A', 4097)] as $malformed) {
        Assert::same(['ok' => false, 'failure' => 'malformed'], $signer->verifySignature($malformed), $malformed === '' ? '(empty)' : substr($malformed, 0, 30));
    }
});

test('refuses claims the client would reject, both when signing and when reading', function (): void {
    $signer = new TokenSigner(SigningKey::generate());

    foreach ([['v' => 2], ['edition' => 'ultimate'], ['key' => ''], ['machine' => ''], ['expiresAt' => 'soon'], ['registeredTo' => 7]] as $bad) {
        Assert::throws(\InvalidArgumentException::class, static fn () => $signer->issue(claims($bad)));
    }

    // Validly signed, but the claims are not ActivationClaims.
    $payload = TokenSigner::base64url('{"v":2,"edition":"business"}');
    $token = $payload . '.' . TokenSigner::base64url($signer->key()->sign($payload));
    Assert::same(['ok' => false, 'failure' => 'bad-claims'], $signer->verifySignature($token));

    $payload = TokenSigner::base64url('[1,2,3]');
    $token = $payload . '.' . TokenSigner::base64url($signer->key()->sign($payload));
    Assert::same(['ok' => false, 'failure' => 'bad-claims'], $signer->verifySignature($token));
});

test('decodes base64url leniently, as Node does', function (): void {
    Assert::same('hello', TokenSigner::base64urlDecode('aGVsbG8'));
    Assert::same('hello', TokenSigner::base64urlDecode('aGVsbG8='));
    Assert::same("\xfb\xff", TokenSigner::base64urlDecode('-_8'));
});

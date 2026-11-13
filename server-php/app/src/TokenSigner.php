<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * Activation tokens: `base64url(JSON claims) "." base64url(Ed25519 signature)`,
 * the signature covering the ASCII bytes of the *encoded* payload string.
 *
 * The other half of src/main/licensing/activation-token.ts, and the format
 * must match it byte for byte; src/server/signing.ts is the reference issuer.
 * Claims are encoded field by field in a fixed order, with integer epoch
 * milliseconds and the same escaping `JSON.stringify` uses, so a token from
 * this server is indistinguishable from one the reference would issue at the
 * same instant. The contract-parity test verifies every token this server
 * issues with the desktop client's own verifier.
 */
final class TokenSigner
{
    public const EDITIONS = ['free', 'professional', 'business', 'technician', 'enterprise'];

    /** Tokens never come near this size; the bound keeps a hostile one cheap. */
    private const MAX_TOKEN_LENGTH = 4096;

    public const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS;

    public function __construct(private readonly SigningKey $key)
    {
    }

    public function key(): SigningKey
    {
        return $this->key;
    }

    /**
     * Sign claims into a token the desktop client will accept.
     *
     * The claims are re-checked even though every caller builds them itself:
     * a token the client would reject as `bad-claims` is worse than an error
     * here, because the customer would be told their paid licence is not
     * genuine.
     *
     * @param array{v: int, edition: string, key: string, machine: string, issuedAt: int, expiresAt: ?int, registeredTo: ?string} $claims
     */
    public function issue(array $claims): string
    {
        $problem = self::claimsProblem((object) $claims);
        if ($problem !== null) {
            throw new \InvalidArgumentException("Refusing to sign invalid claims: {$problem}");
        }

        $ordered = [
            'v' => $claims['v'],
            'edition' => $claims['edition'],
            'key' => $claims['key'],
            'machine' => $claims['machine'],
            'issuedAt' => $claims['issuedAt'],
            'expiresAt' => $claims['expiresAt'],
            'registeredTo' => $claims['registeredTo'],
        ];

        $payload = self::base64url(json_encode($ordered, self::JSON_FLAGS | JSON_THROW_ON_ERROR));

        return $payload . '.' . self::base64url($this->key->sign($payload));
    }

    /**
     * Check that a token was signed by this key and return its claims.
     *
     * Ignores expiry and machine binding on purpose: it exists for
     * deactivation, where an expired licence must still be able to give its
     * seat back. The signature is checked before a single claim is read.
     *
     * @return array{ok: true, claims: array<string, mixed>}|array{ok: false, failure: string}
     */
    public function verifySignature(string $token): array
    {
        $trimmed = Js::trim($token);
        if ($trimmed === '' || Js::length($trimmed) > self::MAX_TOKEN_LENGTH) {
            return ['ok' => false, 'failure' => 'malformed'];
        }

        $parts = explode('.', $trimmed);
        if (
            count($parts) !== 2
            || preg_match('/^[A-Za-z0-9_-]+$/D', $parts[0]) !== 1
            || preg_match('/^[A-Za-z0-9_-]+$/D', $parts[1]) !== 1
        ) {
            return ['ok' => false, 'failure' => 'malformed'];
        }

        [$payload, $signature] = $parts;

        if (!$this->key->verify(self::base64urlDecode($signature), $payload)) {
            return ['ok' => false, 'failure' => 'bad-signature'];
        }

        $claims = json_decode(self::base64urlDecode($payload), false, 512, JSON_INVALID_UTF8_SUBSTITUTE);
        if (!$claims instanceof \stdClass || self::claimsProblem($claims) !== null) {
            return ['ok' => false, 'failure' => 'bad-claims'];
        }

        return ['ok' => true, 'claims' => get_object_vars($claims)];
    }

    /**
     * Why a decoded claims object is not `ActivationClaimsSchema`, or `null`.
     * Extra fields are allowed, as zod's non-strict object allows them.
     */
    public static function claimsProblem(\stdClass $claims): ?string
    {
        $number = static fn (mixed $value): bool => is_int($value) || (is_float($value) && is_finite($value));

        return match (true) {
            ($claims->v ?? null) !== 1 => 'v must be 1',
            !in_array($claims->edition ?? null, self::EDITIONS, true) => 'unknown edition',
            !is_string($claims->key ?? null) || $claims->key === '' => 'key must be a non-empty string',
            !is_string($claims->machine ?? null) || $claims->machine === '' => 'machine must be a non-empty string',
            !$number($claims->issuedAt ?? null) => 'issuedAt must be a number',
            !property_exists($claims, 'expiresAt') || ($claims->expiresAt !== null && !$number($claims->expiresAt)) => 'expiresAt must be a number or null',
            !property_exists($claims, 'registeredTo') || ($claims->registeredTo !== null && !is_string($claims->registeredTo)) => 'registeredTo must be a string or null',
            default => null,
        };
    }

    public static function base64url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    /** Lenient, like Node's `Buffer.from(text, 'base64url')`. */
    public static function base64urlDecode(string $text): string
    {
        $standard = strtr($text, '-_', '+/');
        $remainder = strlen($standard) % 4;
        if ($remainder === 1) {
            // A dangling sixth of a byte carries no data; Node drops it too.
            $standard = substr($standard, 0, -1);
        } elseif ($remainder > 1) {
            $standard .= str_repeat('=', 4 - $remainder);
        }

        $decoded = base64_decode($standard, false);

        return $decoded === false ? '' : $decoded;
    }
}

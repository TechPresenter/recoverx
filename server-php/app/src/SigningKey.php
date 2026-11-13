<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * The Ed25519 signing key, in the encodings the rest of the system uses.
 *
 *  - On disk (`data/signing.key`) and in backups: a PKCS#8 PEM, exactly what
 *    `npm run licensing:keys` writes and what the Node reference server loads
 *    from LICENSE_SIGNING_KEY_FILE. A key can therefore move between the two
 *    servers in either direction.
 *  - In desktop builds: the public key as SPKI DER, base64
 *    (RECOVERX_LICENSE_PUBLIC_KEY).
 *  - In logs and on screens: an SSH-style `SHA256:…` fingerprint.
 *
 * Both DER structures for Ed25519 are fixed-length, so they are built and
 * parsed as a constant prefix plus the raw key — no ASN.1 library needed, and
 * nothing to misparse.
 */
final class SigningKey
{
    /** PKCS#8 v1 `PrivateKeyInfo` for Ed25519, up to the 32-byte seed. */
    private const PKCS8_PREFIX = '302e020100300506032b657004220420';

    /** PKCS#8 v2 `OneAsymmetricKey` (seed, then `[1]` public key), as OpenSSL 3 can emit. */
    private const PKCS8_V2_PREFIX = '3051020101300506032b657004220420';

    private const PKCS8_V2_PUBLIC_TAG = '812100';

    /** SPKI `SubjectPublicKeyInfo` for Ed25519, up to the 32-byte public key. */
    private const SPKI_PREFIX = '302a300506032b6570032100';

    /**
     * The 64-byte libsodium secret key (seed ‖ public key). Nullable only
     * because `sodium_memzero` sets what it wipes to null when the key is
     * destroyed.
     */
    private ?string $secretKey;

    /** The raw 32-byte public key. */
    public readonly string $publicKey;

    private function __construct(#[\SensitiveParameter] string $secretKey)
    {
        $this->secretKey = $secretKey;
        $this->publicKey = sodium_crypto_sign_publickey_from_secretkey($secretKey);
    }

    public function __destruct()
    {
        if ($this->secretKey !== null && function_exists('sodium_memzero')) {
            sodium_memzero($this->secretKey);
        }
    }

    /** A fresh key from the operating system's CSPRNG. */
    public static function generate(): self
    {
        $pair = sodium_crypto_sign_keypair();

        return new self(sodium_crypto_sign_secretkey($pair));
    }

    public static function fromSeed(#[\SensitiveParameter] string $seed): self
    {
        if (strlen($seed) !== SODIUM_CRYPTO_SIGN_SEEDBYTES) {
            throw new \InvalidArgumentException('An Ed25519 seed is 32 bytes.');
        }

        $pair = sodium_crypto_sign_seed_keypair($seed);

        return new self(sodium_crypto_sign_secretkey($pair));
    }

    /**
     * Read a PKCS#8 PEM private key and insist that it is Ed25519.
     *
     * Accepts the PEM with its line breaks written as literal `\n` sequences,
     * as the reference server does, because that is how a key pasted from an
     * environment variable often arrives.
     */
    public static function fromPem(#[\SensitiveParameter] string $pem): self
    {
        $text = str_contains($pem, "\n") ? $pem : str_replace('\\n', "\n", $pem);

        if (preg_match('/-----BEGIN PRIVATE KEY-----(.+?)-----END PRIVATE KEY-----/s', $text, $match) !== 1) {
            $kind = preg_match('/-----BEGIN ([A-Z0-9 ]+)-----/', $text, $label) === 1 ? $label[1] : null;

            throw new \InvalidArgumentException(match ($kind) {
                null => 'That is not a PEM private key. Use the license-signing-key.pem file written by `npm run licensing:keys`.',
                'PUBLIC KEY' => 'That is the public key. Setup needs the private key: the license-signing-key.pem file written by `npm run licensing:keys`.',
                'ENCRYPTED PRIVATE KEY' => 'That private key is encrypted with a passphrase. Export it unencrypted (PKCS#8) and try again.',
                default => "That is a {$kind}, but RecoverX activations are signed with an Ed25519 key in PKCS#8 form (BEGIN PRIVATE KEY).",
            });
        }

        $der = base64_decode(preg_replace('/\s+/', '', $match[1]) ?? '', true);
        if ($der === false) {
            throw new \InvalidArgumentException('The private key PEM is damaged: its body is not valid base64.');
        }

        $prefix = hex2bin(self::PKCS8_PREFIX);
        if (strlen($der) === 48 && str_starts_with($der, $prefix)) {
            return self::fromSeed(substr($der, 16));
        }

        $v2 = hex2bin(self::PKCS8_V2_PREFIX);
        $tag = hex2bin(self::PKCS8_V2_PUBLIC_TAG);
        if (strlen($der) === 83 && str_starts_with($der, $v2) && substr($der, 48, 3) === $tag) {
            $key = self::fromSeed(substr($der, 16, 32));
            if (!hash_equals($key->publicKey, substr($der, 51, 32))) {
                throw new \InvalidArgumentException('The private key PEM is inconsistent: its public half does not match its seed.');
            }

            return $key;
        }

        throw new \InvalidArgumentException(
            'That private key is not an Ed25519 key. RecoverX activations are signed with Ed25519; use the key written by `npm run licensing:keys`.',
        );
    }

    /** PKCS#8 PEM, byte-identical to Node's `privateKey.export({ format: 'pem', type: 'pkcs8' })`. */
    public function toPem(): string
    {
        $der = hex2bin(self::PKCS8_PREFIX) . substr($this->secret(), 0, SODIUM_CRYPTO_SIGN_SEEDBYTES);

        return "-----BEGIN PRIVATE KEY-----\n"
            . chunk_split(base64_encode($der), 64, "\n")
            . "-----END PRIVATE KEY-----\n";
    }

    /** The public key as SPKI DER, base64: the RECOVERX_LICENSE_PUBLIC_KEY build value. */
    public function publicKeySpki(): string
    {
        return self::spkiOf($this->publicKey);
    }

    public function fingerprint(): string
    {
        return self::fingerprintOf($this->publicKeySpki());
    }

    public static function spkiOf(string $rawPublicKey): string
    {
        return base64_encode(hex2bin(self::SPKI_PREFIX) . $rawPublicKey);
    }

    /** `SHA256:` and the unpadded base64 SHA-256 of the SPKI DER, as the reference prints it. */
    public static function fingerprintOf(string $spkiBase64): string
    {
        $der = base64_decode(preg_replace('/\s+/', '', $spkiBase64) ?? '', false);

        return 'SHA256:' . rtrim(base64_encode(hash('sha256', $der === false ? '' : $der, true)), '=');
    }

    /** Ed25519 signature over `$message`. */
    public function sign(string $message): string
    {
        return sodium_crypto_sign_detached($message, $this->secret());
    }

    private function secret(): string
    {
        if ($this->secretKey === null) {
            throw new \LogicException('The signing key has been wiped.');
        }

        return $this->secretKey;
    }

    public function verify(string $signature, string $message): bool
    {
        if (strlen($signature) !== SODIUM_CRYPTO_SIGN_BYTES) {
            return false;
        }

        try {
            return sodium_crypto_sign_verify_detached($signature, $message, $this->publicKey);
        } catch (\SodiumException) {
            return false;
        }
    }

    /** Debug output never shows the secret. */
    public function __debugInfo(): array
    {
        return ['fingerprint' => $this->fingerprint()];
    }
}

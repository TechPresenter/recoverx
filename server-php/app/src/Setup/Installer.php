<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Setup;

use RecoverX\Licensing\Config;
use RecoverX\Licensing\Files;
use RecoverX\Licensing\Paths;
use RecoverX\Licensing\SigningKey;
use RecoverX\Licensing\Store;

/**
 * The installation steps, shared by the /setup/ page and the command-line
 * provisioning tool the tests use — so the tests exercise a server set up
 * exactly the way the vendor's is.
 *
 * Order matters: the data folder, then the signing key (kept if one already
 * exists — replacing it would invalidate every licence ever sold), then the
 * database, then the configuration, and only then the lock that switches
 * /setup/ off. An installation interrupted half-way leaves no lock, so setup
 * can simply be run again.
 */
final class Installer
{
    public function __construct(private readonly Paths $paths)
    {
    }

    /** Create the private data folder and its sub-folders. */
    public function prepareDataDirectory(): void
    {
        Files::ensurePrivateDirectory($this->paths->dataDir);
        Files::ensurePrivateDirectory($this->paths->logDir());
        Files::ensurePrivateDirectory($this->paths->sessionDir());
        Files::ensurePrivateDirectory($this->paths->tmpDir());
    }

    public function hasSigningKey(): bool
    {
        return is_file($this->paths->signingKeyFile());
    }

    /** The existing signing key, for a re-run of setup that keeps it. */
    public function existingKey(): ?SigningKey
    {
        if (!$this->hasSigningKey()) {
            return null;
        }

        $pem = @file_get_contents($this->paths->signingKeyFile());

        return $pem === false ? null : SigningKey::fromPem($pem);
    }

    /**
     * Install.
     *
     * @param ?string $importPem a PKCS#8 PEM to use instead of generating a key; ignored when a key exists
     * @param array<string, mixed> $settings overrides of Config::DEFAULTS
     * @param ?string $apiToken an admin API token to enable the JSON admin API with
     * @return array{key: SigningKey, generated: bool, kept: bool}
     */
    public function install(
        #[\SensitiveParameter] string $adminPassword,
        #[\SensitiveParameter] ?string $importPem,
        string $siteUrl,
        array $settings = [],
        #[\SensitiveParameter] ?string $apiToken = null,
    ): array {
        $this->prepareDataDirectory();

        $kept = false;
        $generated = false;
        $key = $this->existingKey();

        if ($key !== null) {
            $kept = true;
        } else {
            if ($importPem !== null && trim($importPem) !== '') {
                $key = SigningKey::fromPem($importPem);
            } else {
                $key = SigningKey::generate();
                $generated = true;
            }

            // Written once and never rewritten: no atomic replace needed, and
            // refusing to overwrite protects a key that appeared meanwhile.
            $file = $this->paths->signingKeyFile();
            $handle = @fopen($file, 'xb');
            if ($handle === false) {
                throw new \RuntimeException("Could not create {$file}: a signing key may already exist, or the folder is not writable.");
            }
            fwrite($handle, $key->toPem());
            fclose($handle);
            @chmod($file, 0600);
        }

        // Creates and migrates the database; an existing one is kept as is,
        // except that failed admin sign-ins are forgotten: whoever can run
        // setup controls the server anyway, and this is the way back in when
        // someone else's guesses have locked the sign-in page.
        Store::open($this->paths->databaseFile())->clearLoginFailures(null);

        $previous = [];
        if (is_file($this->paths->configFile())) {
            $loaded = (static fn (string $path): mixed => include $path)($this->paths->configFile());
            $previous = is_array($loaded) ? $loaded : [];
        }

        $storedSettings = array_merge(
            Config::DEFAULTS,
            isset($previous['settings']) && is_array($previous['settings']) ? $previous['settings'] : [],
            $settings,
        );
        Config::validate($storedSettings);

        Config::write($this->paths, [
            'version' => 1,
            'created_at' => $previous['created_at'] ?? gmdate('c'),
            'updated_at' => gmdate('c'),
            'site_url' => $siteUrl,
            'admin_password_hash' => Config::hashPassword($adminPassword),
            'api_token_hash' => $apiToken !== null ? Config::hashApiToken($apiToken) : ($previous['api_token_hash'] ?? null),
            'settings' => $storedSettings,
        ]);

        Files::writeAtomically(
            $this->paths->lockFile(),
            json_encode(['setUpAt' => gmdate('c'), 'fingerprint' => $key->fingerprint()], JSON_UNESCAPED_SLASHES) . "\n",
            0600,
        );

        @unlink($this->paths->setupCodeFile());

        return ['key' => $key, 'generated' => $generated, 'kept' => $kept];
    }

    /**
     * The one-time setup code, created on first use and kept in the data
     * folder where only someone with File Manager access can read it.
     *
     * Setup is reachable by anyone until it completes. The code is what stops
     * a stranger who finds /setup/ first from completing it with their own
     * password and key: they would need to read a file on the server.
     */
    public function setupCode(): string
    {
        $file = $this->paths->setupCodeFile();
        $existing = @file_get_contents($file);
        if (is_string($existing) && preg_match('/^([0-9A-Z]{5}(?:-[0-9A-Z]{5}){3})$/m', $existing, $match) === 1) {
            return $match[1];
        }

        $alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
        $groups = [];
        for ($group = 0; $group < 4; $group += 1) {
            $chunk = '';
            for ($index = 0; $index < 5; $index += 1) {
                $chunk .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            $groups[] = $chunk;
        }
        $code = implode('-', $groups);

        Files::writeAtomically(
            $file,
            "RecoverX licence server — one-time setup code\n\n{$code}\n\n"
            . "Type this code into the setup page. It is deleted automatically when setup completes.\n",
            0600,
        );

        return $code;
    }

    /** Compare a typed setup code with the stored one, forgiving case, spaces and missing hyphens. */
    public function checkSetupCode(string $typed): bool
    {
        $file = $this->paths->setupCodeFile();
        if (!is_file($file)) {
            return false;
        }

        $expected = str_replace('-', '', $this->setupCode());
        $given = strtoupper(preg_replace('/[^0-9A-Za-z]/', '', $typed) ?? '');

        return $given !== '' && hash_equals($expected, $given);
    }
}

<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

use RecoverX\Licensing\Mail\SesMailer;

/**
 * The server's configuration: `data/config.php`, written by /setup/ (and by
 * the admin panel when the password or the API token changes), overlaid with
 * the optional `config.local.php` an operator edits by hand.
 *
 * `config.php` is PHP that returns an array, written with `var_export` — so it
 * can never be fetched as text even if the data folder were exposed, and
 * nothing user-supplied is ever executed. It holds two secrets, both hashed:
 * the admin password (`password_hash`) and the admin API token (SHA-256).
 *
 * Settings are validated as strictly as the reference server validates its
 * environment: a half-valid configuration fails later and worse.
 */
final class Config
{
    public const DEFAULTS = [
        // A proxy or CDN in front adds the client's address to the end of
        // X-Forwarded-For: true takes it from there, a number N takes it N
        // places from the end (N proxies, each adding one). Only when a CDN
        // makes every customer arrive from its address; see README.
        'trust_proxy' => false,
        'rate_limit_burst' => 20,
        'rate_limit_per_minute' => 30,
        'self_release_limit' => 4,
        'self_release_window_days' => 365,
        // Days the activation event log — which holds customers' IP
        // addresses — is kept before it is deleted. The privacy policy
        // promises 13 months. Never shorter than the window above, which is
        // counted from the same log.
        'event_retention_days' => EventRetention::DEFAULT_DAYS,
        // Minutes of inactivity after which the admin panel signs out.
        'admin_idle_minutes' => 30,
        // Let the admin panel and setup run over plain HTTP from a
        // non-local address. Only for a host whose HTTPS is not detected.
        'allow_insecure_admin' => false,
        // E-mailing licence keys to customers from the admin panel, through
        // Amazon SES with the EC2 server's IAM role (no keys stored). Off
        // while mail_from is empty. See README → Settings.
        'mail_from' => '',
        'mail_from_name' => 'RecoverX',
        'mail_reply_to' => '',
        'ses_region' => '',
        // Who receives the website's order form (/order/): up to 5 addresses.
        // Empty: mail_reply_to. Needs e-mail switched on (mail_from).
        'order_notify_to' => [],
    ];

    /** The most addresses `order_notify_to` may list. */
    public const MAX_ORDER_RECIPIENTS = 5;

    /** The most proxies `trust_proxy` may count. */
    public const MAX_PROXY_HOPS = 10;

    /** [min, max] for every integer setting. */
    private const RANGES = [
        'rate_limit_burst' => [1, 100_000],
        'rate_limit_per_minute' => [1, 1_000_000],
        'self_release_limit' => [0, 1_000_000],
        'self_release_window_days' => [1, 3650],
        'event_retention_days' => [1, Expiry::MAX_TERM_DAYS],
        'admin_idle_minutes' => [5, 1440],
    ];

    /** Minimum admin password length. */
    public const MIN_PASSWORD_LENGTH = 12;

    /**
     * @param array<string, mixed> $settings validated settings
     * @param array<string, mixed> $document the stored document, as written
     */
    private function __construct(
        public readonly array $settings,
        public readonly array $document,
    ) {
    }

    public static function exists(Paths $paths): bool
    {
        return is_file($paths->configFile());
    }

    public static function load(Paths $paths): self
    {
        $file = $paths->configFile();
        if (!is_file($file)) {
            throw new ConfigError('The licence server is not set up yet: open /setup/ to set it up.');
        }

        $document = (static fn (string $path): mixed => include $path)($file);
        if (!is_array($document) || !isset($document['admin_password_hash']) || !is_string($document['admin_password_hash'])) {
            throw new ConfigError("{$file} is damaged: it does not hold the expected settings. Restore it from a backup, or re-run /setup/.");
        }

        $local = Paths::readLocalConfig($paths->localConfigFile());
        unset($local['data_dir']);

        $stored = isset($document['settings']) && is_array($document['settings']) ? $document['settings'] : [];

        return new self(self::validate(array_merge(self::DEFAULTS, $stored, $local)), $document);
    }

    /**
     * Validate settings, reporting every problem at once.
     *
     * @param array<string, mixed> $settings
     * @return array<string, mixed>
     */
    public static function validate(array $settings): array
    {
        $problems = [];
        $result = [];

        foreach (self::DEFAULTS as $name => $default) {
            $value = $settings[$name] ?? $default;

            if ($name === 'trust_proxy') {
                if (!is_bool($value) && !(is_int($value) && $value >= 1 && $value <= self::MAX_PROXY_HOPS)) {
                    $problems[] = 'trust_proxy must be true, false or the number of proxies in front, from 1 to ' . self::MAX_PROXY_HOPS;
                    continue;
                }
            } elseif (is_bool($default)) {
                if (!is_bool($value)) {
                    $problems[] = "{$name} must be true or false";
                    continue;
                }
            } elseif (is_array($default)) {
                $problem = "{$name} must be a list of up to " . self::MAX_ORDER_RECIPIENTS . " e-mail addresses, such as ['sales@example.com']";
                if (!is_array($value) || !array_is_list($value) || count($value) > self::MAX_ORDER_RECIPIENTS) {
                    $problems[] = $problem;
                    continue;
                }
                foreach ($value as $address) {
                    if (!is_string($address) || !SesMailer::isAddress($address)) {
                        $problems[] = $problem;
                        continue 2;
                    }
                }
            } elseif (is_string($default)) {
                $problem = is_string($value) ? self::textProblem($name, $value) : "{$name} must be text in quotes";
                if ($problem !== null) {
                    $problems[] = $problem;
                    continue;
                }
            } else {
                [$min, $max] = self::RANGES[$name];
                if (!is_int($value) || $value < $min || $value > $max) {
                    $problems[] = "{$name} must be a whole number from {$min} to {$max}";
                    continue;
                }
            }

            $result[$name] = $value;
        }

        foreach (array_keys($settings) as $name) {
            if (!array_key_exists($name, self::DEFAULTS)) {
                $problems[] = "{$name} is not a setting this server knows";
            }
        }

        // Deleting events younger than the release window would forget moves
        // the allowance still has to count, and quietly raise the limit.
        $retention = $result['event_retention_days'] ?? null;
        $window = $result['self_release_window_days'] ?? null;
        if (is_int($retention) && is_int($window) && $retention < $window) {
            $problems[] = "event_retention_days ({$retention}) must be at least self_release_window_days ({$window}), "
                . 'because self-service moves are counted from the event log';
        }

        if (($result['mail_from'] ?? '') !== '' && ($result['ses_region'] ?? '') === '') {
            $problems[] = 'ses_region must be set (for example \'ap-south-1\') when mail_from is';
        }

        if ($problems !== []) {
            throw new ConfigError('The licence server configuration is invalid: ' . implode('; ', $problems) . '.');
        }

        return $result;
    }

    /** What is wrong with a text setting, or `null`. */
    private static function textProblem(string $name, string $value): ?string
    {
        return match ($name) {
            'mail_from', 'mail_reply_to' => $value === '' || SesMailer::isAddress($value)
                ? null : "{$name} must be one e-mail address, such as 'licences@example.com', or '' for none",
            // Shown in the From line: plain letters only, so it never needs quoting or encoding.
            'mail_from_name' => preg_match('/^[A-Za-z0-9][A-Za-z0-9 .\-]{0,63}$/D', $value) === 1
                ? null : 'mail_from_name must be 1 to 64 letters, digits, spaces, dots or hyphens',
            'ses_region' => $value === '' || preg_match('/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/D', $value) === 1
                ? null : "ses_region must be an AWS region such as 'ap-south-1'",
            default => null,
        };
    }

    /** How many X-Forwarded-For entries, counted from the end, proxies in front have added: 0 when none is trusted. */
    public function proxyHops(): int
    {
        $trust = $this->settings['trust_proxy'];

        return $trust === true ? 1 : ($trust === false ? 0 : (int) $trust);
    }

    public function adminPasswordHash(): string
    {
        return $this->document['admin_password_hash'];
    }

    /** SHA-256 (hex) of the admin API token, or `null` when the API is disabled. */
    public function apiTokenHash(): ?string
    {
        $hash = $this->document['api_token_hash'] ?? null;

        return is_string($hash) && preg_match('/^[0-9a-f]{64}$/D', $hash) === 1 ? $hash : null;
    }

    public function siteUrl(): ?string
    {
        $url = $this->document['site_url'] ?? null;

        return is_string($url) && $url !== '' ? $url : null;
    }

    /** @param array<string, mixed> $changes */
    public function withDocument(array $changes): self
    {
        return new self($this->settings, array_merge($this->document, $changes));
    }

    /**
     * Write `data/config.php` atomically, readable by its owner only.
     *
     * Written to a temporary file and renamed into place, so a request never
     * reads half a configuration; then evicted from OPcache, which would
     * otherwise keep serving the previous version of the file.
     *
     * @param array<string, mixed> $document
     */
    public static function write(Paths $paths, array $document): void
    {
        $code = "<?php\n\n"
            . "// RecoverX licence server configuration.\n"
            . "// Written by /setup/ and the admin panel. Hand edits belong in ../config.local.php.\n"
            . "// The admin password and API token are stored as one-way hashes only.\n\n"
            . 'return ' . var_export($document, true) . ";\n";

        Files::writeAtomically($paths->configFile(), $code, 0600);

        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($paths->configFile(), true);
        }
    }

    /** Hash a new admin API token for storage. */
    public static function hashApiToken(string $token): string
    {
        return hash('sha256', $token);
    }

    /** A new admin API token: 32 random bytes, base64url (43 characters). */
    public static function newApiToken(): string
    {
        return TokenSigner::base64url(random_bytes(32));
    }

    /** Why a proposed admin password is not acceptable, or `null`. */
    public static function passwordProblem(string $password, string $confirmation): ?string
    {
        if (!Js::isUtf8($password)) {
            return 'The password contains characters that could not be read.';
        }

        if (Js::length($password) < self::MIN_PASSWORD_LENGTH) {
            return 'Choose a password of at least ' . self::MIN_PASSWORD_LENGTH . ' characters.';
        }

        if (strlen($password) > 1024) {
            return 'That password is too long.';
        }

        if (!hash_equals($password, $confirmation)) {
            return 'The two passwords do not match.';
        }

        return null;
    }

    public static function hashPassword(#[\SensitiveParameter] string $password): string
    {
        return password_hash($password, PASSWORD_DEFAULT);
    }
}

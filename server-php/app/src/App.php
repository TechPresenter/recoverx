<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

use RecoverX\Licensing\Mail\InstanceRoleCredentials;
use RecoverX\Licensing\Mail\SesMailer;

/**
 * The assembled server for one request: configuration, database, signing key
 * and the services built on them, each created on first use.
 *
 * Lazy because PHP builds all of this again for every request: a health check
 * needs the database but not the signing key, an unknown address needs
 * neither, and the setup page must run before any of them exist.
 */
final class App
{
    private ?Config $config = null;

    private ?Store $store = null;

    private ?TokenSigner $signer = null;

    private ?Authority $authority = null;

    private ?Logger $logger = null;

    private ?SesMailer $mailer = null;

    /** @var callable(): int */
    private $clock;

    /** @param null|callable(): int $clock epoch milliseconds; tests pass a fake */
    public function __construct(public readonly Paths $paths, ?callable $clock = null)
    {
        $this->clock = $clock ?? Authority::systemClock(...);
    }

    public function now(): int
    {
        return ($this->clock)();
    }

    /** Whether /setup/ has completed: configuration, key and lock all present. */
    public function isSetUp(): bool
    {
        return is_file($this->paths->lockFile())
            && is_file($this->paths->configFile())
            && is_file($this->paths->signingKeyFile());
    }

    public function config(): Config
    {
        return $this->config ??= Config::load($this->paths);
    }

    /** Forget the cached configuration after it has been rewritten. */
    public function reloadConfig(): Config
    {
        $this->config = null;

        return $this->config();
    }

    public function store(): Store
    {
        if ($this->store === null) {
            if (!$this->isSetUp()) {
                throw new ConfigError('The licence server is not set up yet: open /setup/ to set it up.');
            }
            $this->store = Store::open($this->paths->databaseFile());
        }

        return $this->store;
    }

    public function signer(): TokenSigner
    {
        if ($this->signer === null) {
            $file = $this->paths->signingKeyFile();
            $pem = @file_get_contents($file);
            if ($pem === false) {
                throw new ConfigError("The signing key {$file} could not be read. Restore it from your backup.");
            }

            try {
                $this->signer = new TokenSigner(SigningKey::fromPem($pem));
            } catch (\InvalidArgumentException $error) {
                throw new ConfigError("The signing key {$file} is not usable: {$error->getMessage()}", 0, $error);
            }
        }

        return $this->signer;
    }

    public function authority(): Authority
    {
        if ($this->authority === null) {
            $settings = $this->config()->settings;
            $this->authority = new Authority(
                $this->store(),
                $this->signer(),
                $this->clock,
                null,
                $settings['self_release_limit'],
                $settings['self_release_window_days'],
            );
        }

        return $this->authority;
    }

    public function eventRetention(): EventRetention
    {
        $settings = $this->config()->settings;

        return new EventRetention(
            $this->store(),
            $settings['event_retention_days'],
            $settings['self_release_window_days'],
            $this->clock,
            $this->paths->logDir(),
            $this->rateLimiter(),
        );
    }

    /**
     * Periodic work, run after a request has been answered, because shared
     * hosting offers no scheduler the server can count on. Today that is the
     * daily event-retention pass (`EventRetention::pruneIfDue`).
     *
     * Never fails the request it rides on: the response has already been
     * sent, and whatever goes wrong is logged and tried again on a later
     * request. Before the work starts the session is closed, so the visitor's
     * next page does not wait for its lock, and — where the server supports
     * it (PHP-FPM, LiteSpeed) — the connection is finished, so the visitor
     * does not wait either.
     */
    public function housekeeping(): void
    {
        try {
            if (!$this->isSetUp()) {
                return;
            }

            $retention = $this->eventRetention();
            if (!$retention->isDue()) {
                return;
            }

            self::finishResponse();
            $result = $retention->pruneIfDue();
            if ($result !== null) {
                $this->logger()->info('Pruned the event log', ['via' => 'daily'] + $retention->logFields($result));
            }
        } catch (ConfigError) {
            // An unusable configuration fails the request itself, which logs it.
        } catch (\Throwable $error) {
            try {
                $this->logger()->error('Pruning the event log failed; a later request will try again', ['error' => $error]);
            } catch (\Throwable) {
                // Nothing left to tell; the request was answered regardless.
            }
        }
    }

    /** Let the visitor go before slow work: close the session and, where possible, the connection. */
    private static function finishResponse(): void
    {
        if (PHP_SAPI === 'cli') {
            return;
        }

        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }

        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        }
    }

    /**
     * The mailer for licence e-mails, or `null` while e-mail is off
     * (`mail_from` is empty). Credentials are fetched when a message is sent,
     * not here, so showing a page never touches the metadata service.
     */
    public function mailer(): ?SesMailer
    {
        if ($this->mailer !== null) {
            return $this->mailer;
        }

        $settings = $this->config()->settings;
        if ($settings['mail_from'] === '') {
            return null;
        }

        $credentials = new InstanceRoleCredentials();

        return $this->mailer = new SesMailer(
            $settings['ses_region'],
            $settings['mail_from'],
            $settings['mail_from_name'],
            $settings['mail_reply_to'] === '' ? null : $settings['mail_reply_to'],
            $credentials->get(...),
            null,
            $this->clock,
        );
    }

    /** Tests: send through this mailer instead of Amazon SES. */
    public function useMailer(SesMailer $mailer): void
    {
        $this->mailer = $mailer;
    }

    public function rateLimiter(): RateLimiter
    {
        $settings = $this->config()->settings;

        return new RateLimiter(
            $this->store(),
            $settings['rate_limit_burst'],
            $settings['rate_limit_per_minute'],
            $this->clock,
        );
    }

    public function logger(): Logger
    {
        return $this->logger ??= new Logger(
            is_dir($this->paths->dataDir) ? $this->paths->logDir() : null,
            $this->clock,
        );
    }
}

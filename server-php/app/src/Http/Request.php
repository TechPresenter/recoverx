<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Http;

use RecoverX\Licensing\Js;

/**
 * An HTTP request, decoupled from PHP's superglobals so the API and the admin
 * panel can be driven in-process by the unit tests.
 */
final class Request
{
    /** @var null|callable(int): ?string */
    private $bodyReader;

    /**
     * @param array<string, string> $headers lower-case names
     * @param array<string, mixed> $form decoded `application/x-www-form-urlencoded` fields
     * @param array<string, string> $cookies
     * @param null|callable(int): ?string $bodyReader reads at most the limit; `null` when the body is longer
     */
    public function __construct(
        public readonly string $method,
        public readonly string $uri,
        public readonly array $headers = [],
        public readonly string $remoteAddress = 'unknown',
        public readonly bool $https = false,
        ?callable $bodyReader = null,
        public readonly array $form = [],
        public readonly array $cookies = [],
        public readonly ?string $documentRoot = null,
    ) {
        $this->bodyReader = $bodyReader;
    }

    /** A request with a fixed body, for tests. */
    public static function create(string $method, string $uri, array $headers = [], ?string $body = null, string $remoteAddress = '127.0.0.1', array $form = [], array $cookies = []): self
    {
        $normalised = [];
        foreach ($headers as $name => $value) {
            $normalised[strtolower($name)] = $value;
        }
        if ($body !== null && !isset($normalised['content-length'])) {
            $normalised['content-length'] = (string) strlen($body);
        }

        $reader = static fn (int $limit): ?string => strlen($body ?? '') > $limit ? null : ($body ?? '');

        return new self(strtoupper($method), $uri, $normalised, $remoteAddress, false, $reader, $form, $cookies);
    }

    public static function fromGlobals(): self
    {
        $headers = [];
        foreach ($_SERVER as $name => $value) {
            if (!is_string($value)) {
                continue;
            }
            if (str_starts_with($name, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($name, 5)))] = $value;
            }
        }

        foreach (['CONTENT_TYPE' => 'content-type', 'CONTENT_LENGTH' => 'content-length'] as $server => $header) {
            if (isset($_SERVER[$server]) && is_string($_SERVER[$server]) && $_SERVER[$server] !== '') {
                $headers[$header] = $_SERVER[$server];
            }
        }

        // Apache and LiteSpeed often withhold Authorization from PHP; the
        // .htaccess copies it into REDIRECT_HTTP_AUTHORIZATION, and
        // getallheaders() sees it under mod_php.
        if (!isset($headers['authorization'])) {
            $redirected = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
            if (is_string($redirected) && $redirected !== '') {
                $headers['authorization'] = $redirected;
            } elseif (function_exists('getallheaders')) {
                foreach (getallheaders() as $name => $value) {
                    if (strtolower((string) $name) === 'authorization' && is_string($value)) {
                        $headers['authorization'] = $value;
                    }
                }
            }
        }

        $method = strtoupper(is_string($_SERVER['REQUEST_METHOD'] ?? null) ? $_SERVER['REQUEST_METHOD'] : 'GET');
        $uri = is_string($_SERVER['REQUEST_URI'] ?? null) ? $_SERVER['REQUEST_URI'] : '/';
        $remote = is_string($_SERVER['REMOTE_ADDR'] ?? null) && $_SERVER['REMOTE_ADDR'] !== '' ? $_SERVER['REMOTE_ADDR'] : 'unknown';

        $reader = static function (int $limit): ?string {
            $stream = @fopen('php://input', 'rb');
            if ($stream === false) {
                return '';
            }
            $data = stream_get_contents($stream, $limit + 1);
            fclose($stream);
            if ($data === false) {
                return '';
            }

            return strlen($data) > $limit ? null : $data;
        };

        $form = [];
        foreach ($_POST as $name => $value) {
            $form[(string) $name] = $value;
        }

        $cookies = [];
        foreach ($_COOKIE as $name => $value) {
            if (is_string($value)) {
                $cookies[(string) $name] = $value;
            }
        }

        $root = is_string($_SERVER['DOCUMENT_ROOT'] ?? null) ? $_SERVER['DOCUMENT_ROOT'] : null;

        return new self($method, $uri, $headers, $remote, self::detectHttps(), $reader, $form, $cookies, $root);
    }

    /**
     * Whether the visitor reached the site over HTTPS.
     *
     * Behind Hostinger's CDN the TLS connection may end at the CDN, which then
     * says so in X-Forwarded-Proto. A forged header could only make this
     * server believe a plain-HTTP connection is secure, which protects nobody
     * the forger could attack; the check exists to stop the vendor signing in
     * over plain HTTP by mistake.
     */
    private static function detectHttps(): bool
    {
        $https = $_SERVER['HTTPS'] ?? '';
        if (is_string($https) && $https !== '' && strtolower($https) !== 'off') {
            return true;
        }

        $checks = [
            ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https',
            ($_SERVER['HTTP_X_FORWARDED_SSL'] ?? '') === 'on',
            ($_SERVER['REQUEST_SCHEME'] ?? '') === 'https',
            (string) ($_SERVER['SERVER_PORT'] ?? '') === '443',
        ];

        return in_array(true, $checks, true);
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /** The path, without query or fragment, with backslashes and dot segments resolved as a URL parser would. */
    public function path(): string
    {
        $path = explode('#', explode('?', $this->uri, 2)[0], 2)[0];
        if (preg_match('#^[a-z][a-z0-9+.-]*://[^/]*#i', $path, $match) === 1) {
            $path = substr($path, strlen($match[0]));
        }
        $path = str_replace('\\', '/', $path);
        if ($path === '' || $path[0] !== '/') {
            $path = '/' . $path;
        }

        return self::removeDotSegments($path);
    }

    public function queryString(): string
    {
        $parts = explode('?', explode('#', $this->uri, 2)[0], 2);

        return $parts[1] ?? '';
    }

    /**
     * Query parameters the way `Object.fromEntries(new URLSearchParams(q))`
     * reads them: `+` is a space, the last of repeated names wins, and names
     * are taken literally (PHP's `$_GET` would turn `a.b` into `a_b`).
     *
     * @return array<string, string>
     */
    public function query(): array
    {
        $result = [];
        foreach (explode('&', $this->queryString()) as $pair) {
            if ($pair === '') {
                continue;
            }
            $parts = explode('=', $pair, 2);
            $result[self::formDecode($parts[0])] = self::formDecode($parts[1] ?? '');
        }

        return $result;
    }

    /** The declared Content-Length, or `null` when absent or not a number. */
    public function declaredLength(): ?int
    {
        $raw = $this->header('content-length');
        if ($raw === null || preg_match('/^\s*\d+\s*$/D', $raw) !== 1) {
            return null;
        }

        return (int) trim($raw);
    }

    /** The body, or `null` when it is longer than `$limit` bytes. */
    public function body(int $limit): ?string
    {
        return $this->bodyReader === null ? '' : ($this->bodyReader)($limit);
    }

    public function isLoopback(): bool
    {
        return in_array($this->remoteAddress, ['127.0.0.1', '::1', '::ffff:127.0.0.1'], true);
    }

    /** A form field as a string (`''` when absent or not a string). */
    public function field(string $name): string
    {
        $value = $this->form[$name] ?? '';

        return is_string($value) ? $value : '';
    }

    private static function formDecode(string $text): string
    {
        $decoded = rawurldecode(str_replace('+', ' ', $text));

        return Js::isUtf8($decoded) ? $decoded : self::scrub($decoded);
    }

    /** Replace invalid UTF-8 with U+FFFD, as a JavaScript decoder does. */
    public static function scrub(string $text): string
    {
        $encoded = json_encode($text, JSON_INVALID_UTF8_SUBSTITUTE);
        $decoded = $encoded === false ? null : json_decode($encoded);

        return is_string($decoded) ? $decoded : '';
    }

    /** RFC 3986 §5.2.4, also treating `%2e` as a dot, as the WHATWG URL parser does. */
    private static function removeDotSegments(string $path): string
    {
        $segments = explode('/', $path);
        $output = [];
        $last = count($segments) - 1;

        foreach ($segments as $index => $segment) {
            $lower = strtolower($segment);
            if (in_array($lower, ['.', '%2e'], true)) {
                if ($index === $last) {
                    $output[] = '';
                }
                continue;
            }
            if (in_array($lower, ['..', '.%2e', '%2e.', '%2e%2e'], true)) {
                if (count($output) > 1) {
                    array_pop($output);
                }
                if ($index === $last) {
                    $output[] = '';
                }
                continue;
            }
            $output[] = $segment;
        }

        $result = implode('/', $output);

        return $result === '' || $result[0] !== '/' ? '/' . $result : $result;
    }
}

<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Http;

use RecoverX\Licensing\TokenSigner;

/** An HTTP response: a status, headers and a body, sent in one place. */
final class Response
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly array $headers = [],
    ) {
    }

    /**
     * A JSON response with the headers every licence-server reply carries:
     * no caching anywhere (tokens and licence details must not sit in a CDN
     * or proxy cache) and no content sniffing.
     *
     * @param array<string, string> $headers
     */
    public static function json(int $status, mixed $data, array $headers = []): self
    {
        $body = json_encode($data, TokenSigner::JSON_FLAGS | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);

        return new self($status, $body, [
            'Content-Type' => 'application/json; charset=utf-8',
            'Content-Length' => (string) strlen($body),
            'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
        ] + $headers);
    }

    /** @param array<string, string> $headers */
    public function withHeaders(array $headers): self
    {
        return new self($this->status, $this->body, $headers + $this->headers);
    }

    public function header(string $name): ?string
    {
        foreach ($this->headers as $key => $value) {
            if (strcasecmp($key, $name) === 0) {
                return $value;
            }
        }

        return null;
    }

    /** Emit through PHP's SAPI. A HEAD request gets the headers only. */
    public function send(bool $headOnly = false): void
    {
        if (!headers_sent()) {
            header_remove('X-Powered-By');
            http_response_code($this->status);
            foreach ($this->headers as $name => $value) {
                header($name . ': ' . str_replace(["\r", "\n"], '', $value), true);
            }
        }

        if (!$headOnly) {
            echo $this->body;
        }
    }
}

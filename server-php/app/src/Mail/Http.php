<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

/**
 * The smallest HTTP client that will do: PHP's own stream wrapper, so the
 * server still needs no cURL extension and no Composer packages.
 *
 * Certificates are always verified. Redirects are not followed (neither
 * Amazon SES nor the EC2 metadata service sends one that should be). The
 * timeout covers connecting as well as reading, so an address that never
 * answers — the metadata service on a server that is not EC2 — costs
 * seconds, not a minute.
 */
final class Http
{
    /**
     * @param array<string, string> $headers
     * @return array{status: int, body: string}
     */
    public static function request(string $method, string $url, array $headers, string $body, float $timeoutSeconds): array
    {
        $lines = [];
        foreach ($headers as $name => $value) {
            if (preg_match('/[\r\n]/', $name . $value) === 1) {
                throw new MailError("The HTTP header {$name} contains a line break.");
            }
            $lines[] = "{$name}: {$value}";
        }

        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $lines),
                'content' => $body,
                'timeout' => $timeoutSeconds,
                'ignore_errors' => true,
                'follow_location' => 0,
                'max_redirects' => 1,
            ],
            'ssl' => [
                'verify_peer' => true,
                'verify_peer_name' => true,
            ],
        ]);

        $previous = ini_get('default_socket_timeout');
        ini_set('default_socket_timeout', (string) max(1, (int) ceil($timeoutSeconds)));
        try {
            $stream = @fopen($url, 'rb', false, $context);
        } finally {
            ini_set('default_socket_timeout', $previous === false ? '60' : $previous);
        }

        if ($stream === false) {
            $host = parse_url($url, PHP_URL_HOST);
            throw new MailError('Could not connect to ' . (is_string($host) ? $host : 'the server') . '.');
        }

        try {
            $meta = stream_get_meta_data($stream);
            $content = stream_get_contents($stream);
        } finally {
            fclose($stream);
        }

        $status = 0;
        foreach ($meta['wrapper_data'] ?? [] as $line) {
            if (is_string($line) && preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $match) === 1) {
                $status = (int) $match[1];
            }
        }

        if ($status === 0 || $content === false) {
            throw new MailError('The answer from ' . (string) parse_url($url, PHP_URL_HOST) . ' could not be read.');
        }

        return ['status' => $status, 'body' => $content];
    }
}

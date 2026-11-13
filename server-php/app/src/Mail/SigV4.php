<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

/**
 * AWS Signature Version 4, for the one kind of request this server makes: a
 * POST with a JSON body to a fixed path, no query string.
 *
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
final class SigV4
{
    /**
     * The headers to send: the given ones (which must include Host), plus
     * X-Amz-Date, X-Amz-Security-Token for temporary credentials, and
     * Authorization. Every header given is signed.
     *
     * `$path` and `$query` must already be in canonical (URI-encoded) form.
     *
     * @param array<string, string> $headers
     * @param array{accessKeyId: string, secretAccessKey: string, sessionToken: ?string} $credentials
     * @return array<string, string>
     */
    public static function sign(
        string $method,
        string $path,
        string $query,
        array $headers,
        string $body,
        string $region,
        string $service,
        #[\SensitiveParameter] array $credentials,
        int $epochSeconds,
    ): array {
        $amzDate = gmdate('Ymd\THis\Z', $epochSeconds);
        $date = substr($amzDate, 0, 8);

        $headers['X-Amz-Date'] = $amzDate;
        if ($credentials['sessionToken'] !== null) {
            $headers['X-Amz-Security-Token'] = $credentials['sessionToken'];
        }

        $canonical = [];
        foreach ($headers as $name => $value) {
            $canonical[strtolower($name)] = (string) preg_replace('/\s+/', ' ', trim($value));
        }
        ksort($canonical, SORT_STRING);

        $signedHeaders = implode(';', array_keys($canonical));
        $canonicalHeaders = '';
        foreach ($canonical as $name => $value) {
            $canonicalHeaders .= "{$name}:{$value}\n";
        }

        $canonicalRequest = "{$method}\n{$path}\n{$query}\n{$canonicalHeaders}\n{$signedHeaders}\n" . hash('sha256', $body);
        $scope = "{$date}/{$region}/{$service}/aws4_request";
        $stringToSign = "AWS4-HMAC-SHA256\n{$amzDate}\n{$scope}\n" . hash('sha256', $canonicalRequest);

        $key = hash_hmac('sha256', $date, 'AWS4' . $credentials['secretAccessKey'], true);
        $key = hash_hmac('sha256', $region, $key, true);
        $key = hash_hmac('sha256', $service, $key, true);
        $key = hash_hmac('sha256', 'aws4_request', $key, true);
        $signature = hash_hmac('sha256', $stringToSign, $key);

        $headers['Authorization'] = "AWS4-HMAC-SHA256 Credential={$credentials['accessKeyId']}/{$scope}, "
            . "SignedHeaders={$signedHeaders}, Signature={$signature}";

        return $headers;
    }
}

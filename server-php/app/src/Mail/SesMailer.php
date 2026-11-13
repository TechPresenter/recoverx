<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

/**
 * Sends a plain-text e-mail through Amazon SES (API v2, `SendEmail`), signed
 * with the EC2 server's role credentials.
 *
 * Plain text only: a licence key and four lines of instructions need no HTML,
 * and plain text cannot carry a tracking pixel or hide a link.
 */
final class SesMailer
{
    private const PATH = '/v2/email/outbound-emails';

    /** The longest SES error text shown in the admin panel. */
    private const MAX_ERROR_LENGTH = 300;

    /** @var callable(): array{accessKeyId: string, secretAccessKey: string, sessionToken: ?string} */
    private $credentials;

    /** @var callable(string, string, array<string, string>, string, float): array{status: int, body: string} */
    private $http;

    /** @var callable(): int */
    private $clock;

    /**
     * @param callable(): array{accessKeyId: string, secretAccessKey: string, sessionToken: ?string} $credentials
     * @param null|callable(string, string, array<string, string>, string, float): array{status: int, body: string} $http
     * @param null|callable(): int $clock epoch milliseconds
     */
    public function __construct(
        public readonly string $region,
        public readonly string $fromAddress,
        public readonly string $fromName,
        public readonly ?string $replyTo,
        callable $credentials,
        ?callable $http = null,
        ?callable $clock = null,
    ) {
        $this->credentials = $credentials;
        $this->http = $http ?? Http::request(...);
        $this->clock = $clock ?? static fn (): int => (int) floor(microtime(true) * 1000);
    }

    /** Whether `$address` is one e-mail address and nothing else (no name, no second address, no line break). */
    public static function isAddress(string $address): bool
    {
        return strlen($address) <= 254 && filter_var($address, FILTER_VALIDATE_EMAIL) !== false;
    }

    /** The From line customers see, e.g. `RecoverX <licences@snapkio.com>`. */
    public function fromLine(): string
    {
        return "{$this->fromName} <{$this->fromAddress}>";
    }

    /**
     * Send one message to one address.
     *
     * @return string the SES message id
     */
    public function send(string $to, string $subject, string $text): string
    {
        if (!self::isAddress($to)) {
            throw new MailError('"' . $to . '" is not an e-mail address that can be sent to.');
        }

        $payload = [
            'FromEmailAddress' => $this->fromLine(),
            'Destination' => ['ToAddresses' => [$to]],
            'Content' => ['Simple' => [
                'Subject' => ['Data' => $subject, 'Charset' => 'UTF-8'],
                'Body' => ['Text' => ['Data' => $text, 'Charset' => 'UTF-8']],
            ]],
        ];
        if ($this->replyTo !== null) {
            $payload['ReplyToAddresses'] = [$this->replyTo];
        }

        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $host = "email.{$this->region}.amazonaws.com";
        $headers = SigV4::sign(
            'POST',
            self::PATH,
            '',
            ['Host' => $host, 'Content-Type' => 'application/json'],
            $body,
            $this->region,
            'ses',
            ($this->credentials)(),
            intdiv(($this->clock)(), 1000),
        );

        try {
            $response = ($this->http)('POST', "https://{$host}" . self::PATH, $headers, $body, 15.0);
        } catch (MailError $error) {
            throw new MailError("Amazon SES could not be reached ({$error->getMessage()}). Nothing was sent; try again in a minute.", 0, $error);
        }

        $decoded = json_decode($response['body'], true);
        if ($response['status'] === 200 && is_array($decoded) && is_string($decoded['MessageId'] ?? null)) {
            return $decoded['MessageId'];
        }

        throw new MailError(self::explain($response['status'], is_array($decoded) ? $decoded : []));
    }

    /** @param array<string, mixed> $error SES's JSON error document */
    private static function explain(int $status, array $error): string
    {
        $message = $error['message'] ?? $error['Message'] ?? null;
        $text = is_string($message) && $message !== '' ? trim($message) : "HTTP {$status}";
        if (strlen($text) > self::MAX_ERROR_LENGTH) {
            $text = substr($text, 0, self::MAX_ERROR_LENGTH) . '…';
        }

        $hint = '';
        if (stripos($text, 'not verified') !== false) {
            $hint = ' While Amazon SES is in its sandbox (until AWS approves production access), it only delivers to addresses verified in SES.';
        } elseif ($status === 403) {
            $hint = ' Check that the server’s IAM role may send from this address (deploy/aws-ec2/README.md → E-mail).';
        }

        return "Amazon SES did not send the e-mail: {$text}{$hint}";
    }
}

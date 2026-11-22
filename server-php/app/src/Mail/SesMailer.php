<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

/**
 * Sends an e-mail through Amazon SES (API v2, `SendEmail`, "Simple" content),
 * signed with the EC2 server's role credentials.
 *
 * Every message has a complete plain-text part: it is what text-only clients
 * show and what spam filters compare. An HTML part (built with EmailHtml) may
 * go with it as the styled view of the same words; SES then builds
 * multipart/alternative. Neither part loads anything remote, so there is no
 * tracking pixel and no image to block.
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
     * Send one message to one or more addresses. `$replyTo` overrides the
     * configured Reply-To for this message (an order notification is answered
     * to the customer, not to ourselves). `$html`, when given, goes alongside
     * `$text` as the HTML alternative (Body.Html next to Body.Text, both
     * UTF-8); `$text` must still say everything on its own.
     *
     * @param string|list<string> $to
     * @param null|string $html a whole HTML document, every value in it escaped (EmailHtml)
     * @return string the SES message id
     */
    public function send(string|array $to, string $subject, string $text, ?string $replyTo = null, ?string $html = null): string
    {
        $recipients = is_array($to) ? array_values($to) : [$to];
        if ($recipients === [] || count($recipients) > 50) {
            throw new MailError('An e-mail needs between 1 and 50 recipients.');
        }
        foreach ($recipients as $address) {
            if (!is_string($address) || !self::isAddress($address)) {
                throw new MailError('"' . (is_string($address) ? $address : gettype($address)) . '" is not an e-mail address that can be sent to.');
            }
        }

        $reply = $replyTo ?? $this->replyTo;
        if ($reply !== null && !self::isAddress($reply)) {
            throw new MailError('"' . $reply . '" is not an e-mail address replies can go to.');
        }

        if (preg_match('/[\x00-\x1F\x7F]/', $subject) === 1) {
            throw new MailError('An e-mail subject cannot contain line breaks or control characters.');
        }

        $body = ['Text' => ['Data' => $text, 'Charset' => 'UTF-8']];
        if ($html !== null && $html !== '') {
            $body['Html'] = ['Data' => $html, 'Charset' => 'UTF-8'];
        }

        $payload = [
            'FromEmailAddress' => $this->fromLine(),
            'Destination' => ['ToAddresses' => $recipients],
            'Content' => ['Simple' => [
                'Subject' => ['Data' => $subject, 'Charset' => 'UTF-8'],
                'Body' => $body,
            ]],
        ];
        if ($reply !== null) {
            $payload['ReplyToAddresses'] = [$reply];
        }

        $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $host = "email.{$this->region}.amazonaws.com";
        $headers = SigV4::sign(
            'POST',
            self::PATH,
            '',
            ['Host' => $host, 'Content-Type' => 'application/json'],
            $json,
            $this->region,
            'ses',
            ($this->credentials)(),
            intdiv(($this->clock)(), 1000),
        );

        try {
            $response = ($this->http)('POST', "https://{$host}" . self::PATH, $headers, $json, 15.0);
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

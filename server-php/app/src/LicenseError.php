<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * A request the licensing rules refused.
 *
 * Each refusal maps to exactly one HTTP status, defined here rather than in
 * the HTTP layer so the admin panel, the JSON API and the tests agree on what
 * kind of failure a refusal is (as src/server/errors.ts does). The message is
 * what the customer — or, for an administrative refusal, the operator — reads.
 */
final class LicenseError extends \RuntimeException
{
    /** Refusal reason → HTTP status, identical to the reference server. */
    public const STATUS = [
        'bad-request' => 400,
        'wrong-product' => 400,
        'invalid-key' => 400,
        'invalid-machine' => 400,
        'invalid-token' => 400,
        'invalid-argument' => 400,
        'revoked' => 403,
        'expired' => 403,
        'forged-token' => 403,
        'unknown-key' => 404,
        'not-found' => 404,
        'seats-exhausted' => 409,
        // 409, never reused for anything else on deactivation: the desktop
        // client reads exactly this status as "refused — keep the licence".
        'self-release-limit' => 409,
    ];

    public readonly string $refusal;

    public readonly int $status;

    public readonly ?string $details;

    /**
     * The licence and machine a refusal concerns, when they were learned from
     * a signed token rather than the request body, so the request log can name
     * them (masked).
     *
     * @var null|array{key: string, machineId: string}
     */
    public readonly ?array $subject;

    /** @param null|array{key: string, machineId: string} $subject */
    public function __construct(string $refusal, string $message, ?string $details = null, ?array $subject = null)
    {
        if (!array_key_exists($refusal, self::STATUS)) {
            throw new \InvalidArgumentException("Unknown refusal {$refusal}");
        }

        parent::__construct($message);
        $this->refusal = $refusal;
        $this->status = self::STATUS[$refusal];
        $this->details = $details;
        $this->subject = $subject;
    }

    public static function invalidArgument(string $message): self
    {
        return new self('invalid-argument', $message);
    }
}

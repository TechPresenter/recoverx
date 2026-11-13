<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Http;

/** A refusal decided by the transport layer rather than by the licensing rules. */
final class HttpRefusal extends \RuntimeException
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        string $message,
        public readonly array $headers = [],
    ) {
        parent::__construct($message);
    }
}

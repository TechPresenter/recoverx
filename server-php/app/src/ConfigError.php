<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * The server is not set up, or its configuration is unusable. The message is
 * the whole explanation, written for the operator; customers only ever see
 * the generic "something went wrong on our side".
 */
final class ConfigError extends \RuntimeException
{
}

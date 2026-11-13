<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

/**
 * An e-mail could not be sent. The message is written for the vendor in the
 * admin panel: it says what went wrong and what to check, and never holds a
 * credential.
 */
final class MailError extends \RuntimeException
{
}

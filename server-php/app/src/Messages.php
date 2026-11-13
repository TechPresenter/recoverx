<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * Every sentence the licence server says to a customer.
 *
 * Ported verbatim from src/server/messages.ts — the desktop application shows
 * the `error` field of a refused request word for word, so these are product
 * copy, not log messages. The support address and the website are this
 * deployment's. The contract-parity test compares every sentence with the
 * TypeScript original, after mapping the reference's own support address and
 * website (src/shared/constants/app.ts) to these two, so a sentence edited on
 * one side only fails a test.
 *
 * The rules they follow: say what happened in the customer's terms, then what
 * to do about it; never blame the customer for something the server cannot
 * know they did; always leave a way forward.
 */
final class Messages
{
    public const SUPPORT = 'info@appsgain.in';

    public const WEBSITE = 'https://recoverx.snapkio.com';

    // --- Request shape ------------------------------------------------------
    // Reached only by an out-of-date or broken client, so they point at
    // updating the application.
    public const INCOMPLETE_REQUEST = 'The activation request was incomplete. Update RecoverX and try again.';
    public const UNREADABLE_REQUEST = 'The activation request could not be read. Update RecoverX and try again.';
    public const WRONG_CONTENT_TYPE = 'The activation request was sent in a format this server does not accept.';
    public const BODY_TOO_LARGE = 'The request was too large for this server to accept.';
    public const WRONG_PRODUCT = 'This licence server activates RecoverX only. Check that you are activating the right product.';
    public const INVALID_MACHINE = 'RecoverX sent a computer identifier this server does not recognise. Update RecoverX and try again.';

    // --- The licence key itself -----------------------------------------------
    public const KEY_EMPTY = 'Enter your licence key.';
    // The prefix and the length come from the key format itself, so these two
    // sentences cannot describe a key the server would not accept.
    public const KEY_WRONG_PRODUCT = 'That licence key is for a different product. RecoverX keys start with '
        . LicenseKey::PREFIX . '.';
    public const KEY_WRONG_LENGTH = 'That licence key is the wrong length. A RecoverX key has '
        . LicenseKey::BODY_LENGTH . ' characters after the ' . LicenseKey::PREFIX . ' prefix.';
    public const KEY_BAD_CHARACTER = 'That licence key contains characters a RecoverX key never uses. Check it against your receipt.';
    public const KEY_CHECKSUM = 'That licence key has a typing error in it. Check it against your receipt.';

    // --- The licence's standing -----------------------------------------------
    public const UNKNOWN_KEY = 'We could not find that licence key. Check it against your receipt, or contact '
        . self::SUPPORT . ' if it came with a recent order.';
    public const REVOKED = 'This licence key is no longer valid. If you think this is a mistake, contact '
        . self::SUPPORT . '.';

    // --- Deactivation -----------------------------------------------------------
    public const TOKEN_UNREADABLE = 'That activation could not be read, so no licence seat was released.';
    public const TOKEN_FORGED = 'That activation was not issued by the RecoverX licence server, so no licence seat was released.';
    public const TOKEN_LICENCE_MISSING = 'We could not find the licence this activation belongs to. Contact '
        . self::SUPPORT . ' and we will release it for you.';
    // Both refusals below leave the licence where it is, and the client keeps
    // it, so each says so: "refused" alone reads as "this computer just lost
    // its licence".
    public const SELF_RELEASE_DISABLED = 'This licence can only be moved to another computer by our support team. '
        . 'It is still active on this computer. To move it, contact ' . self::SUPPORT . ' with your licence key.';

    // --- Transport --------------------------------------------------------------
    public const RATE_LIMITED = 'Too many activation attempts have come from your network. Wait a minute, then try again.';
    public const NOT_FOUND = 'There is nothing at this address on the RecoverX licence server.';
    public const METHOD_NOT_ALLOWED = 'This address does not accept that kind of request.';
    public const BUSY = 'The licence server is busy. Please try again in a few seconds.';
    public const INTERNAL = 'Something went wrong on our side. Please try again in a few minutes, or contact '
        . self::SUPPORT . ' if it keeps happening.';
    public const UNAUTHORIZED = 'This request needs a valid administrator token.';

    private function __construct()
    {
    }

    // Every edition has every feature — a paid one only lifts the Free
    // edition's 1 GB limit — and renewing is done by e-mail, as the website's
    // support page explains; the website itself sells nothing.
    public static function expired(string $endedOn): string
    {
        return "This licence ended on {$endedOn}. Renew it by emailing " . self::SUPPORT
            . ' (see ' . self::WEBSITE . '/support/#renew) to recover without limit again.';
    }

    public static function seatsExhausted(int $activeOn): string
    {
        $where = $activeOn === 1 ? 'another computer' : "{$activeOn} computers";

        return "This licence is already active on {$where}, which is all it allows. "
            . 'Deactivate RecoverX on a computer you no longer use, or contact ' . self::SUPPORT
            . ' and we will move the licence for you.';
    }

    public static function selfReleaseLimit(int $moves, int $windowDays): string
    {
        return 'This licence has already been moved between computers ' . self::timesCount($moves)
            . ' in ' . self::describeWindow($windowDays) . '. '
            . 'It is still active on this computer. To move it again, contact ' . self::SUPPORT
            . ' with your licence key.';
    }

    /** The sentence for a key that failed its local shape and checksum test. */
    public static function describeKeyProblem(?string $problem): string
    {
        return match ($problem) {
            LicenseKey::PROBLEM_EMPTY => self::KEY_EMPTY,
            LicenseKey::PROBLEM_WRONG_PRODUCT => self::KEY_WRONG_PRODUCT,
            LicenseKey::PROBLEM_WRONG_LENGTH => self::KEY_WRONG_LENGTH,
            LicenseKey::PROBLEM_BAD_CHARACTER => self::KEY_BAD_CHARACTER,
            default => self::KEY_CHECKSUM,
        };
    }

    /**
     * A date a customer can read without converting it, e.g. `12 March 2027`,
     * in UTC — the zone every expiry instant is computed in. Matches
     * `Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long',
     * year: 'numeric', timeZone: 'UTC' })`.
     */
    public static function formatCustomerDate(int $epochMs): string
    {
        $seconds = intdiv($epochMs, 1000) - ($epochMs % 1000 < 0 ? 1 : 0);
        $date = (new \DateTimeImmutable('@' . $seconds))->setTimezone(new \DateTimeZone('UTC'));

        return $date->format('j F ') . ltrim($date->format('Y'), '0');
    }

    /** `once`, `twice`, `3 times` — how a person says a count of occasions. */
    private static function timesCount(int $count): string
    {
        return match ($count) {
            1 => 'once',
            2 => 'twice',
            default => "{$count} times",
        };
    }

    /** Whole years are said in months: "the last 12 months" is a rolling year. */
    private static function describeWindow(int $days): string
    {
        if ($days % 365 === 0) {
            return 'the last ' . intdiv($days, 365) * 12 . ' months';
        }

        return $days === 1 ? 'the last day' : "the last {$days} days";
    }
}

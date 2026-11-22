<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Order;

/**
 * Country calling codes for the order form's mobile number.
 *
 * `calling-codes.json` maps ISO 3166-1 alpha-2 codes to the country's calling
 * code as a digit string (`"IN": "91"`). The website builds its country
 * selector from the same file, so both sides agree on the list. The form posts
 * the ISO code rather than the dial code because several countries share one
 * (+1, +7, +44 …).
 */
final class CallingCodes
{
    private const FILE = __DIR__ . '/calling-codes.json';

    /** @var null|array<string, string> */
    private static ?array $codes = null;

    private function __construct()
    {
    }

    /**
     * Every entry, read from the file once per request.
     *
     * @return array<string, string> ISO code => calling code digits
     */
    public static function all(): array
    {
        if (self::$codes !== null) {
            return self::$codes;
        }

        $json = file_get_contents(self::FILE);
        if ($json === false) {
            throw new \RuntimeException('The calling-code list (calling-codes.json) could not be read.');
        }

        $decoded = json_decode($json, true, 4, JSON_THROW_ON_ERROR);
        if (!is_array($decoded)) {
            throw new \RuntimeException('The calling-code list (calling-codes.json) is not an object.');
        }

        $codes = [];
        foreach ($decoded as $iso => $dial) {
            if (is_string($iso) && preg_match('/^[A-Z]{2}$/D', $iso) === 1 && is_string($dial) && preg_match('/^[1-9][0-9]{0,3}$/D', $dial) === 1) {
                $codes[$iso] = $dial;
            }
        }

        return self::$codes = $codes;
    }

    /** The calling code's digits for an ISO code (`"IN"` → `"91"`), or `null` for a code not on the list. Case matters: `"in"` is not on it. */
    public static function dialCode(string $iso): ?string
    {
        return self::all()[$iso] ?? null;
    }
}

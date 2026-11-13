<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * JavaScript string semantics, where the contract depends on them.
 *
 * The reference server and the desktop client are TypeScript. Wherever the
 * licence contract is defined by a JavaScript built-in — what `trim()` strips,
 * how long `.length` says a string is, what `toUpperCase()` produces, what
 * `Number("…")` reads — this class reproduces that built-in, so a key, a body
 * or a query string is judged here exactly as it is judged there. PHP's own
 * `trim()`, `strlen()` and `strtoupper()` disagree with them on non-ASCII
 * input, and a disagreement would mean a key one side accepts and the other
 * refuses.
 */
final class Js
{
    /**
     * Every character JavaScript's `\s` and `String.prototype.trim` treat as
     * white space, spelled out so PCRE's own (slightly different) idea of
     * Unicode white space does not apply.
     */
    public const WHITESPACE_CLASS = '\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}'
        . '\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

    private function __construct()
    {
    }

    /** `String.prototype.trim`. */
    public static function trim(string $text): string
    {
        $class = self::WHITESPACE_CLASS;
        $trimmed = preg_replace("/^[{$class}]+|[{$class}]+\\z/u", '', $text);

        // Only invalid UTF-8 makes PCRE give up; callers validate encoding
        // first, so this keeps the ASCII behaviour for whatever slips through.
        return $trimmed ?? trim($text, " \t\n\r\v\f");
    }

    /** `String.prototype.length`: UTF-16 code units, not bytes or code points. */
    public static function length(string $text): int
    {
        if ($text === '') {
            return 0;
        }

        $codePoints = preg_match_all('/./su', $text);
        if ($codePoints === false) {
            return strlen($text);
        }

        // Characters outside the Basic Multilingual Plane are surrogate pairs.
        $astral = preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $text);

        return $codePoints + ($astral === false ? 0 : $astral);
    }

    /**
     * `String.prototype.toUpperCase`, which applies Unicode's full case mapping
     * (`ß` becomes `SS`, the dotless `ı` becomes `I`).
     *
     * mbstring implements the same mapping. Without it only ASCII is
     * upper-cased, which differs only for characters that can never be part of
     * a valid licence key anyway after their mapping — the setup page
     * recommends enabling mbstring regardless.
     */
    public static function upper(string $text): string
    {
        if (function_exists('mb_strtoupper')) {
            return mb_strtoupper($text, 'UTF-8');
        }

        return strtoupper($text);
    }

    /** Whether a string is valid UTF-8, which PHP never checks on its own. */
    public static function isUtf8(string $text): bool
    {
        return preg_match('//u', $text) === 1;
    }

    /** The string's characters (code points), in order. */
    public static function characters(string $text): array
    {
        if ($text === '') {
            return [];
        }

        $characters = preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY);

        return $characters === false ? str_split($text) : $characters;
    }

    /**
     * `Number(text)` for a string: `null` stands for `NaN`.
     *
     * Used where the reference server coerces a query parameter with
     * `z.coerce.number()`, so `?limit=0x10` and `?limit= 16 ` mean what they
     * mean there.
     */
    public static function number(string $text): ?float
    {
        $trimmed = self::trim($text);

        if ($trimmed === '') {
            return 0.0;
        }

        if (preg_match('/^([+-]?)Infinity$/', $trimmed, $match) === 1) {
            return $match[1] === '-' ? -INF : INF;
        }

        if (preg_match('/^0[xX]([0-9a-fA-F]+)$/', $trimmed, $match) === 1) {
            return (float) hexdec($match[1]);
        }

        if (preg_match('/^0[oO]([0-7]+)$/', $trimmed, $match) === 1) {
            return (float) octdec($match[1]);
        }

        if (preg_match('/^0[bB]([01]+)$/', $trimmed, $match) === 1) {
            return (float) bindec($match[1]);
        }

        if (preg_match('/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/', $trimmed) === 1) {
            return (float) $trimmed;
        }

        return null;
    }

    /** What zod calls the type of a decoded JSON value in its messages. */
    public static function typeName(mixed $value): string
    {
        return match (true) {
            $value === null => 'null',
            is_bool($value) => 'boolean',
            is_float($value) && is_nan($value) => 'NaN',
            is_int($value), is_float($value) => 'number',
            is_string($value) => 'string',
            is_array($value) => 'array',
            default => 'object',
        };
    }
}

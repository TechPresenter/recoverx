<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * Validation of decoded JSON, in the reference server's terms.
 *
 * The reference server validates every body with zod. This is the small part
 * of zod that the licence API uses — required / optional / nullable fields,
 * strings with trimming and length limits, integers with bounds, enums,
 * booleans, e-mail addresses and strict objects that refuse unknown fields —
 * with the same rules (lengths are counted the JavaScript way) and messages in
 * the same `path: message; …` shape, so an operator reading a 400 from either
 * server sees the same explanation.
 *
 * Fields are checked by calling one method per field, in schema order; each
 * returns the parsed value (or `null` when absent or null) and records any
 * problem. `finish()` adds the strict-object check and returns the issues.
 */
final class Validator
{
    public const REQUIRED = 'required';
    public const OPTIONAL = 'optional';
    public const NULLABLE = 'nullable';
    public const NULLISH = 'nullish';

    /** @see https://github.com/colinhacks/zod — `z.email()`'s default pattern */
    private const EMAIL = "/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/D";

    /** zod's own ceiling for `.int()`: `Number.MAX_SAFE_INTEGER`. */
    private const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

    /** @var list<array{0: string, 1: string}> */
    private array $issues = [];

    /** @var array<string, true> */
    private array $known = [];

    private readonly ?\stdClass $object;

    public function __construct(mixed $input)
    {
        $this->object = $input instanceof \stdClass ? $input : null;

        if ($this->object === null) {
            $this->issue('', 'Invalid input: expected object, received ' . Js::typeName($input));
        }
    }

    /** Validate query-string parameters, which arrive as strings. */
    public static function forQuery(array $parameters): self
    {
        return new self((object) $parameters);
    }

    public function isObject(): bool
    {
        return $this->object !== null;
    }

    /** Whether the field is present at all, `null` included. */
    public function has(string $field): bool
    {
        return $this->object !== null && property_exists($this->object, $field);
    }

    public function string(string $field, string $presence = self::REQUIRED, int $min = 0, ?int $max = null, bool $trim = false): ?string
    {
        $value = $this->present($field, $presence, 'string');
        if (!is_string($value)) {
            if ($value !== null) {
                $this->issue($field, 'Invalid input: expected string, received ' . Js::typeName($value));
            }

            return null;
        }

        if ($trim) {
            $value = Js::trim($value);
        }

        return $this->checkLength($field, $value, $min, $max) ? $value : null;
    }

    /**
     * Optional free text: trimmed, bounded, and `null`, absent or empty all
     * meaning "not given" (the reference's `optionalText`).
     */
    public function optionalText(string $field, int $max): ?string
    {
        $value = $this->string($field, self::NULLISH, 0, $max, true);

        return $value === '' ? null : $value;
    }

    public function email(string $field, int $max, string $presence = self::NULLISH): ?string
    {
        $value = $this->present($field, $presence, 'string');
        if (!is_string($value)) {
            if ($value !== null) {
                $this->issue($field, 'Invalid input: expected string, received ' . Js::typeName($value));
            }

            return null;
        }

        $valid = preg_match(self::EMAIL, $value) === 1;
        if (!$valid) {
            $this->issue($field, 'Invalid email address');
        }

        return $this->checkLength($field, $value, 0, $max) && $valid ? $value : null;
    }

    public function int(string $field, int $min, int $max, string $presence = self::REQUIRED): ?int
    {
        $value = $this->present($field, $presence, 'number');
        if ($value === null) {
            return null;
        }

        return $this->checkInteger($field, $value, $min, $max);
    }

    /** An integer given as a string, read with JavaScript's `Number()` (`z.coerce.number()`). */
    public function coercedInt(string $field, int $min, ?int $max, string $presence = self::OPTIONAL): ?int
    {
        $value = $this->present($field, $presence, 'number');
        if ($value === null) {
            return null;
        }

        if (is_string($value)) {
            $number = Js::number($value);
            $value = $number ?? NAN;
        }

        return $this->checkInteger($field, $value, $min, $max);
    }

    /** @param list<string> $options */
    public function enum(string $field, array $options, string $presence = self::REQUIRED): ?string
    {
        $this->known[$field] = true;
        if ($this->object === null) {
            return null;
        }

        // zod reports a missing or null enum as an invalid option, not as a
        // wrong type, so presence is decided here rather than in present().
        $has = property_exists($this->object, $field);
        $value = $has ? $this->object->{$field} : null;

        if (!$has && ($presence === self::OPTIONAL || $presence === self::NULLISH)) {
            return null;
        }

        if ($has && $value === null && ($presence === self::NULLABLE || $presence === self::NULLISH)) {
            return null;
        }

        if (!is_string($value) || !in_array($value, $options, true)) {
            $quoted = array_map(static fn (string $option): string => '"' . $option . '"', $options);
            $this->issue($field, 'Invalid option: expected one of ' . implode('|', $quoted));

            return null;
        }

        return $value;
    }

    public function bool(string $field, string $presence = self::OPTIONAL): ?bool
    {
        $value = $this->present($field, $presence, 'boolean');
        if ($value === null) {
            return null;
        }

        if (!is_bool($value)) {
            $this->issue($field, 'Invalid input: expected boolean, received ' . Js::typeName($value));

            return null;
        }

        return $value;
    }

    /**
     * Refuse unknown fields (zod's `strictObject`), then return every issue.
     *
     * @return list<array{0: string, 1: string}>
     */
    public function finish(bool $strict = true): array
    {
        if ($strict && $this->object !== null) {
            $unknown = [];
            foreach (array_keys(get_object_vars($this->object)) as $name) {
                if (!isset($this->known[(string) $name])) {
                    $unknown[] = '"' . $name . '"';
                }
            }

            if (count($unknown) === 1) {
                $this->issue('', 'Unrecognized key: ' . $unknown[0]);
            } elseif ($unknown !== []) {
                $this->issue('', 'Unrecognized keys: ' . implode(', ', $unknown));
            }
        }

        return $this->issues;
    }

    /**
     * Collapse issues into one line: `path: message; …`, at most eight, as
     * `formatZodIssues` does.
     *
     * @param list<array{0: string, 1: string}> $issues
     */
    public static function format(array $issues): string
    {
        $parts = [];
        foreach (array_slice($issues, 0, 8) as [$path, $message]) {
            $parts[] = ($path === '' ? '<root>' : $path) . ': ' . $message;
        }

        return implode('; ', $parts);
    }

    /**
     * The field's value, or `null` when it is absent or null and that is
     * allowed. A disallowed absence or null is recorded as an issue (with
     * `$expected` naming the type) and also returns `null`.
     */
    private function present(string $field, string $presence, ?string $expected): mixed
    {
        $this->known[$field] = true;

        if ($this->object === null) {
            return null;
        }

        if (!property_exists($this->object, $field)) {
            if ($presence === self::REQUIRED || $presence === self::NULLABLE) {
                $this->missing($field, $expected, 'undefined');
            }

            return null;
        }

        $value = $this->object->{$field};

        if ($value === null && ($presence === self::REQUIRED || $presence === self::OPTIONAL)) {
            $this->missing($field, $expected, 'null');
        }

        return $value;
    }

    private function missing(string $field, ?string $expected, string $received): void
    {
        if ($expected !== null) {
            $this->issue($field, "Invalid input: expected {$expected}, received {$received}");
        }
    }

    private function checkLength(string $field, string $value, int $min, ?int $max): bool
    {
        $length = Js::length($value);

        if ($length < $min) {
            $this->issue($field, "Too small: expected string to have >={$min} characters");

            return false;
        }

        if ($max !== null && $length > $max) {
            $this->issue($field, "Too big: expected string to have <={$max} characters");

            return false;
        }

        return true;
    }

    private function checkInteger(string $field, mixed $value, int $min, ?int $max): ?int
    {
        if (!is_int($value) && !is_float($value)) {
            $this->issue($field, 'Invalid input: expected number, received ' . Js::typeName($value));

            return null;
        }

        if (is_float($value) && (is_nan($value) || is_infinite($value))) {
            $this->issue($field, 'Invalid input: expected number, received ' . Js::typeName($value));

            return null;
        }

        if (is_float($value) && floor($value) !== $value) {
            $this->issue($field, 'Invalid input: expected int, received number');

            return null;
        }

        $ok = true;
        if (abs($value) > self::MAX_SAFE_INTEGER) {
            $this->issue($field, 'Too big: expected int to be <=' . self::MAX_SAFE_INTEGER);
            $ok = false;
        }

        if ($value < $min) {
            $this->issue($field, "Too small: expected number to be >={$min}");
            $ok = false;
        }

        if ($max !== null && $value > $max) {
            $this->issue($field, "Too big: expected number to be <={$max}");
            $ok = false;
        }

        return $ok ? (int) $value : null;
    }

    private function issue(string $path, string $message): void
    {
        $this->issues[] = [$path, $message];
    }
}

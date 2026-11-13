<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * Licence key format: `RECX-XXXXX-XXXXX-XXXXX-XXXXX`, the last character a
 * checksum over everything before it.
 *
 * A line-for-line port of src/shared/utils/license-key.ts. The desktop client
 * validates keys with that file before it ever sends one here, and this
 * server mints the keys the client will validate, so the two must agree on
 * every input — including the awkward ones: lower case, stray spaces and
 * hyphens, the letters customers type for digits (I, L, O, U), and a prefix
 * typed with those same confusions. The contract-parity test feeds both
 * implementations the same corpus and compares the answers.
 *
 * The checksum catches typing mistakes at the support desk; it is not a
 * security feature. A key is an identifier — the signed activation token is
 * the authority.
 */
final class LicenseKey
{
    public const PREFIX = 'RECX';

    /** Crockford-style alphabet: no I, L, O or U. */
    public const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

    public const GROUP_LENGTH = 5;

    public const GROUP_COUNT = 4;

    public const BODY_LENGTH = self::GROUP_COUNT * self::GROUP_LENGTH;

    /** What a person is likely to type instead of the intended character. */
    private const SUBSTITUTIONS = ['I' => '1', 'L' => '1', 'O' => '0', 'U' => 'V'];

    public const PROBLEM_EMPTY = 'empty';
    public const PROBLEM_WRONG_PRODUCT = 'wrong-product';
    public const PROBLEM_WRONG_LENGTH = 'wrong-length';
    public const PROBLEM_BAD_CHARACTER = 'bad-character';
    public const PROBLEM_CHECKSUM = 'checksum';

    private function __construct()
    {
    }

    /**
     * Spellings of a prefix that are recognised: the prefix itself, then the
     * one the substitutions would turn it into, when that differs.
     *
     * `RECX` contains none of the confusable letters, so today the list has a
     * single entry. It is still derived rather than written out, as in
     * license-key.ts, so that a prefix containing I, L, O or U would keep
     * accepting the way customers mistype it: without the split, the
     * substitutions would rewrite such a prefix itself (`SOLO` to `S010`) and
     * every key would look like another product's.
     *
     * @return list<string>
     */
    public static function prefixForms(string $prefix = self::PREFIX): array
    {
        return array_values(array_unique([$prefix, strtr($prefix, self::SUBSTITUTIONS)]));
    }

    /**
     * Reduce free-form input to canonical characters.
     *
     * The prefix is split off before substituting, because the substitutions
     * describe how customers mistype the random part of a key, not the fixed
     * product tag (see `prefixForms`).
     */
    public static function normalize(string $input): string
    {
        $class = Js::WHITESPACE_CLASS;
        $upper = Js::upper($input);
        $compact = preg_replace("/[{$class}-]+/u", '', $upper);
        if ($compact === null) {
            // Invalid UTF-8: fall back to ASCII white space; such input can
            // never be a valid key, and the caller will say so.
            $compact = str_replace([' ', "\t", "\n", "\r", "\v", "\f", '-'], '', $upper);
        }

        $prefix = null;
        foreach (self::prefixForms() as $form) {
            if (str_starts_with($compact, $form)) {
                $prefix = $form;
                break;
            }
        }

        $body = $prefix === null ? $compact : substr($compact, strlen($prefix));

        // The substitutions are all ASCII, so a byte-wise translation cannot
        // touch a multi-byte UTF-8 sequence.
        $normalized = strtr($body, self::SUBSTITUTIONS);

        return ($prefix === null ? '' : self::PREFIX) . $normalized;
    }

    /**
     * Format a key for display, in groups of five. Copes with a partial key,
     * because the client formats as the customer types.
     */
    public static function format(string $input): string
    {
        $normalized = self::normalize($input);
        $body = str_starts_with($normalized, self::PREFIX)
            ? substr($normalized, strlen(self::PREFIX))
            : $normalized;

        $groups = [self::PREFIX];
        foreach (array_chunk(Js::characters($body), self::GROUP_LENGTH) as $group) {
            $groups[] = implode('', $group);
        }

        return implode('-', array_filter($groups, static fn (string $group): bool => $group !== ''));
    }

    /**
     * The checksum character for a key body: a weighted sum, so that swapping
     * two neighbouring characters — the commonest typing error — changes it.
     * Empty when the body contains a character outside the alphabet.
     */
    public static function checksumCharacter(string $body): string
    {
        $total = 0;
        $length = strlen($body);

        for ($index = 0; $index < $length; $index += 1) {
            $value = strpos(self::ALPHABET, $body[$index]);
            if ($value === false) {
                return '';
            }

            $total += $value * ($index + 1);
        }

        return self::ALPHABET[$total % strlen(self::ALPHABET)];
    }

    /**
     * Check a key's shape and checksum. Says nothing about whether it was sold.
     *
     * @return array{ok: bool, key: ?string, problem: ?string}
     */
    public static function validate(string $input): array
    {
        $normalized = self::normalize($input);

        if ($normalized === '') {
            return ['ok' => false, 'key' => null, 'problem' => self::PROBLEM_EMPTY];
        }

        if (!str_starts_with($normalized, self::PREFIX)) {
            return ['ok' => false, 'key' => null, 'problem' => self::PROBLEM_WRONG_PRODUCT];
        }

        $body = substr($normalized, strlen(self::PREFIX));

        if (Js::length($body) !== self::BODY_LENGTH) {
            return ['ok' => false, 'key' => null, 'problem' => self::PROBLEM_WRONG_LENGTH];
        }

        if (strspn($body, self::ALPHABET) !== strlen($body)) {
            return ['ok' => false, 'key' => null, 'problem' => self::PROBLEM_BAD_CHARACTER];
        }

        $expected = self::checksumCharacter(substr($body, 0, self::BODY_LENGTH - 1));

        if ($expected === '' || $expected !== $body[self::BODY_LENGTH - 1]) {
            return ['ok' => false, 'key' => null, 'problem' => self::PROBLEM_CHECKSUM];
        }

        return ['ok' => true, 'key' => self::format($normalized), 'problem' => null];
    }

    /** The canonical form of a well-formed key, or `null`. */
    public static function canonical(string $input): ?string
    {
        return self::validate($input)['key'];
    }

    /**
     * Hide all but the last group — enough to say which licence, not enough
     * for a log line or a screenshot to leak a working key.
     */
    public static function mask(string $key): string
    {
        $groups = explode('-', self::format($key));

        if (count($groups) <= 2) {
            return implode('-', $groups);
        }

        $last = array_pop($groups);
        $first = array_shift($groups);
        $hidden = array_map(
            static fn (string $group): string => str_repeat('•', Js::length($group)),
            $groups,
        );

        return implode('-', [$first, ...$hidden, $last]);
    }

    /** Build a full key from a nineteen-character payload, or `null`. */
    public static function complete(string $payload): ?string
    {
        $normalized = self::normalize($payload);
        $body = str_starts_with($normalized, self::PREFIX)
            ? substr($normalized, strlen(self::PREFIX))
            : $normalized;

        if (Js::length($body) !== self::BODY_LENGTH - 1) {
            return null;
        }

        if (strspn($body, self::ALPHABET) !== strlen($body)) {
            return null;
        }

        $checksum = self::checksumCharacter($body);
        if ($checksum === '') {
            return null;
        }

        return self::format(self::PREFIX . $body . $checksum);
    }

    /**
     * Mint a new, well-formed key.
     *
     * `$pick` returns a uniformly distributed integer in `[0, $max)`; it
     * defaults to `random_int`, a CSPRNG. The payload is completed *with* the
     * prefix in front, as the TypeScript generator does: a random body that
     * happens to begin with a recognised prefix spelling (`RECX` itself)
     * would otherwise be taken for the prefix and stripped.
     *
     * @param null|callable(int): mixed $pick
     */
    public static function generate(?callable $pick = null): string
    {
        $pick ??= static fn (int $max): int => random_int(0, $max - 1);
        $size = strlen(self::ALPHABET);
        $payload = '';

        for ($index = 0; $index < self::BODY_LENGTH - 1; $index += 1) {
            $choice = $pick($size);

            if (!is_int($choice) || $choice < 0 || $choice >= $size) {
                throw new \RangeException(sprintf(
                    'Key generator returned %s, outside 0..%d',
                    is_scalar($choice) ? var_export($choice, true) : get_debug_type($choice),
                    $size - 1,
                ));
            }

            $payload .= self::ALPHABET[$choice];
        }

        $key = self::complete(self::PREFIX . $payload);
        if ($key === null) {
            throw new \LogicException('A generated licence key could not be completed');
        }

        return $key;
    }
}

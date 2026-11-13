<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\App;
use RecoverX\Licensing\Authority;
use RecoverX\Licensing\Expiry;
use RecoverX\Licensing\LicenseError;
use RecoverX\Licensing\Paths;
use RecoverX\Licensing\Setup\Installer;
use RecoverX\Licensing\SigningKey;
use RecoverX\Licensing\Store;
use RecoverX\Licensing\TokenSigner;

/**
 * A deliberately small test framework: PHPUnit is not available on shared
 * hosting and the server has no Composer dependencies, so the tests run on
 * nothing but the PHP binary. `test()` registers a case; the `Assert`
 * methods throw `AssertionFailed`; `tests/run.php` runs everything.
 */
final class AssertionFailed extends \RuntimeException
{
}

final class Registry
{
    /** @var list<array{0: string, 1: string, 2: callable}> */
    public static array $tests = [];

    public static string $file = '';
}

function test(string $name, callable $body): void
{
    Registry::$tests[] = [Registry::$file, $name, $body];
}

final class Assert
{
    public static function same(mixed $expected, mixed $actual, string $message = ''): void
    {
        if ($expected !== $actual) {
            throw new AssertionFailed(($message === '' ? '' : $message . ': ') . 'expected ' . self::show($expected) . ', got ' . self::show($actual));
        }
    }

    public static function true(bool $condition, string $message = 'expected true'): void
    {
        if (!$condition) {
            throw new AssertionFailed($message);
        }
    }

    public static function matches(string $pattern, string $actual, string $message = ''): void
    {
        if (preg_match($pattern, $actual) !== 1) {
            throw new AssertionFailed(($message === '' ? '' : $message . ': ') . self::show($actual) . " does not match {$pattern}");
        }
    }

    public static function notContains(string $needle, string $haystack, string $message = ''): void
    {
        if ($needle !== '' && str_contains($haystack, $needle)) {
            throw new AssertionFailed(($message === '' ? '' : $message . ': ') . 'unexpectedly contains ' . self::show($needle));
        }
    }

    /**
     * @template T of \Throwable
     * @param class-string<T> $class
     * @return T
     */
    public static function throws(string $class, callable $body, ?string $pattern = null): \Throwable
    {
        try {
            $body();
        } catch (\Throwable $error) {
            if (!$error instanceof $class) {
                throw new AssertionFailed("expected {$class}, got " . $error::class . ': ' . $error->getMessage(), 0, $error);
            }
            if ($pattern !== null) {
                self::matches($pattern, $error->getMessage());
            }

            return $error;
        }

        throw new AssertionFailed("expected {$class} to be thrown");
    }

    /** A licensing refusal with this reason (and, optionally, a message matching `$pattern`). */
    public static function refuses(string $refusal, callable $body, ?string $pattern = null): LicenseError
    {
        $error = self::throws(LicenseError::class, $body, $pattern);
        self::same($refusal, $error->refusal, 'refusal');

        return $error;
    }

    private static function show(mixed $value): string
    {
        $text = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);

        return $text === false ? var_export($value, true) : (strlen($text) > 400 ? substr($text, 0, 400) . '…' : $text);
    }
}

/** A clock a test can move. */
final class FakeClock
{
    public function __construct(public int $current = Kit::NOW)
    {
    }

    public function __invoke(): int
    {
        return $this->current;
    }

    public function advance(int $milliseconds): void
    {
        $this->current += $milliseconds;
    }
}

final class Kit
{
    /** 12 November 2026, 12:00 UTC — the reference tests' fixed "now". */
    public const NOW = 1_794_484_800_000;

    public const DAY = Expiry::DAY_MS;

    public const MACHINE_A = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ12';
    public const MACHINE_B = 'QWER-TYUI-OPAS-DFGH-JKLZ-XCVB';
    public const MACHINE_C = 'Z9Y8-X7W6-V5T4-S3R2-Q1P0-_-AB';
    public const MACHINE_D = '1234-5678-90AB-CDEF-GHIJ-KLMN';

    public const CUSTOMER = ['actor' => 'customer', 'ip' => '203.0.113.7'];
    public const CLI = ['actor' => 'cli'];

    /** @var list<string> */
    private static array $cleanup = [];

    /** A fresh empty directory under the test temp root, removed after the run. */
    public static function tempDir(string $prefix = 'rx-php-'): string
    {
        $root = getenv('RECOVERX_TEST_TMP');
        $base = is_string($root) && $root !== '' ? $root : sys_get_temp_dir();
        $dir = rtrim(str_replace('\\', '/', $base), '/') . '/' . $prefix . bin2hex(random_bytes(6));
        mkdir($dir, 0700, true);
        self::$cleanup[] = $dir;

        return $dir;
    }

    public static function cleanup(): void
    {
        foreach (self::$cleanup as $dir) {
            self::remove($dir);
        }
        self::$cleanup = [];
    }

    private static function remove(string $path): void
    {
        if (is_dir($path) && !is_link($path)) {
            foreach (scandir($path) ?: [] as $entry) {
                if ($entry !== '.' && $entry !== '..') {
                    self::remove($path . '/' . $entry);
                }
            }
            @rmdir($path);
        } else {
            @unlink($path);
        }
    }

    /**
     * A store, a signer and an authority on a fresh database.
     *
     * @param array{limit?: int, windowDays?: int, randomIndex?: callable, key?: SigningKey} $options
     * @return array{store: Store, signer: TokenSigner, authority: Authority, clock: FakeClock, file: string}
     */
    public static function fixture(array $options = []): array
    {
        $file = self::tempDir() . '/licences.db';
        $store = Store::open($file);
        $signer = new TokenSigner($options['key'] ?? SigningKey::generate());
        $clock = new FakeClock();
        $authority = new Authority(
            $store,
            $signer,
            $clock,
            $options['randomIndex'] ?? null,
            $options['limit'] ?? 4,
            $options['windowDays'] ?? 365,
        );

        return ['store' => $store, 'signer' => $signer, 'authority' => $authority, 'clock' => $clock, 'file' => $file];
    }

    /**
     * A provisioned installation (as /setup/ leaves it) and an App over it.
     *
     * @param array<string, mixed> $settings
     * @return array{app: App, paths: Paths, clock: FakeClock}
     */
    public static function installation(array $settings = [], ?string $apiToken = null): array
    {
        $root = self::tempDir('rx-install-');
        $appDir = $root . '/recoverx-licensing/app';
        mkdir($appDir, 0700, true);
        $paths = Paths::detect($appDir);
        (new Installer($paths))->install('correct horse battery staple', null, 'https://licensing.test', $settings, $apiToken);
        $clock = new FakeClock();

        return ['app' => new App($paths, $clock), 'paths' => $paths, 'clock' => $clock];
    }

    /** Mint one licence and return its key. */
    public static function mint(Authority $authority, array $input): string
    {
        return $authority->createLicenses((object) $input, self::CLI)['licenses'][0]['key'];
    }

    /** Nineteen picks that spell `$body` in the key alphabet. */
    public static function picksFor(string $body): \Closure
    {
        $picks = array_map(static fn (string $c): int => (int) strpos(\RecoverX\Licensing\LicenseKey::ALPHABET, $c), str_split($body));
        $index = 0;

        return static function () use ($picks, &$index): int {
            return $picks[$index++] ?? 0;
        };
    }
}

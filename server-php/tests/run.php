<?php

/*
 * RecoverX licence server (PHP) — unit test runner.
 *
 *   php -d extension=sodium tests/run.php [name-filter]
 *
 * Runs every tests/unit/*Test.php. No PHPUnit and no Composer: the server
 * ships without dependencies, and so do its tests. Exits non-zero when any
 * test fails. Temporary files go under RECOVERX_TEST_TMP when it is set,
 * otherwise the system temporary directory, and are removed afterwards.
 *
 * Unlike the deployed bootstrap, deprecation notices fail the run here, so a
 * construct a newer PHP release has deprecated is caught before it ships.
 */

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

require dirname(__DIR__) . '/app/bootstrap.php';
require __DIR__ . '/support/TestKit.php';

set_error_handler(static function (int $severity, string $message, string $file = '', int $line = 0): bool {
    if ((error_reporting() & $severity) === 0) {
        return false;
    }

    throw new \ErrorException($message, 0, $severity, $file, $line);
});

foreach (['sodium', 'pdo_sqlite'] as $extension) {
    if (!extension_loaded($extension)) {
        fwrite(STDERR, "The {$extension} extension is not loaded. Run with: php -d extension={$extension} tests/run.php\n");
        exit(2);
    }
}

$filter = $argv[1] ?? '';
$files = glob(__DIR__ . '/unit/*Test.php') ?: [];
sort($files);

foreach ($files as $file) {
    Registry::$file = basename($file, '.php');
    require $file;
}

$passed = 0;
$failed = [];
$started = hrtime(true);

foreach (Registry::$tests as [$file, $name, $body]) {
    if ($filter !== '' && stripos("{$file} {$name}", $filter) === false) {
        continue;
    }

    try {
        $body();
        $passed += 1;
        echo "  ✓ {$file} › {$name}\n";
    } catch (\Throwable $error) {
        $failed[] = [$file, $name, $error];
        echo "  ✗ {$file} › {$name}\n";
    } finally {
        Kit::cleanup();
    }
}

$seconds = round((hrtime(true) - $started) / 1e9, 2);

foreach ($failed as [$file, $name, $error]) {
    echo "\n✗ {$file} › {$name}\n    " . $error::class . ': ' . $error->getMessage() . "\n";
    echo '    at ' . str_replace('\\', '/', $error->getFile()) . ':' . $error->getLine() . "\n";
    foreach (array_slice($error->getTrace(), 0, 6) as $frame) {
        if (isset($frame['file'])) {
            echo '       ' . basename($frame['file']) . ':' . ($frame['line'] ?? '?') . ' ' . ($frame['class'] ?? '') . ($frame['type'] ?? '') . $frame['function'] . "\n";
        }
    }
}

$total = $passed + count($failed);
echo "\n" . ($failed === [] ? 'PASS' : 'FAIL') . ": {$passed}/{$total} tests passed in {$seconds}s on PHP " . PHP_VERSION . "\n";

exit($failed === [] ? 0 : 1);

<?php

/*
 * RecoverX licence server — bootstrap.
 *
 * Required by the three public entry points (public_html/v1, /admin and
 * /setup) and by the command-line tools. It checks the PHP version, registers
 * the class autoloader and installs error handling that never shows a stack
 * trace, a path or a secret to a visitor: details go to the private log, the
 * visitor gets a plain sentence.
 *
 * This file deliberately uses only syntax every PHP 7 and 8 release can parse,
 * so that a site accidentally switched to an old PHP version gets the
 * explanation below instead of a parse error.
 */

declare(strict_types=1);

namespace RecoverX\Licensing;

const MINIMUM_PHP_VERSION_ID = 80100;

if (PHP_VERSION_ID < MINIMUM_PHP_VERSION_ID) {
    if (PHP_SAPI !== 'cli') {
        http_response_code(500);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo 'The RecoverX licence server needs PHP 8.1 or newer, but this site runs PHP ' . PHP_VERSION . '. '
        . 'In hPanel open Websites, then Advanced, then PHP Configuration, and choose PHP 8.3.' . "\n";
    exit(1);
}

ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
ini_set('default_charset', 'UTF-8');

spl_autoload_register(static function (string $class): void {
    $prefix = __NAMESPACE__ . '\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }

    $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

/*
 * Every PHP warning and notice becomes an exception, so nothing half-works
 * silently; the `@` operator still suppresses a warning where a failure is
 * expected and handled. Deprecation notices are only logged: a future PHP
 * release deprecating something must not take the licence server down on
 * the day the host upgrades. (The test runner makes them fatal instead.)
 */
set_error_handler(static function (int $severity, string $message, string $file = '', int $line = 0): bool {
    if ((error_reporting() & $severity) === 0) {
        return false;
    }

    if ($severity === E_DEPRECATED || $severity === E_USER_DEPRECATED) {
        error_log("RecoverX licence server: deprecated: {$message} in " . basename($file) . ":{$line}");

        return true;
    }

    throw new \ErrorException($message, 0, $severity, $file, $line);
});

/**
 * The application folder (`recoverx-licensing/app`).
 */
function app_dir(): string
{
    return __DIR__;
}

/**
 * Last-resort handler for anything that escaped the request handlers: log it
 * privately, answer with a sentence and no detail.
 *
 * @param 'json'|'html'|'text' $format
 */
function fail_safely(\Throwable $error, string $format): void
{
    try {
        $paths = Paths::detect(__DIR__);
        $logger = new Logger(is_dir($paths->dataDir) ? $paths->logDir() : null);
        $logger->error('Unhandled error', ['error' => $error]);
    } catch (\Throwable $ignored) {
        error_log('RecoverX licence server: ' . get_class($error) . ': ' . $error->getMessage());
    }

    if (PHP_SAPI === 'cli') {
        fwrite(STDERR, get_class($error) . ': ' . $error->getMessage() . "\n");
        exit(1);
    }

    if (!headers_sent()) {
        http_response_code(500);
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
    }

    if ($format === 'json') {
        if (!headers_sent()) {
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode(['error' => Messages::INTERNAL], JSON_UNESCAPED_SLASHES);

        return;
    }

    if (!headers_sent()) {
        header('Content-Type: text/html; charset=utf-8');
    }
    echo '<!doctype html><meta charset="utf-8"><title>Something went wrong</title>'
        . '<p style="font-family:system-ui,sans-serif;max-width:40em;margin:3em auto">'
        . 'Something went wrong on the server. The details were written to the licence server log '
        . '(recoverx-licensing/data/logs). Please try again in a minute.</p>';
}

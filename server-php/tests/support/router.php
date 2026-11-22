<?php

/*
 * Router for PHP's built-in web server, standing in for public/.htaccess:
 *
 *   php -d extension=sodium -S 127.0.0.1:8080 -t <public_html> tests/support/router.php
 *
 * Mirrors the rewrite rules (/healthz and /v1/* to v1/index.php), the deny
 * rules (dotfiles, databases, keys, logs → 403) and directory indexes for
 * /admin/ and /setup/. Used by the contract-parity tests and for trying the
 * server locally; never deployed.
 */

declare(strict_types=1);

$root = rtrim(str_replace('\\', '/', (string) $_SERVER['DOCUMENT_ROOT']), '/');
$path = rawurldecode((string) parse_url((string) $_SERVER['REQUEST_URI'], PHP_URL_PATH));

$run = static function (string $script) use ($root): bool {
    $_SERVER['SCRIPT_NAME'] = $script;
    $_SERVER['SCRIPT_FILENAME'] = $root . $script;
    $_SERVER['PHP_SELF'] = $script;
    chdir(dirname($root . $script));
    require $root . $script;

    return true;
};

if ($path === '/healthz' || preg_match('#^/v1(/.*)?$#D', $path) === 1) {
    return $run('/v1/index.php');
}

$name = basename($path);
if (
    preg_match('/(^\.(?!well-known)|\.(sqlite|sqlite3|db|db-wal|db-shm|key|pem|log|jsonl|lock|bak)$|^config\.(local\.)?php$|^setup-code\.txt$)/', $name) === 1
    || str_contains($path, '/.')
) {
    http_response_code(403);
    echo 'Forbidden';

    return true;
}

foreach (['/admin', '/setup', '/order'] as $section) {
    if ($path === $section || $path === $section . '/' || $path === $section . '/index.php') {
        return $run($section . '/index.php');
    }
}

// Anything else is the static website.
return false;

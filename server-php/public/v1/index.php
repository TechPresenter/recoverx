<?php

/*
 * RecoverX licence server — JSON API front controller.
 *
 * public_html/.htaccess sends /v1/* and /healthz here. The application itself
 * lives outside the web root, in recoverx-licensing/ next to public_html.
 */

declare(strict_types=1);

$bootstrap = dirname(__DIR__, 2) . '/recoverx-licensing/app/bootstrap.php';

if (!is_file($bootstrap)) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    error_log('RecoverX licence server: ' . $bootstrap . ' is missing. Upload the recoverx-licensing folder next to public_html.');
    echo '{"error":"Something went wrong on our side. Please try again in a few minutes, or contact info@appsgain.in if it keeps happening."}';
    exit;
}

require $bootstrap;

try {
    \RecoverX\Licensing\Http\Api::run(
        new \RecoverX\Licensing\App(\RecoverX\Licensing\Paths::detect(\RecoverX\Licensing\app_dir())),
    );
} catch (\Throwable $error) {
    \RecoverX\Licensing\fail_safely($error, 'json');
}

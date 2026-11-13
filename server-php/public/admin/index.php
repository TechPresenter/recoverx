<?php

/*
 * RecoverX licence server — admin panel.
 *
 * Signs the vendor in with the password chosen during /setup/ and offers the
 * day-to-day work: creating, finding, revoking, renewing and moving licences,
 * the admin API token and backups. The application itself lives outside the
 * web root, in recoverx-licensing/ next to public_html.
 */

declare(strict_types=1);

$bootstrap = dirname(__DIR__, 2) . '/recoverx-licensing/app/bootstrap.php';

if (!is_file($bootstrap)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo "The licence server files are missing: upload the recoverx-licensing folder next to public_html (see the README).\n";
    exit;
}

require $bootstrap;

try {
    \RecoverX\Licensing\Admin\Panel::run(
        new \RecoverX\Licensing\App(\RecoverX\Licensing\Paths::detect(\RecoverX\Licensing\app_dir())),
    );
} catch (\Throwable $error) {
    \RecoverX\Licensing\fail_safely($error, 'html');
}

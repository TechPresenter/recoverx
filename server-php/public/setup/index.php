<?php

/*
 * RecoverX licence server — one-time setup.
 *
 * Creates the private data folder, the signing key, the admin password and
 * the database, then locks itself. Afterwards it answers "already set up"
 * until data/setup.lock is deleted through the File Manager.
 */

declare(strict_types=1);

$bootstrap = dirname(__DIR__, 2) . '/recoverx-licensing/app/bootstrap.php';

if (!is_file($bootstrap)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo "The licence server files are missing.\n\n"
        . "Upload the recoverx-licensing folder so that it sits NEXT TO public_html (not inside it):\n\n"
        . "  domains/<your site>/public_html/\n"
        . "  domains/<your site>/recoverx-licensing/app/bootstrap.php\n";
    exit;
}

require $bootstrap;

try {
    \RecoverX\Licensing\Setup\SetupPage::run(
        new \RecoverX\Licensing\App(\RecoverX\Licensing\Paths::detect(\RecoverX\Licensing\app_dir())),
    );
} catch (\Throwable $error) {
    \RecoverX\Licensing\fail_safely($error, 'html');
}

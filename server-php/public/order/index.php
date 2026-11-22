<?php

/*
 * RecoverX licence server — the website's order form.
 *
 * /buy/ on the static website posts its order form here. The request is
 * stored for the admin panel's Orders page and e-mailed to the vendor through
 * Amazon SES, and the visitor is sent on to /buy/sent/ or /buy/error/. The
 * application itself lives outside the web root, in recoverx-licensing/ next
 * to public_html.
 */

declare(strict_types=1);

$bootstrap = dirname(__DIR__, 2) . '/recoverx-licensing/app/bootstrap.php';

if (!is_file($bootstrap)) {
    http_response_code(303);
    header('Location: /buy/error/');
    header('Cache-Control: no-store');
    exit;
}

require $bootstrap;

try {
    \RecoverX\Licensing\Order\OrderForm::run(
        new \RecoverX\Licensing\App(\RecoverX\Licensing\Paths::detect(\RecoverX\Licensing\app_dir())),
    );
} catch (\Throwable $error) {
    \RecoverX\Licensing\fail_safely($error, 'html');
}

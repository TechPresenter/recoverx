<?php

/*
 * RecoverX licence server — provision from the command line.
 *
 * FOR TESTS AND LOCAL DEVELOPMENT ONLY. Does what /setup/ does — data folder,
 * signing key, database, configuration, lock — through the same Installer,
 * so a test server is set up exactly like a real one. On the real host, use
 * /setup/ in the browser.
 *
 *   php -d extension=sodium app/bin/provision.php --password=<pw> [options]
 *
 *   --password=<text>            admin password (at least 12 characters)  [required]
 *   --site-url=<url>             base URL shown in build values (default http://127.0.0.1)
 *   --import-pem=<file>          use this PKCS#8 PEM instead of generating a key
 *   --api-token=<token>          enable the JSON admin API with this bearer token
 *   --data-dir=<dir>             write config.local.php pointing the data folder here
 *   --set=<name>=<value>         override a setting (repeatable), e.g. --set=self_release_limit=2
 *
 * Prints a JSON object: publicKey, fingerprint, activationUrl, dataDir.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require dirname(__DIR__) . '/bootstrap.php';

use RecoverX\Licensing\Config;
use RecoverX\Licensing\Paths;
use RecoverX\Licensing\Setup\Installer;

/** @return array{0: array<string, string>, 1: list<string>} */
function parse_arguments(array $argv): array
{
    $options = [];
    $sets = [];
    foreach (array_slice($argv, 1) as $argument) {
        if (preg_match('/^--([a-z-]+)=(.*)$/s', $argument, $match) !== 1) {
            fwrite(STDERR, "Unrecognised argument: {$argument}\n");
            exit(2);
        }
        if ($match[1] === 'set') {
            $sets[] = $match[2];
        } else {
            $options[$match[1]] = $match[2];
        }
    }

    return [$options, $sets];
}

[$options, $sets] = parse_arguments($argv);

$password = $options['password'] ?? '';
$problem = Config::passwordProblem($password, $password);
if ($problem !== null) {
    fwrite(STDERR, "--password: {$problem}\n");
    exit(2);
}

$settings = [];
foreach ($sets as $assignment) {
    [$name, $value] = array_pad(explode('=', $assignment, 2), 2, '');
    if (!array_key_exists($name, Config::DEFAULTS)) {
        fwrite(STDERR, "--set: {$name} is not a setting\n");
        exit(2);
    }
    $settings[$name] = is_bool(Config::DEFAULTS[$name])
        ? in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true)
        : (preg_match('/^\d+$/D', $value) === 1 ? (int) $value : $value);
}

$appDir = \RecoverX\Licensing\app_dir();

if (isset($options['data-dir'])) {
    $local = dirname($appDir) . '/config.local.php';
    file_put_contents($local, "<?php\n\nreturn " . var_export(['data_dir' => $options['data-dir']], true) . ";\n");
}

$paths = Paths::detect($appDir);
$pem = null;
if (isset($options['import-pem'])) {
    $pem = file_get_contents($options['import-pem']);
    if ($pem === false) {
        fwrite(STDERR, "--import-pem: could not read {$options['import-pem']}\n");
        exit(2);
    }
}

$siteUrl = rtrim($options['site-url'] ?? 'http://127.0.0.1', '/');
$token = $options['api-token'] ?? null;
if ($token !== null && preg_match('/^[\x21-\x7e]{32,}$/D', $token) !== 1) {
    fwrite(STDERR, "--api-token: use at least 32 printable ASCII characters without spaces\n");
    exit(2);
}

$result = (new Installer($paths))->install($password, $pem, $siteUrl, $settings, $token);
$key = $result['key'];

echo json_encode([
    'publicKey' => $key->publicKeySpki(),
    'fingerprint' => $key->fingerprint(),
    'activationUrl' => $siteUrl . '/v1/activate',
    'dataDir' => $paths->dataDir,
    'generated' => $result['generated'],
    'kept' => $result['kept'],
], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), "\n";

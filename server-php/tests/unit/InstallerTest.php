<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\App;
use RecoverX\Licensing\Config;
use RecoverX\Licensing\ConfigError;
use RecoverX\Licensing\Http\Request;
use RecoverX\Licensing\Paths;
use RecoverX\Licensing\Setup\Installer;
use RecoverX\Licensing\Setup\SetupPage;
use RecoverX\Licensing\SigningKey;
use RecoverX\Licensing\Store;

/* Setup, configuration and the private data folder. */

function paths(): Paths
{
    $root = Kit::tempDir('rx-setup-');
    mkdir($root . '/recoverx-licensing/app', 0700, true);

    return Paths::detect($root . '/recoverx-licensing/app');
}

test('installs the data folder, key, database, configuration and lock', function (): void {
    $paths = paths();
    $result = (new Installer($paths))->install('correct horse battery staple', null, 'https://licensing.test');

    Assert::same(true, $result['generated']);
    foreach ([$paths->configFile(), $paths->signingKeyFile(), $paths->databaseFile(), $paths->lockFile(), $paths->dataDir . '/.htaccess'] as $file) {
        Assert::true(is_file($file), $file);
    }
    Assert::matches('/Require all denied/', (string) file_get_contents($paths->dataDir . '/.htaccess'));
    Assert::same($result['key']->fingerprint(), SigningKey::fromPem((string) file_get_contents($paths->signingKeyFile()))->fingerprint());

    $config = Config::load($paths);
    Assert::true(password_verify('correct horse battery staple', $config->adminPasswordHash()));
    Assert::same(null, $config->apiTokenHash());
    Assert::same(Config::DEFAULTS, $config->settings);
    Assert::same('https://licensing.test', $config->siteUrl());
    Assert::true((new App($paths))->isSetUp());

    if (PHP_OS_FAMILY !== 'Windows') {
        Assert::same('0600', substr(sprintf('%o', fileperms($paths->signingKeyFile())), -4));
        Assert::same('0700', substr(sprintf('%o', fileperms($paths->dataDir)), -4));
    }
});

test('keeps an existing signing key when setup runs again', function (): void {
    $paths = paths();
    $installer = new Installer($paths);
    $first = $installer->install('correct horse battery staple', null, 'https://licensing.test', [], 'token-token-token-token-token-token-1');
    unlink($paths->lockFile());

    $second = $installer->install('a different password entirely', SigningKey::generate()->toPem(), 'https://licensing.test');

    Assert::same(true, $second['kept']);
    Assert::same($first['key']->fingerprint(), $second['key']->fingerprint());
    $config = Config::load($paths);
    Assert::true(password_verify('a different password entirely', $config->adminPasswordHash()));
    Assert::same(Config::hashApiToken('token-token-token-token-token-token-1'), $config->apiTokenHash(), 'the API token survives');
});

test('imports a PKCS#8 key instead of generating one', function (): void {
    $paths = paths();
    $key = SigningKey::generate();
    $result = (new Installer($paths))->install('correct horse battery staple', $key->toPem(), 'https://licensing.test');

    Assert::same(false, $result['generated']);
    Assert::same($key->fingerprint(), $result['key']->fingerprint());
    Assert::same($key->toPem(), file_get_contents($paths->signingKeyFile()));
});

test('guards setup with a one-time code from the data folder', function (): void {
    $paths = paths();
    $installer = new Installer($paths);
    $installer->prepareDataDirectory();

    Assert::same(false, $installer->checkSetupCode('anything'), 'no code has been issued yet');

    $code = $installer->setupCode();
    Assert::matches('/^[2-9A-HJ-NP-TV-Z]{5}(-[2-9A-HJ-NP-TV-Z]{5}){3}$/', $code);
    Assert::same($code, $installer->setupCode(), 'stable until used');
    Assert::true($installer->checkSetupCode($code));
    Assert::true($installer->checkSetupCode(' ' . strtolower(str_replace('-', '', $code)) . ' '));
    Assert::same(false, $installer->checkSetupCode(''));
    Assert::same(false, $installer->checkSetupCode(substr($code, 0, -1) . (str_ends_with($code, 'Q') ? 'R' : 'Q')));

    $installer->install('correct horse battery staple', null, 'https://licensing.test');
    Assert::same(false, is_file($paths->setupCodeFile()), 'the code is deleted when setup completes');
});

test('reads overrides from config.local.php, including a different data folder', function (): void {
    $root = Kit::tempDir('rx-local-');
    $appDir = $root . '/recoverx-licensing/app';
    mkdir($appDir, 0700, true);
    file_put_contents($root . '/recoverx-licensing/config.local.php', "<?php return ['data_dir' => " . var_export($root . '/private-data', true) . ", 'trust_proxy' => true, 'self_release_limit' => 0];");

    $paths = Paths::detect($appDir);
    Assert::same($root . '/private-data', $paths->dataDir);

    (new Installer($paths))->install('correct horse battery staple', null, 'https://licensing.test');
    $config = Config::load($paths);
    Assert::same(true, $config->settings['trust_proxy']);
    Assert::same(0, $config->settings['self_release_limit']);
});

test('refuses settings it cannot apply, naming every problem', function (): void {
    Assert::throws(ConfigError::class, static fn () => Config::validate(['rate_limit_burst' => 0, 'trust_proxy' => 'yes', 'colour' => 'red']),
        '/trust_proxy must be true, false or the number of proxies in front, from 1 to 10; rate_limit_burst must be a whole number from 1 to 100000; colour is not a setting/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['self_release_window_days' => 3651]), '/3650/');
    Assert::same(0, Config::validate(['self_release_limit' => 0])['self_release_limit']);

    // trust_proxy also counts proxies, one entry each.
    Assert::same(2, Config::validate(['trust_proxy' => 2])['trust_proxy']);
    foreach ([0, 11, '1', 1.0] as $wrong) {
        Assert::throws(ConfigError::class, static fn () => Config::validate(['trust_proxy' => $wrong]), '/trust_proxy must be/');
    }
});

test('setup refuses a data folder inside another site’s public_html, where a subdomain’s folder puts it', function (): void {
    // hPanel's default for a subdomain: its folder inside the main site's
    // public_html. The entry points look one level up, so the program and
    // its data land inside the main site's public_html — outside this
    // site's document root, but served by the main site.
    $root = str_replace('\\', '/', (string) realpath(Kit::tempDir('rx-subdomain-')));
    $main = $root . '/domains/snapkio.com';
    mkdir($main . '/public_html/recoverx', 0700, true);
    mkdir($main . '/public_html/recoverx-licensing/app', 0700, true);
    $paths = Paths::detect($main . '/public_html/recoverx-licensing/app');
    $request = new Request('GET', '/setup/', [], '127.0.0.1', true, null, [], [], $main . '/public_html/recoverx');

    $page = (new SetupPage(new App($paths), $request))->handle();
    Assert::same(503, $page->status);
    Assert::true(str_contains($page->body, '<strong>The data folder is inside <code>public_html</code></strong> (<code>public_html/recoverx-licensing/data</code>)'));
    Assert::true(str_contains($page->body, '<code>\'data_dir\' =&gt; \'' . $main . '/recoverx-data\'</code>'));
    Assert::notContains('The data folder is outside the website folder', $page->body);

    // The suggested folder, and the layout the README describes, are fine.
    Assert::same($main . '/public_html', Paths::webFolderAbove($paths->dataDir));
    Assert::same(null, Paths::webFolderAbove($main . '/recoverx-data'));
    Assert::same(null, Paths::webFolderAbove($root . '/domains/recoverx.snapkio.com/recoverx-licensing/data'));
    // Other hosts' names for the web folder, and a VPS's /var/www, which is not served itself.
    Assert::same('C:/xampp/htdocs', Paths::webFolderAbove('C:\\xampp\\htdocs\\recoverx-licensing\\no-such-data'));
    Assert::same('/srv/site/httpdocs', Paths::webFolderAbove('/srv/site/httpdocs/recoverx-licensing/data'));
    Assert::same(null, Paths::webFolderAbove('/var/www/recoverx-licensing/data'));
});

test('forgets failed admin sign-ins when setup runs again, the way back in after a lockout', function (): void {
    ['paths' => $paths] = Kit::installation();
    $store = Store::open($paths->databaseFile());
    $store->recordLoginFailure('203.0.113.7', Kit::NOW);
    $store->recordLoginFailure('198.51.100.4', Kit::NOW);
    Assert::same(2, $store->countLoginFailures(null, 0));

    (new Installer($paths))->install('another horse battery staple', null, 'https://licensing.test');
    Assert::same(0, $store->countLoginFailures(null, 0));
});

test('says the server is not set up rather than failing obscurely', function (): void {
    $paths = paths();
    Assert::throws(ConfigError::class, static fn () => Config::load($paths), '/not set up yet/');
    Assert::same(false, (new App($paths))->isSetUp());
    Assert::throws(ConfigError::class, static fn () => (new App($paths))->store(), '/not set up/');
});

test('checks admin passwords', function (): void {
    Assert::matches('/at least 12/', (string) Config::passwordProblem('short', 'short'));
    Assert::matches('/do not match/', (string) Config::passwordProblem('long enough password', 'long enough passwort'));
    Assert::matches('/could not be read/', (string) Config::passwordProblem("bad \xff bytes here!", "bad \xff bytes here!"));
    Assert::same(null, Config::passwordProblem('long enough password', 'long enough password'));
});

test('writes the configuration atomically as PHP that only returns data', function (): void {
    $paths = paths();
    (new Installer($paths))->prepareDataDirectory();
    Config::write($paths, ['admin_password_hash' => 'x', 'site_url' => "'; system('id'); //", 'settings' => []]);

    $loaded = include $paths->configFile();
    Assert::same("'; system('id'); //", $loaded['site_url']);
    Assert::same([], glob($paths->dataDir . '/.*.tmp') ?: []);
});

test('makes admin API tokens that the reference server would also accept', function (): void {
    $token = Config::newApiToken();
    Assert::matches('/^[A-Za-z0-9_-]{43}$/', $token);
    Assert::same(hash('sha256', $token), Config::hashApiToken($token));
});

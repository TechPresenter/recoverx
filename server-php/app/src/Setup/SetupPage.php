<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Setup;

use RecoverX\Licensing\App;
use RecoverX\Licensing\Config;
use RecoverX\Licensing\Http\Request;
use RecoverX\Licensing\Http\Response;
use RecoverX\Licensing\Paths;
use RecoverX\Licensing\SigningKey;
use RecoverX\Licensing\Web\Html;
use RecoverX\Licensing\Web\Session;

/**
 * The one-time installer at /setup/.
 *
 * 1. Checks the environment and says exactly how to fix what is missing.
 * 2. Asks for the one-time setup code — a random code written into the
 *    private data folder, readable only through the File Manager — so a
 *    stranger who finds /setup/ before the vendor cannot complete it.
 * 3. Generates the signing key on the server (or imports an existing one),
 *    takes the admin password, creates the database and locks itself.
 * 4. Shows the two build values and offers a backup of the signing key, once.
 *
 * The signing key never leaves the server except in that vendor-initiated
 * download (and later from the admin panel's Backup page).
 */
final class SetupPage
{
    /** How long after completing setup the key backup may still be downloaded here. */
    private const DOWNLOAD_WINDOW_SECONDS = 1800;

    private readonly Installer $installer;

    public function __construct(private readonly App $app, private readonly Request $request)
    {
        $this->installer = new Installer($app->paths);
    }

    public static function run(App $app): void
    {
        $request = Request::fromGlobals();
        (new self($app, $request))->handle()->send($request->method === 'HEAD');
    }

    public function handle(): Response
    {
        $paths = $this->app->paths;

        if (!$this->secureEnough()) {
            return Html::page('HTTPS required', Html::notice('error', '<p><strong>Open this page over HTTPS.</strong> '
                . 'Setup sends your new admin password, so it only runs on an encrypted connection. Use '
                . '<code>https://' . Html::e($this->request->header('host') ?? 'your-site') . '/setup/</code>. '
                . 'If the address already starts with https and you still see this, see “Troubleshooting” in the README.</p>'), ['status' => 403]);
        }

        // The checks need the data folder to exist before the session can.
        $checks = $this->environmentChecks();
        $blocking = array_filter($checks, static fn (array $check): bool => $check['level'] === 'fail');

        if ($blocking === []) {
            Session::start($paths, $this->request, 'RXLICSETUP', '/setup/', self::DOWNLOAD_WINDOW_SECONDS);
        }

        $done = $blocking === [] ? ($_SESSION['setup_done'] ?? null) : null;
        $recent = is_array($done) && time() - (int) ($done['at'] ?? 0) < self::DOWNLOAD_WINDOW_SECONDS;

        if (is_file($paths->lockFile())) {
            if ($recent && $this->request->method === 'POST' && $this->request->field('action') === 'download-key') {
                return $this->downloadKey();
            }
            if ($recent) {
                return $this->finishedPage($done);
            }

            return Html::page('Already set up', '<h1>Already set up</h1><div class="card"><p>This licence server has been set up. '
                . 'Sign in at <a href="/admin/">/admin/</a>.</p><p class="muted">To run setup again (for example to reset a forgotten '
                . 'admin password), delete <code>recoverx-licensing/data/setup.lock</code> in the File Manager and reload this page. '
                . 'The signing key and the licence database are kept.</p></div>', ['status' => 404]);
        }

        if ($blocking !== []) {
            return $this->formPage($checks, null, []);
        }

        if ($this->request->method === 'POST') {
            return $this->install($checks);
        }

        $this->installer->setupCode();

        return $this->formPage($checks, null, []);
    }

    /** @param list<array{level: string, text: string}> $checks */
    private function install(array $checks): Response
    {
        $r = $this->request;
        $sticky = ['mode' => $r->field('mode')];

        if (!Session::checkCsrf($r)) {
            return $this->formPage($checks, 'This form expired. It has been reloaded — please fill it in again.', $sticky, 403);
        }

        if (!$this->installer->checkSetupCode($r->field('code'))) {
            usleep(random_int(200_000, 500_000));

            return $this->formPage($checks, 'That setup code is not right. Copy it from recoverx-licensing/data/setup-code.txt in the File Manager.', $sticky, 403);
        }

        $problem = Config::passwordProblem($r->field('password'), $r->field('confirm'));
        if ($problem !== null) {
            return $this->formPage($checks, $problem, $sticky, 400);
        }

        $importPem = null;
        if (!$this->installer->hasSigningKey() && $r->field('mode') === 'import') {
            $importPem = $r->field('pem');
            try {
                SigningKey::fromPem($importPem);
            } catch (\InvalidArgumentException $error) {
                return $this->formPage($checks, $error->getMessage(), $sticky, 400);
            }
        }

        $siteUrl = ($r->https ? 'https://' : 'http://') . ($r->header('host') ?? 'localhost');

        try {
            $result = $this->installer->install($r->field('password'), $importPem, $siteUrl);
        } catch (\Throwable $error) {
            $this->app->logger()->error('Setup failed', ['error' => $error]);

            return $this->formPage($checks, 'Setup could not finish: ' . $error->getMessage(), $sticky, 500);
        }

        $key = $result['key'];
        $this->app->logger()->info('Setup completed', [
            'fingerprint' => $key->fingerprint(),
            'generated' => $result['generated'],
            'kept' => $result['kept'],
            'ip' => $r->remoteAddress,
        ]);

        Session::regenerate();
        $_SESSION['setup_done'] = [
            'at' => time(),
            'publicKey' => $key->publicKeySpki(),
            'fingerprint' => $key->fingerprint(),
            'activationUrl' => $siteUrl . '/v1/activate',
            'generated' => $result['generated'],
            'kept' => $result['kept'],
        ];

        return Html::redirect('./');
    }

    /** @param array<string, mixed> $done */
    private function finishedPage(array $done): Response
    {
        $origin = $done['kept'] ? 'The signing key that was already on this server has been kept.'
            : ($done['generated'] ? 'A new signing key was generated on this server.' : 'Your signing key was imported.');

        $body = '<h1>Setup complete</h1>'
            . Html::notice('ok', '<p>The licence server is ready. ' . Html::e($origin) . '</p>')
            . '<div class="card"><h2>1. Back up the signing key — now</h2>'
            . '<p>Every licence you sell is signed with this key. If it is lost, no new activation can be issued that existing '
            . 'copies of RecoverX will accept, and a new key means rebuilding the application. Download it and keep it '
            . 'offline, in two places (for example a password manager and a USB stick in a drawer). Never e-mail it.</p>'
            . '<form method="post" action="./">' . Session::csrfField()
            . '<input type="hidden" name="action" value="download-key">'
            . '<button type="submit">Download the signing key backup (license-signing-key.pem)</button></form>'
            . '<p class="hint">You can download it again later from the admin panel’s Backup page.</p></div>'
            . '<div class="card"><h2>2. Build values for RecoverX</h2>'
            . '<p>Give these two values to whoever builds the desktop application (they go in the build environment, '
            . 'see docs/BUILDING.md). They are not secret.</p>'
            . Html::copyable('RECOVERX_LICENSE_PUBLIC_KEY=' . $done['publicKey'], 'Public key build value')
            . '<p></p>'
            . Html::copyable('RECOVERX_ACTIVATION_URL=' . $done['activationUrl'], 'Activation URL build value')
            . '<p class="hint">Public key fingerprint: <code>' . Html::e($done['fingerprint']) . '</code></p></div>'
            . '<div class="card"><h2>3. Sign in</h2><p>Open the <a href="/admin/">admin panel</a> with the password you just chose. '
            . 'This setup page is now locked.</p></div>';

        return Html::page('Setup complete', $body);
    }

    private function downloadKey(): Response
    {
        if (!Session::checkCsrf($this->request)) {
            return Html::page('Expired', Html::notice('error', 'This page expired. Download the key from the admin panel’s Backup page instead.'), ['status' => 403]);
        }

        $pem = @file_get_contents($this->app->paths->signingKeyFile());
        if ($pem === false) {
            return Html::page('Missing key', Html::notice('error', 'The signing key file could not be read.'), ['status' => 500]);
        }

        $this->app->logger()->info('Signing key backup downloaded', ['via' => 'setup', 'ip' => $this->request->remoteAddress]);

        return Html::download('license-signing-key.pem', $pem, 'application/x-pem-file');
    }

    /**
     * @param list<array{level: string, text: string}> $checks
     * @param array<string, string> $sticky
     */
    private function formPage(array $checks, ?string $error, array $sticky, int $status = 200): Response
    {
        $list = '';
        foreach ($checks as $check) {
            $list .= '<li class="check ' . $check['level'] . '">' . $check['text'] . '</li>';
        }

        $blocking = array_filter($checks, static fn (array $check): bool => $check['level'] === 'fail');

        $body = '<h1>Set up the licence server</h1>'
            . ($error === null ? '' : Html::notice('error', Html::e($error)))
            . '<div class="card"><h2>Checks</h2><ul class="checks">' . $list . '</ul></div>';

        if ($blocking !== []) {
            $body .= Html::notice('error', '<p>Fix the items marked ✖ above, then reload this page.</p>');

            return Html::page('Setup', $body, ['status' => $status === 200 ? 503 : $status]);
        }

        $existing = null;
        try {
            $existing = $this->installer->existingKey();
        } catch (\Throwable) {
            $existing = null;
        }

        $mode = ($sticky['mode'] ?? '') === 'import' ? 'import' : 'generate';
        $keySection = $existing !== null
            ? '<p>A signing key already exists on this server (fingerprint <code>' . Html::e($existing->fingerprint()) . '</code>). '
                . 'It will be kept, so every licence already issued stays valid.</p>'
            : '<label class="inline"><input type="radio" name="mode" value="generate"' . ($mode === 'generate' ? ' checked' : '') . '> '
                . 'Generate a new key on this server (recommended for a first installation)</label><br>'
                . '<label class="inline"><input type="radio" name="mode" value="import"' . ($mode === 'import' ? ' checked' : '') . '> '
                . 'Import the key I already use (license-signing-key.pem from <code>npm run licensing:keys</code>)</label>'
                . '<label for="pem">Private key to import (only when importing)</label>'
                . '<textarea id="pem" name="pem" rows="5" autocomplete="off" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>'
                . '<p class="hint">Import only if desktop builds have already shipped with that key’s public half. '
                . 'Otherwise generate a new one.</p>';

        $body .= '<form method="post" action="./" class="card" autocomplete="off">' . Session::csrfField()
            . '<h2>1. Setup code</h2>'
            . '<p>To prove you control this hosting account, open the File Manager in hPanel, go to '
            . '<code>recoverx-licensing/data/</code>, open <code>setup-code.txt</code> and copy the code here.</p>'
            . '<label for="code">Setup code</label><input id="code" name="code" required autocomplete="off" placeholder="XXXXX-XXXXX-XXXXX-XXXXX">'
            . '<h2>2. Signing key</h2>' . $keySection
            . '<h2>3. Admin password</h2>'
            . '<p>For the admin panel at <code>/admin/</code>. At least ' . Config::MIN_PASSWORD_LENGTH . ' characters; '
            . 'a passphrase of four or five unrelated words is ideal. It is stored only as a one-way hash.</p>'
            . '<label for="password">Password</label><input id="password" type="password" name="password" required minlength="'
            . Config::MIN_PASSWORD_LENGTH . '" autocomplete="new-password">'
            . '<label for="confirm">Password again</label><input id="confirm" type="password" name="confirm" required autocomplete="new-password">'
            . '<p></p><button type="submit">Finish setup</button></form>';

        return Html::page('Setup', $body, ['status' => $status]);
    }

    /**
     * What this host has and lacks, each with the fix in hPanel's terms.
     *
     * @return list<array{level: string, text: string}>
     */
    private function environmentChecks(): array
    {
        $paths = $this->app->paths;
        $checks = [];
        $extensions = 'In hPanel open Websites → Advanced → PHP Configuration → PHP extensions, tick <strong>%s</strong> and save.';

        $checks[] = PHP_VERSION_ID >= 80100
            ? ['level' => 'pass', 'text' => 'PHP ' . Html::e(PHP_VERSION)]
            : ['level' => 'fail', 'text' => 'PHP 8.1 or newer is needed (this site runs ' . Html::e(PHP_VERSION) . '). In hPanel open Websites → Advanced → PHP Configuration and choose PHP 8.3.'];

        $checks[] = function_exists('sodium_crypto_sign_detached')
            ? ['level' => 'pass', 'text' => 'sodium (Ed25519 signing)']
            : ['level' => 'fail', 'text' => 'The <strong>sodium</strong> extension is missing. ' . sprintf($extensions, 'sodium')];

        $sqlite = class_exists(\PDO::class) && in_array('sqlite', \PDO::getAvailableDrivers(), true);
        if (!$sqlite) {
            $checks[] = ['level' => 'fail', 'text' => 'The <strong>pdo_sqlite</strong> extension is missing. ' . sprintf($extensions, 'pdo_sqlite')];
        } else {
            $version = (string) (new \PDO('sqlite::memory:'))->query('SELECT sqlite_version()')->fetchColumn();
            $checks[] = version_compare($version, '3.8.3', '>=')
                ? ['level' => 'pass', 'text' => 'SQLite ' . Html::e($version)]
                : ['level' => 'fail', 'text' => 'SQLite ' . Html::e($version) . ' is too old (3.8.3 or newer is needed). Choose a newer PHP version in hPanel.'];
        }

        $checks[] = function_exists('mb_strtoupper')
            ? ['level' => 'pass', 'text' => 'mbstring']
            : ['level' => 'warn', 'text' => 'The <strong>mbstring</strong> extension is off. Licence keys still work; enabling it makes unusual typed input behave exactly like the desktop app. ' . sprintf($extensions, 'mbstring')];

        try {
            (new Installer($paths))->prepareDataDirectory();
            $writable = is_writable($paths->dataDir);
        } catch (\Throwable) {
            $writable = false;
        }

        $checks[] = $writable
            ? ['level' => 'pass', 'text' => 'The private data folder can be written: <code>' . Html::e(self::shortPath($paths)) . '</code>']
            : ['level' => 'fail', 'text' => 'The private data folder <code>' . Html::e(self::shortPath($paths)) . '</code> could not be created or written. '
                . 'In the File Manager, check that the <code>recoverx-licensing</code> folder exists next to <code>public_html</code> and that its permissions are 755.'];

        $webFolder = Paths::webFolderAbove($paths->dataDir);
        if (Paths::isInside($paths->dataDir, $this->request->documentRoot)) {
            $checks[] = ['level' => 'fail', 'text' => '<strong>The data folder is inside the website folder</strong>, where it could be downloaded. '
                . 'Move <code>recoverx-licensing</code> out of <code>public_html</code> so it sits next to it.'];
        } elseif ($webFolder !== null) {
            // Typically a subdomain kept inside the main site's public_html:
            // outside this site's folder, but inside the main site's.
            $checks[] = ['level' => 'fail', 'text' => '<strong>The data folder is inside <code>' . Html::e(basename($webFolder)) . '</code></strong> '
                . '(<code>' . Html::e(self::below($paths->dataDir, dirname($webFolder))) . '</code>), a folder a website is served from, '
                . 'so it could be downloaded through that website. This happens when this site’s folder was made inside another site’s '
                . '<code>public_html</code>, as hPanel does for a subdomain. Keep the data elsewhere: in <code>recoverx-licensing/config.local.php</code> set '
                . '<code>\'data_dir\' =&gt; \'' . Html::e(dirname($webFolder) . '/recoverx-data') . '\'</code> (README → Settings), then reload this page.'];
        } else {
            $checks[] = ['level' => 'pass', 'text' => 'The data folder is outside the website folder'];
        }

        $checks[] = $this->request->https
            ? ['level' => 'pass', 'text' => 'HTTPS']
            : ['level' => 'warn', 'text' => 'This page was not opened over HTTPS. Turn on the free SSL certificate in hPanel (Security → SSL) and use https:// addresses.'];

        return $checks;
    }

    /** `$path` relative to `$folder` when it lies below it. */
    private static function below(string $path, string $folder): string
    {
        $real = realpath($path);
        $path = str_replace('\\', '/', $real === false ? $path : $real);
        $folder = rtrim(str_replace('\\', '/', $folder), '/') . '/';

        return str_starts_with($path, $folder) ? substr($path, strlen($folder)) : $path;
    }

    /** The data folder relative to the domain folder, without the hosting account's home path. */
    private static function shortPath(Paths $paths): string
    {
        $parent = dirname($paths->installDir);

        return str_starts_with($paths->dataDir, $parent . '/') ? substr($paths->dataDir, strlen($parent) + 1) : basename($paths->installDir) . '/data';
    }

    /** Setup sends a password: only over HTTPS, or from this computer during development. */
    private function secureEnough(): bool
    {
        if ($this->request->https || $this->request->isLoopback()) {
            return true;
        }

        try {
            $local = Paths::readLocalConfig($this->app->paths->localConfigFile());
        } catch (\Throwable) {
            return false;
        }

        return ($local['allow_insecure_admin'] ?? false) === true;
    }
}

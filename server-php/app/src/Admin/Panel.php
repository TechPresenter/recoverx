<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Admin;

use RecoverX\Licensing\App;
use RecoverX\Licensing\Authority;
use RecoverX\Licensing\Config;
use RecoverX\Licensing\Http\Api;
use RecoverX\Licensing\Http\Request;
use RecoverX\Licensing\Http\Response;
use RecoverX\Licensing\Js;
use RecoverX\Licensing\LicenseError;
use RecoverX\Licensing\LicenseKey;
use RecoverX\Licensing\Mail\LicenceMail;
use RecoverX\Licensing\Mail\MailError;
use RecoverX\Licensing\RateLimiter;
use RecoverX\Licensing\Store;
use RecoverX\Licensing\Web\Html;
use RecoverX\Licensing\Web\Session;

/**
 * The admin web panel at /admin/.
 *
 * One password (chosen during setup), a session cookie that is HttpOnly,
 * SameSite=Strict and Secure on HTTPS, a CSRF token on every form, sign-in
 * throttling per address and overall (stored in the database, since PHP keeps
 * nothing between requests), and an idle timeout. Every action goes through
 * the same `Authority` the JSON API uses, and is recorded in the licence's
 * history with the actor `admin-panel`. Orders from the website's form
 * (`Order\OrderForm`) are listed, followed up and deleted here too; creating
 * licences with an order's reference marks it licensed.
 *
 * The password is asked for again before the signing key is downloaded and
 * before it is changed. Those checks count as failed sign-ins too, and enough
 * of them end the session: a borrowed session cannot be used to guess the
 * password, and with it the key, at leisure.
 *
 * Every POST is answered with a redirect (post/redirect/get), so refreshing a
 * page never repeats an action; what an action produced — new keys, an
 * offline activation, a new API token — is shown once from the session.
 */
final class Panel
{
    private const SESSION_NAME = 'RXLICADMIN';

    /** A session ends after this long, active or not. */
    private const MAX_SESSION_SECONDS = 12 * 3600;

    private const LOGIN_WINDOW_MS = 15 * 60_000;

    /** Wrong passwords one address may give in the window, at sign-in or inside a session. */
    private const LOGIN_LIMIT_PER_CLIENT = 5;

    /**
     * Wrong passwords from everywhere in the window after which an address
     * that has itself failed waits too — so many addresses cannot each spend
     * their own allowance. An address with no failure of its own may still
     * try: otherwise anyone with twenty addresses could keep the vendor out.
     */
    private const LOGIN_LIMIT_OVERALL = 100;

    private const PAGE_SIZE = 50;

    /** Longest note the vendor may keep on an order, in characters (as the form's maxlength counts them). */
    private const NOTES_MAX = 2000;

    /** The approved price list (2026-11-12), shown as hints when creating licences. */
    public const EDITIONS = [
        'professional' => ['Professional', '1 computer', '₹2,499 per year'],
        'business' => ['Business', '3 computers', '₹5,999 per year'],
        'technician' => ['Technician', 'unlimited computers (use on customers’ PCs)', '₹14,999 per year'],
        'enterprise' => ['Enterprise', 'unlimited computers', 'contact sales (info@appsgain.in)'],
    ];

    private ?string $signedOutNotice = null;

    public function __construct(private readonly App $app, private readonly Request $request)
    {
    }

    public static function run(App $app): void
    {
        $request = Request::fromGlobals();
        (new self($app, $request))->handle()->send($request->method === 'HEAD');
        $app->housekeeping();
    }

    public function handle(): Response
    {
        if ($this->request->path() === '/admin') {
            return Html::redirect('/admin/');
        }

        if (!$this->app->isSetUp()) {
            return Html::page('Not set up', '<h1>Not set up yet</h1><div class="card"><p>Open <a href="/setup/">/setup/</a> first.</p></div>', ['status' => 503]);
        }

        if (!$this->secureEnough()) {
            return Html::page('HTTPS required', Html::notice('error', '<p><strong>Open the admin panel over HTTPS:</strong> <code>https://'
                . Html::e($this->request->header('host') ?? 'your-site') . '/admin/</code>. It sends your password and licence keys, so it never runs on an unencrypted connection.</p>'), ['status' => 403]);
        }

        $config = $this->app->config();
        Session::start($this->app->paths, $this->request, self::SESSION_NAME, '/admin/', $config->settings['admin_idle_minutes'] * 60);

        $signedIn = $this->checkSession($config);

        if ($this->request->method === 'POST') {
            $action = $this->request->field('action');

            if (!Session::checkCsrf($this->request)) {
                return $signedIn
                    ? $this->page('Expired', Html::notice('error', 'That form had expired, so nothing was changed. Please try again.'), 'dashboard', 403)
                    : $this->loginPage('That sign-in form had expired. Please try again.', 403);
            }

            if ($action === 'login') {
                return $this->login();
            }

            if (!$signedIn) {
                return $this->loginPage($this->signedOutNotice ?? 'Please sign in.', 401);
            }

            return $this->act($action);
        }

        if (!$signedIn) {
            return $this->loginPage($this->signedOutNotice, 200);
        }

        return $this->show($this->query('page'));
    }

    // --- session --------------------------------------------------------------------------

    private function checkSession(Config $config): bool
    {
        $auth = $_SESSION['admin'] ?? null;
        if (!is_array($auth)) {
            return false;
        }

        $now = time();
        $idle = $config->settings['admin_idle_minutes'] * 60;
        $passwordChanged = !hash_equals(self::passwordTag($config), (string) ($auth['pw'] ?? ''));

        if ($passwordChanged || $now - (int) ($auth['seen'] ?? 0) > $idle || $now - (int) ($auth['since'] ?? 0) > self::MAX_SESSION_SECONDS) {
            Session::reset();
            $this->signedOutNotice = $passwordChanged
                ? 'The admin password was changed, so you were signed out.'
                : 'You were signed out after a period without activity.';

            return false;
        }

        $_SESSION['admin']['seen'] = $now;

        return true;
    }

    /** Ties a session to the current password, so changing it signs out everyone else. */
    private static function passwordTag(Config $config): string
    {
        return substr(hash('sha256', $config->adminPasswordHash()), 0, 24);
    }

    private function login(): Response
    {
        $store = $this->app->store();
        $ip = (new Api($this->app))->clientAddress($this->request);
        $client = RateLimiter::clientBucketId($ip);
        $nowMs = $this->app->now();
        $since = $nowMs - self::LOGIN_WINDOW_MS;

        $mine = $store->countLoginFailures($client, $since);
        $throttled = $mine >= self::LOGIN_LIMIT_PER_CLIENT
            || ($mine > 0 && $store->countLoginFailures(null, $since) >= self::LOGIN_LIMIT_OVERALL);
        if ($throttled) {
            $this->app->logger()->warn('Admin sign-in throttled', ['ip' => $ip]);

            return $this->loginPage('Too many failed sign-ins. Wait ' . $this->waitFor($client) . ', then try again.', 429);
        }

        $config = $this->app->config();
        $password = $this->request->field('password');

        if (!password_verify($password, $config->adminPasswordHash())) {
            $store->recordLoginFailure($client, $nowMs);
            $this->app->logger()->warn('Admin sign-in failed', ['ip' => $ip]);

            return $this->loginPage('That password is not right.', 401);
        }

        $store->clearLoginFailures($client);

        if (password_needs_rehash($config->adminPasswordHash(), PASSWORD_DEFAULT)) {
            $this->saveConfig(['admin_password_hash' => Config::hashPassword($password)]);
            $config = $this->app->reloadConfig();
        }

        Session::regenerate();
        $_SESSION['admin'] = ['since' => time(), 'seen' => time(), 'pw' => self::passwordTag($config)];
        $this->app->logger()->info('Admin signed in', ['ip' => $ip]);

        return Html::redirect('./');
    }

    private function loginPage(?string $message, int $status): Response
    {
        $body = '<div class="card login"><h1>Sign in</h1>'
            . ($message === null ? '' : Html::notice($status >= 400 ? 'error' : 'info', Html::e($message)))
            . '<form method="post" action="./">' . Session::csrfField()
            . '<input type="hidden" name="action" value="login">'
            . '<label for="password">Admin password</label>'
            . '<input id="password" type="password" name="password" required autocomplete="current-password" autofocus>'
            . '<p></p><button type="submit">Sign in</button></form>'
            . '<p class="hint">Forgotten the password, or locked out by failed sign-ins? Delete <code>recoverx-licensing/data/setup.lock</code> '
            . 'in the File Manager and run <a href="/setup/">/setup/</a> again; licences and the signing key are kept.</p></div>';

        return Html::page('Sign in', $body, ['status' => $status]);
    }

    /**
     * Ask for the admin password again inside a signed-in session, before
     * something that needs more than a session: downloading the signing key,
     * changing the password.
     *
     * A wrong answer is a failed sign-in of this address, logged and counted
     * with the others. Once the address has had its five, the session ends
     * (`signedOutAfterWrongPasswords`): whoever holds a session they should
     * not cannot try passwords against it until one works.
     *
     * @return 'right'|'wrong'|'signed-out'
     */
    private function reconfirm(#[\SensitiveParameter] string $password, string $purpose): string
    {
        $store = $this->app->store();
        $ip = (new Api($this->app))->clientAddress($this->request);
        $client = RateLimiter::clientBucketId($ip);
        $nowMs = $this->app->now();
        $failures = $store->countLoginFailures($client, $nowMs - self::LOGIN_WINDOW_MS);

        if ($failures < self::LOGIN_LIMIT_PER_CLIENT) {
            if (password_verify($password, $this->app->config()->adminPasswordHash())) {
                $store->clearLoginFailures($client);

                return 'right';
            }

            $store->recordLoginFailure($client, $nowMs);
            $failures += 1;
            $this->app->logger()->warn('Admin password check failed', ['for' => $purpose, 'ip' => $ip]);
        }

        if ($failures < self::LOGIN_LIMIT_PER_CLIENT) {
            return 'wrong';
        }

        Session::reset();
        $this->app->logger()->warn('Admin signed out after repeated wrong passwords', ['ip' => $ip]);

        return 'signed-out';
    }

    private function signedOutAfterWrongPasswords(): Response
    {
        $client = RateLimiter::clientBucketId((new Api($this->app))->clientAddress($this->request));

        return $this->loginPage('Too many wrong passwords, so you were signed out. Wait ' . $this->waitFor($client) . ', then sign in again.', 429);
    }

    /** Until `$client`'s oldest failure in the window leaves it, as "N minutes". */
    private function waitFor(string $client): string
    {
        $nowMs = $this->app->now();
        $oldest = $this->app->store()->oldestLoginFailure($client, $nowMs - self::LOGIN_WINDOW_MS) ?? $nowMs;
        $minutes = max(1, (int) ceil(($oldest + self::LOGIN_WINDOW_MS - $nowMs) / 60_000));

        return $minutes === 1 ? '1 minute' : "{$minutes} minutes";
    }

    private function secureEnough(): bool
    {
        if ($this->request->https || $this->request->isLoopback()) {
            return true;
        }

        try {
            return $this->app->config()->settings['allow_insecure_admin'] === true;
        } catch (\Throwable) {
            return false;
        }
    }

    // --- pages ------------------------------------------------------------------------------

    private function show(string $page): Response
    {
        return match ($page) {
            'licences' => $this->licencesPage(),
            'licence' => $this->licencePage($this->query('key')),
            'orders' => $this->ordersPage(),
            'order' => $this->orderPage($this->query('id')),
            'create' => $this->createFromOrderPage($this->query('order')),
            'created' => $this->createdPage(),
            'api' => $this->apiPage(),
            'backup' => $this->backupPage(),
            'password' => $this->passwordPage(null),
            default => $this->dashboard(),
        };
    }

    private function dashboard(): Response
    {
        $authority = $this->app->authority();
        $store = $this->app->store();
        $now = $this->app->now();
        $counts = $store->countsByEdition($now);
        $config = $this->app->config();
        $settings = $config->settings;
        $signer = $this->app->signer()->key();

        $rows = '';
        $totals = ['active' => 0, 'seats' => 0, 'expired' => 0, 'revoked' => 0];
        $bars = ['active' => '', 'seats' => '', 'expired' => '', 'revoked' => ''];
        foreach (self::EDITIONS as $edition => [$label, $seats]) {
            $c = $counts[$edition];
            $rows .= '<tr><td>' . self::editionChip($edition) . '</td><td>' . $c['active'] . '</td><td>' . $c['expired'] . '</td><td>'
                . $c['revoked'] . '</td><td>' . $c['seats'] . '</td><td class="muted">' . Html::e($seats) . '</td></tr>';
            foreach ($totals as $name => $total) {
                $totals[$name] = $total + (int) $c[$name];
                $bars[$name] .= '<i data-ed="' . Html::e($edition) . '" style="flex-grow:' . (int) $c[$name] . '"></i>';
            }
        }

        $tiles = '';
        foreach (['active' => ['Active licences', 'in good standing'], 'seats' => ['Computers activated now', 'seats in use, all editions'],
            'expired' => ['Expired', 'past their end date'], 'revoked' => ['Revoked', 'can no longer activate']] as $name => [$label, $sub]) {
            $tiles .= '<div class="tile ' . $name . '"><span class="tile-label">' . $label . '</span><span class="tile-value">' . $totals[$name] . '</span>'
                . '<span class="tile-bar" aria-hidden="true">' . $bars[$name] . '</span><span class="tile-sub">' . $sub . '</span></div>';
        }

        $events = '';
        foreach ($store->recentEvents(20) as $event) {
            $events .= $this->eventRow($event, true);
        }

        $policy = $authority->selfReleasePolicy();
        $forwarded = $this->request->header('x-forwarded-for');
        $hops = $config->proxyHops();

        $newOrders = $store->countOrdersByStatus()['new'];
        $ordersNotice = $newOrders === 0 ? '' : Html::notice('warn', '<p><strong>' . ($newOrders === 1 ? '1 new order' : $newOrders . ' new orders')
            . '</strong> from the website order form ' . ($newOrders === 1 ? 'is' : 'are') . ' waiting for a reply. '
            . '<a href="?page=orders&amp;status=new">Open the new orders</a></p>');

        $body = '<h1>Dashboard</h1>' . $ordersNotice . '<div class="tiles">' . $tiles . '</div>' . $this->flashNotice()
            . '<h2>Licences</h2><div class="scroll"><table class="t-editions"><thead><tr><th>Edition</th><th>Active</th><th>Expired</th><th>Revoked</th>'
            . '<th>Computers activated now</th><th>Seats per licence</th></tr></thead><tbody>' . $rows . '</tbody></table></div>'
            . '<h2>Recent activity</h2>'
            . ($events === '' ? '<p class="muted">Nothing yet.</p>'
                : '<div class="scroll"><table class="t-events"><thead><tr><th>When</th><th>What</th><th>Licence</th><th>Computer</th><th>Address</th><th>Details</th></tr></thead><tbody>'
                    . $events . '</tbody></table></div>')
            . '<h2>This server</h2><div class="grid"><div class="card"><dl class="facts">'
            . '<dt>Activation URL</dt><dd><code>' . Html::e(($config->siteUrl() ?? '') . '/v1/activate') . '</code></dd>'
            . '<dt>Public key</dt><dd><code>' . Html::e($signer->fingerprint()) . '</code></dd>'
            . '<dt>Admin API</dt><dd>' . ($config->apiTokenHash() === null ? 'off' : 'on') . ' (<a href="?page=api">manage</a>)</dd>'
            . '<dt>E-mail to customers</dt><dd>' . $this->mailSummary() . '</dd>'
            . '<dt>Self-service moves</dt><dd>' . ($policy['limit'] === 0 ? 'only through support'
                : Html::e($policy['limit'] . ' per licence in ' . $policy['windowDays'] . ' days')) . ' <span class="muted">(unlimited-seat licences are never limited)</span></dd>'
            . '<dt>Activation history</dt><dd>kept ' . $settings['event_retention_days'] . ' days, then deleted (<a href="?page=backup">details</a>)</dd>'
            . '<dt>Rate limit</dt><dd>' . Html::e($settings['rate_limit_burst'] . ' at once, then ' . $settings['rate_limit_per_minute'] . ' a minute, per address') . '</dd>'
            . '</dl></div><div class="card"><dl class="facts">'
            . '<dt>Connection from</dt><dd><code>' . Html::e($this->request->remoteAddress) . '</code></dd>'
            . '<dt>X-Forwarded-For</dt><dd><code>' . Html::e($forwarded ?? '(none)') . '</code></dd>'
            . '<dt>trust_proxy</dt><dd>' . match ($hops) {
                0 => 'off',
                1 => 'on (the last X-Forwarded-For entry)',
                default => "on (entry {$hops} from the end of X-Forwarded-For)",
            } . '</dd>'
            . '<dt>Your address, as the server uses it</dt><dd><code>' . Html::e((new Api($this->app))->clientAddress($this->request)) . '</code></dd></dl>'
            . '<p class="hint">Customers are rate limited, and their activations recorded, by the address on the last line. '
            . 'It should be your own public address. If it is a CDN’s instead, and X-Forwarded-For <em>ends</em> with your address, set '
            . '<code>trust_proxy</code> to <code>true</code> in config.local.php (README → Settings). Only the end of that header '
            . 'is trusted: a visitor can write anything before it.</p></div></div>';

        return $this->page('Dashboard', $body, 'dashboard');
    }

    private function licencesPage(): Response
    {
        $search = Js::trim($this->query('q'));
        $edition = $this->query('edition');
        $standing = $this->query('standing');
        $offset = max(0, (int) $this->query('offset'));

        $filters = [
            'search' => $search === '' ? null : $search,
            'edition' => array_key_exists($edition, self::EDITIONS) ? $edition : null,
            'standing' => in_array($standing, ['active', 'expired', 'revoked'], true) ? $standing : null,
            'limit' => self::PAGE_SIZE + 1,
            'offset' => $offset,
        ];
        $licences = $this->app->authority()->list($filters);
        $more = count($licences) > self::PAGE_SIZE;
        $licences = array_slice($licences, 0, self::PAGE_SIZE);
        $now = $this->app->now();

        $editionOptions = '<option value="">All editions</option>';
        foreach (self::EDITIONS as $value => [$label]) {
            $editionOptions .= '<option value="' . $value . '"' . ($filters['edition'] === $value ? ' selected' : '') . '>' . Html::e($label) . '</option>';
        }
        $standingOptions = '<option value="">Any status</option>';
        foreach (['active' => 'Active', 'expired' => 'Expired', 'revoked' => 'Revoked'] as $value => $label) {
            $standingOptions .= '<option value="' . $value . '"' . ($filters['standing'] === $value ? ' selected' : '') . '>' . $label . '</option>';
        }

        $rows = '';
        foreach ($licences as $licence) {
            $state = Authority::standingOf($licence, $now);
            $rows .= '<tr><td class="mono key"><a href="?page=licence&amp;key=' . rawurlencode($licence['key']) . '">' . Html::e($licence['key']) . '</a></td>'
                . '<td>' . self::editionChip($licence['edition']) . '</td>'
                . '<td>' . Html::e($licence['registeredTo'] ?? '') . '<div class="muted">' . Html::e($licence['email'] ?? '') . '</div></td>'
                . '<td>' . $licence['activeSeats'] . ' / ' . ($licence['maxActivations'] ?? '∞') . '</td>'
                . '<td>' . Html::date($licence['expiresAt']) . '</td>'
                . '<td><span class="badge ' . $state . '">' . $state . '</span></td>'
                . '<td>' . Html::e($licence['orderRef'] ?? '') . '</td>'
                . '<td>' . Html::date($licence['createdAt']) . '</td></tr>';
        }

        $base = '?page=licences&amp;q=' . rawurlencode($search) . '&amp;edition=' . rawurlencode((string) $filters['edition'])
            . '&amp;standing=' . rawurlencode((string) $filters['standing']);
        $pager = '<p class="actions">'
            . ($offset > 0 ? '<a href="' . $base . '&amp;offset=' . max(0, $offset - self::PAGE_SIZE) . '">← Newer</a>' : '')
            . ($more ? '<a href="' . $base . '&amp;offset=' . ($offset + self::PAGE_SIZE) . '">Older →</a>' : '') . '</p>';

        $body = '<h1>Licences</h1>' . $this->flashNotice()
            . '<form method="get" action="./" class="card actions"><input type="hidden" name="page" value="licences">'
            . '<div><label for="q">Search</label><input id="q" name="q" value="' . Html::e($search) . '" placeholder="Key fragment, name, e-mail or order"></div>'
            . '<div><label for="edition">Edition</label><select id="edition" name="edition">' . $editionOptions . '</select></div>'
            . '<div><label for="standing">Status</label><select id="standing" name="standing">' . $standingOptions . '</select></div>'
            . '<div><button type="submit">Search</button></div></form>'
            . ($rows === '' ? '<p class="muted">No licences match.</p>'
                : '<div class="scroll"><table class="t-licences"><thead><tr><th>Key</th><th>Edition</th><th>Registered to</th><th>Computers</th><th>Expires</th>'
                    . '<th>Status</th><th>Order</th><th>Created</th></tr></thead><tbody>' . $rows . '</tbody></table></div>' . $pager);

        return $this->page('Licences', $body, 'licences');
    }

    private function licencePage(string $keyInput): Response
    {
        try {
            $details = $this->app->authority()->show($keyInput);
        } catch (LicenseError $error) {
            return $this->page('Licence', '<h1>Licence</h1>' . Html::notice('error', Html::e($error->getMessage())), 'licences', $error->status);
        }

        $licence = $details['license'];
        $key = $licence['key'];
        $releases = $details['selfReleases'];
        $hiddenKey = '<input type="hidden" name="key" value="' . Html::e($key) . '">';
        $form = fn (string $action, string $inner, string $confirm = ''): string => '<form method="post" action="./"'
            . ($confirm === '' ? '' : ' data-confirm="' . Html::e($confirm) . '"') . '>' . Session::csrfField()
            . '<input type="hidden" name="action" value="' . $action . '">' . $hiddenKey . $inner . '</form>';

        $allowance = $releases['limit'] === null
            ? $releases['recent'] . ' in the last ' . $releases['windowDays'] . ' days — not limited (unlimited seats)'
            : $releases['recent'] . ' of ' . $releases['limit'] . ' in the last ' . $releases['windowDays'] . ' days';

        $facts = '<dl class="facts">'
            . '<dt>Key</dt><dd>' . Html::copyable($key, 'Licence key') . '</dd>'
            . '<dt>Status</dt><dd><span class="badge ' . $details['standing'] . '">' . $details['standing'] . '</span>'
            . ($licence['revokedAt'] === null ? '' : ' since ' . Html::time($licence['revokedAt']) . ($licence['revokeReason'] === null ? '' : ' — ' . Html::e($licence['revokeReason']))) . '</dd>'
            . '<dt>Edition</dt><dd>' . self::editionChip($licence['edition']) . '</dd>'
            . '<dt>Registered to</dt><dd>' . Html::e($licence['registeredTo'] ?? '—') . '</dd>'
            . '<dt>E-mail</dt><dd>' . Html::e($licence['email'] ?? '—') . '</dd>'
            . '<dt>Computers</dt><dd>' . $details['activeSeats'] . ' active of ' . ($licence['maxActivations'] ?? 'unlimited') . '</dd>'
            . '<dt>Self-service moves</dt><dd>' . Html::e($allowance) . '</dd>'
            . '<dt>Expires</dt><dd>' . ($licence['expiresAt'] === null ? 'never (perpetual)' : Html::time($licence['expiresAt'])) . '</dd>'
            . '<dt>Order</dt><dd>' . Html::e($licence['orderRef'] ?? '—') . '</dd>'
            . '<dt>Created</dt><dd>' . Html::time($licence['createdAt']) . '</dd>'
            . '<dt>Notes</dt><dd>' . nl2br(Html::e($licence['notes'] ?? '—')) . '</dd></dl>';

        $revoke = $licence['revokedAt'] === null
            ? $form('revoke', '<label for="reason">Revoke (refund, chargeback…)</label><input id="reason" name="reason" maxlength="500" placeholder="Reason, e.g. refund 12345">'
                . '<p></p><button class="danger" type="submit">Revoke licence</button>', 'Revoke this licence? It stops every new activation and renewal.')
            : $form('restore', '<p>Revoked. Restoring lets it activate again.</p><button type="submit">Restore licence</button>');

        $extend = $form('extend', '<label>Change the end date</label>'
            . '<label class="inline"><input type="radio" name="term" value="days" checked> extend by <input name="days" value="365" inputmode="numeric" style="width:6em"> days</label>'
            . '<label class="inline"><input type="radio" name="term" value="date"> end on <input type="date" name="expires" style="width:11em"></label>'
            . '<label class="inline"><input type="radio" name="term" value="perpetual"> never expire</label>'
            . '<p class="hint">Days are added to the current end date, or to today if it has passed. Computers pick up the new date when they next activate (the app checks automatically).</p>'
            . '<button type="submit">Save end date</button>');

        $offline = $form('offline', '<label for="machine">Offline activation for a computer without internet</label>'
            . '<input id="machine" name="machineId" required placeholder="Computer ID from the customer’s Licence page" class="mono">'
            . '<p></p><button type="submit">Issue offline activation</button>');

        $reset = $form('reset', '<label>Free every computer</label><button class="secondary" type="submit">Reset all seats</button>',
            'Free every computer this licence is active on? Those computers keep working until they next check, then need to activate again.');

        // The privacy policy's promises to the customer: correction and deletion.
        $correction = $form('details', '<label for="d-registeredTo">Registered to</label>'
            . '<input id="d-registeredTo" name="registeredTo" maxlength="200" value="' . Html::e($licence['registeredTo'] ?? '') . '">'
            . '<label for="d-email">E-mail</label><input id="d-email" name="email" type="email" maxlength="254" value="' . Html::e($licence['email'] ?? '') . '">'
            . '<label for="d-notes">Notes</label><textarea id="d-notes" name="notes" rows="3" maxlength="2000">' . Html::e($licence['notes'] ?? '') . '</textarea>'
            . '<p class="hint">To correct details a customer asks you to correct. Their computers show a new name from their next activation.</p>'
            . '<button type="submit">Save details</button>');

        $erase = $form('erase', '<label>Erase personal details</label>'
            . '<p class="hint">For a customer who asks to be deleted: clears the name, e-mail and notes, and the addresses recorded in the history below. '
            . 'The key, dates and computers stay, so the licence keeps working. The order reference stays too until 8 years after the '
            . 'licence has ended, because the sale must stay traceable in your accounts until then; erasing after that removes it as well.</p>'
            . '<button class="danger" type="submit">Erase personal details</button>',
            'Erase the name, e-mail, notes and recorded addresses of this licence? This cannot be undone.');

        $activations = '';
        foreach ($details['activations'] as $activation) {
            $held = $activation['releasedAt'] === null;
            $activations .= '<tr><td class="mono">' . Html::e($activation['machineId']) . '</td><td class="when">' . Html::time($activation['firstActivatedAt'])
                . '</td><td class="when">' . Html::time($activation['lastActivatedAt']) . '</td><td>'
                . ($held ? '<span class="badge active">active</span>' : 'released ' . Html::time($activation['releasedAt'])) . '</td><td>'
                . ($held ? $form('release', '<input type="hidden" name="machineId" value="' . Html::e($activation['machineId']) . '"><button class="secondary" type="submit">Release</button>',
                    'Free this computer’s seat? Not counted against the customer’s self-service moves.') : '')
                . '</td></tr>';
        }

        $events = '';
        foreach ($details['events'] as $event) {
            $events .= $this->eventRow($event, false);
        }

        $body = '<h1>Licence</h1>' . $this->flashNotice()
            . '<div class="card">' . $facts . '</div>'
            . '<h2>Actions</h2><div class="grid"><div class="card">' . $this->emailKeyCard($licence, $form) . '</div>'
            . '<div class="card">' . $revoke . '</div><div class="card">' . $extend . '</div>'
            . '<div class="card">' . $offline . '</div><div class="card">' . $reset . '</div></div>'
            . '<h2>Personal details</h2><div class="grid"><div class="card">' . $correction . '</div><div class="card">' . $erase . '</div></div>'
            . '<h2>Computers</h2>' . ($activations === '' ? '<p class="muted">Never activated.</p>'
                : '<div class="scroll"><table class="t-machines"><thead><tr><th>Computer ID</th><th>First activated</th><th>Last activated</th><th>Seat</th><th><span class="sr-only">Release</span></th></tr></thead><tbody>'
                    . $activations . '</tbody></table></div>')
            . '<h2>History</h2>' . ($events === '' ? '<p class="muted">No events.</p>'
                : '<div class="scroll"><table class="t-history"><thead><tr><th>When</th><th>What</th><th>Computer</th><th>Address</th><th>Details</th></tr></thead><tbody>'
                    . $events . '</tbody></table></div>');

        return $this->page($key, $body, 'licences');
    }

    /** The orders from the website's order form, newest first, as the licences page lists licences. */
    private function ordersPage(): Response
    {
        $store = $this->app->store();
        $search = Js::trim($this->query('q'));
        $status = $this->query('status');
        $offset = max(0, (int) $this->query('offset'));

        $filters = [
            'search' => $search === '' ? null : $search,
            'status' => array_key_exists($status, Store::ORDER_STATUSES) ? $status : null,
            'limit' => self::PAGE_SIZE + 1,
            'offset' => $offset,
        ];
        $orders = $store->listOrders($filters);
        $more = count($orders) > self::PAGE_SIZE;
        $orders = array_slice($orders, 0, self::PAGE_SIZE);
        $counts = $store->countOrdersByStatus();

        $statusOptions = '<option value="">Any status</option>';
        foreach (Store::ORDER_STATUSES as $value => $label) {
            $statusOptions .= '<option value="' . Html::e($value) . '"' . ($filters['status'] === $value ? ' selected' : '') . '>'
                . Html::e($label) . ' (' . $counts[$value] . ')</option>';
        }

        $rows = '';
        foreach ($orders as $order) {
            $rows .= '<tr><td class="when">' . Html::time($order['createdAt']) . '</td>'
                . '<td class="mono key"><a href="?page=order&amp;id=' . $order['id'] . '">' . Html::e($order['ref']) . '</a></td>'
                . '<td>' . self::editionChip($order['edition']) . ' × ' . $order['quantity'] . '</td>'
                . '<td>' . Html::e($order['name']) . '<div class="muted">' . Html::e($order['email']) . '</div></td>'
                . '<td class="mono">' . Html::e($order['phone']) . '</td>'
                . '<td>' . self::orderBadge($order['status']) . '</td></tr>';
        }

        $base = '?page=orders&amp;q=' . rawurlencode($search) . '&amp;status=' . rawurlencode((string) $filters['status']);
        $pager = '<p class="actions">'
            . ($offset > 0 ? '<a href="' . $base . '&amp;offset=' . max(0, $offset - self::PAGE_SIZE) . '">← Newer</a>' : '')
            . ($more ? '<a href="' . $base . '&amp;offset=' . ($offset + self::PAGE_SIZE) . '">Older →</a>' : '') . '</p>';

        $body = '<h1>Orders</h1>' . $this->flashNotice()
            . '<form method="get" action="./" class="card actions"><input type="hidden" name="page" value="orders">'
            . '<div><label for="q">Search</label><input id="q" name="q" value="' . Html::e($search) . '" placeholder="Name, e-mail, mobile, reference or GSTIN"></div>'
            . '<div><label for="status">Status</label><select id="status" name="status">' . $statusOptions . '</select></div>'
            . '<div><button type="submit">Search</button></div></form>'
            . ($rows === '' ? '<p class="muted">' . ($filters['search'] === null && $filters['status'] === null && $offset === 0
                    ? 'No orders yet. Requests sent with the website’s order form appear here.' : 'No orders match.') . '</p>'
                : '<div class="scroll"><table class="t-orders"><thead><tr><th>Received</th><th>Reference</th><th>Edition</th><th>Name</th>'
                    . '<th>Mobile</th><th>Status</th></tr></thead><tbody>' . $rows . '</tbody></table></div>' . $pager)
            . '<p class="hint">Orders are deleted automatically 24 months after they last changed.</p>';

        return $this->page('Orders', $body, 'orders');
    }

    /** One order: everything the customer sent, the vendor's follow-up, and the licences made for it. */
    private function orderPage(string $idInput): Response
    {
        $id = self::orderId($idInput);
        $order = $id === null ? null : $this->app->store()->getOrder($id);
        if ($order === null) {
            return $this->page('Order not found', '<h1>Order not found</h1>' . $this->flashNotice()
                . Html::notice('error', 'There is no such order. It may have been deleted.')
                . '<p><a href="?page=orders">Back to the orders</a></p>', 'orders', 404);
        }

        $none = '—';
        $optional = static fn (?string $value): string => $value === null ? $none : Html::e($value);
        [$label, $seats, $price] = self::EDITIONS[$order['edition']] ?? [$order['edition'], '', ''];
        $tel = '+' . preg_replace('/\D/', '', $order['phone']);
        $mailto = 'mailto:' . str_replace('%40', '@', rawurlencode($order['email']));
        $hiddenId = '<input type="hidden" name="id" value="' . $order['id'] . '">';

        $facts = '<dl class="facts">'
            . '<dt>Reference</dt><dd class="mono">' . Html::e($order['ref']) . '</dd>'
            . '<dt>Status</dt><dd>' . self::orderBadge($order['status']) . '</dd>'
            . '<dt>Received</dt><dd>' . Html::time($order['createdAt']) . '</dd>'
            . '<dt>Last updated</dt><dd>' . Html::time($order['updatedAt']) . '</dd>'
            . '<dt>Edition</dt><dd>' . self::editionChip($order['edition'])
            . ($seats === '' ? '' : ' <span class="muted">' . Html::e("{$seats}; {$price}") . '</span>') . '</dd>'
            . '<dt>Licences</dt><dd>' . $order['quantity'] . '</dd>'
            . '<dt>Name</dt><dd>' . Html::e($order['name']) . '</dd>'
            . '<dt>E-mail</dt><dd><a href="' . Html::e($mailto) . '">' . Html::e($order['email']) . '</a></dd>'
            . '<dt>Mobile</dt><dd><a href="tel:' . Html::e($tel) . '">' . Html::e($order['phone']) . '</a></dd>'
            . '<dt>Register to</dt><dd>' . $optional($order['registerTo']) . '</dd>'
            . '<dt>GSTIN</dt><dd>' . $optional($order['gstin']) . '</dd>'
            . '<dt>E-mailed to you</dt><dd>' . ($order['mailedAt'] === null ? 'not e-mailed' : Html::time($order['mailedAt'])) . '</dd>'
            . '<dt>Message</dt><dd>' . ($order['message'] === null ? $none : nl2br(Html::e($order['message']))) . '</dd>'
            . '<dt>Notes</dt><dd>' . ($order['notes'] === null ? $none : nl2br(Html::e($order['notes']))) . '</dd></dl>';

        $statusOptions = '';
        foreach (Store::ORDER_STATUSES as $value => $statusLabel) {
            $statusOptions .= '<option value="' . Html::e($value) . '"' . ($order['status'] === $value ? ' selected' : '') . '>' . Html::e($statusLabel) . '</option>';
        }

        $update = '<form method="post" action="./">' . Session::csrfField() . '<input type="hidden" name="action" value="order-update">' . $hiddenId
            . '<label>Follow-up</label>'
            . '<label for="o-status">Status</label><select id="o-status" name="status">' . $statusOptions . '</select>'
            . '<label for="o-notes">Notes</label><textarea id="o-notes" name="notes" rows="3" maxlength="' . self::NOTES_MAX . '">' . Html::e($order['notes'] ?? '') . '</textarea>'
            . '<p class="hint">For you only: the customer never sees the status or the notes. Creating this order’s licences sets it to “'
            . Html::e(Store::ORDER_STATUSES['licensed']) . '”.</p>'
            . '<button type="submit">Save</button></form>';

        $delete = '<form method="post" action="./" data-confirm="' . Html::e('Delete order ' . $order['ref'] . '? This cannot be undone.') . '">'
            . Session::csrfField() . '<input type="hidden" name="action" value="order-delete">' . $hiddenId
            . '<label>Delete this order</label>'
            . '<p class="hint">For spam, or a customer who asks to be deleted. Licences already created for it are kept. '
            . 'Otherwise orders are deleted automatically 24 months after they last changed.</p>'
            . '<label class="inline"><input type="checkbox" name="confirm" value="1" required> Yes, delete ' . Html::e($order['ref']) . '</label>'
            . '<p></p><button class="danger" type="submit">Delete order</button></form>';

        $licences = '';
        foreach ($this->app->store()->findByOrderRef($order['ref']) as $licence) {
            $licences .= '<tr><td class="mono key"><a href="?page=licence&amp;key=' . rawurlencode($licence['key']) . '">' . Html::e($licence['key']) . '</a></td>'
                . '<td>' . self::editionChip($licence['edition']) . '</td>'
                . '<td>' . Html::e($licence['registeredTo'] ?? '') . '<div class="muted">' . Html::e($licence['email'] ?? '') . '</div></td>'
                . '<td>' . Html::date($licence['expiresAt']) . '</td>'
                . '<td>' . Html::date($licence['createdAt']) . '</td></tr>';
        }

        $body = '<h1>Order ' . Html::e($order['ref']) . '</h1>' . $this->flashNotice()
            . '<div class="card">' . $facts . '</div>'
            . '<p class="actions"><a href="?page=create&amp;order=' . $order['id'] . '">Create licence for this order</a>'
            . '<a href="' . Html::e($mailto) . '">Reply by e-mail</a><a href="?page=orders">All orders</a></p>'
            . '<h2>Follow-up</h2><div class="grid"><div class="card">' . $update . '</div><div class="card">' . $delete . '</div></div>'
            . '<h2>Licences for this order</h2>' . ($licences === ''
                ? '<p class="muted">None yet. “Create licence for this order” fills in the form from this order, with its reference.</p>'
                : '<div class="scroll"><table class="t-order-licences"><thead><tr><th>Key</th><th>Edition</th><th>Registered to</th><th>Expires</th><th>Created</th></tr></thead><tbody>'
                    . $licences . '</tbody></table></div>');

        return $this->page('Order ' . $order['ref'], $body, 'orders');
    }

    /** The create page, filled in from an order when `?order=` names one. */
    private function createFromOrderPage(string $orderInput): Response
    {
        $id = $orderInput === '' ? null : self::orderId($orderInput);
        $order = $id === null ? null : $this->app->store()->getOrder($id);
        if ($order === null) {
            return $this->createPage([], $orderInput === '' ? null : 'There is no such order, so nothing was filled in.');
        }

        $sticky = [
            'edition' => array_key_exists($order['edition'], self::EDITIONS) ? $order['edition'] : 'professional',
            'registeredTo' => $order['registerTo'] ?? $order['name'],
            'email' => $order['email'],
            'count' => (string) $order['quantity'],
            'orderRef' => $order['ref'],
            'notes' => "Website order {$order['ref']}",
        ];
        $intro = Html::notice('ok', 'Filled in from order <a href="?page=order&amp;id=' . $order['id'] . '">' . Html::e($order['ref']) . '</a> ('
            . Html::e($order['name']) . '). Check the details, then create; ' . (in_array($order['status'], ['new', 'contacted', 'paid'], true)
                ? 'the order is then marked “' . Html::e(Store::ORDER_STATUSES['licensed']) . '”.'
                : 'the order stays “' . Html::e(Store::ORDER_STATUSES[$order['status']] ?? $order['status']) . '” — change its status on the order page if it should.'));

        return $this->createPage($sticky, null, 200, $intro);
    }

    /** @param array<string, string> $sticky */
    private function createPage(array $sticky, ?string $error, int $status = 200, string $intro = ''): Response
    {
        $value = static fn (string $name, string $default = ''): string => Html::e($sticky[$name] ?? $default);
        $edition = $sticky['edition'] ?? 'professional';
        $term = $sticky['term'] ?? 'days';

        $options = '';
        foreach (self::EDITIONS as $name => [$label, $seats, $price]) {
            $options .= '<option value="' . $name . '"' . ($edition === $name ? ' selected' : '') . '>'
                . Html::e("{$label} — {$seats} — {$price}") . '</option>';
        }

        $body = '<h1>Create licences</h1>' . $intro . ($error === null ? '' : Html::notice('error', Html::e($error)))
            . '<form method="post" action="./" class="card">' . Session::csrfField() . '<input type="hidden" name="action" value="create">'
            . '<label for="edition">Edition</label><select id="edition" name="edition">' . $options . '</select>'
            . '<p class="hint">The Free edition needs no key. Prices are the approved list; payment is taken outside this panel.</p>'
            . '<label for="registeredTo">Registered to</label><input id="registeredTo" name="registeredTo" maxlength="200" value="' . $value('registeredTo') . '" placeholder="Customer or company name (shown in the app)">'
            . '<label for="email">E-mail</label><input id="email" name="email" type="email" maxlength="254" value="' . $value('email') . '">'
            . ($this->app->mailer() === null ? ''
                : '<label class="inline"><input type="checkbox" name="sendEmail" value="1"' . (($sticky['sendEmail'] ?? '1') === '1' ? ' checked' : '')
                    . '> E-mail the key to this address as soon as it is created</label>')
            . '<label for="seats">Computers (seats)</label><input id="seats" name="seats" inputmode="numeric" value="' . $value('seats') . '" placeholder="Blank = the edition’s standard">'
            . '<label class="inline"><input type="checkbox" name="unlimited" value="1"' . (($sticky['unlimited'] ?? '') === '1' ? ' checked' : '') . '> unlimited computers</label>'
            . '<label>Term</label>'
            . '<label class="inline"><input type="radio" name="term" value="days"' . ($term === 'days' ? ' checked' : '') . '> <input name="days" inputmode="numeric" value="' . $value('days', '365') . '" style="width:6em"> days from today</label>'
            . '<label class="inline"><input type="radio" name="term" value="date"' . ($term === 'date' ? ' checked' : '') . '> until <input type="date" name="expires" value="' . $value('expires') . '" style="width:11em"> (inclusive, UTC)</label>'
            . '<label class="inline"><input type="radio" name="term" value="perpetual"' . ($term === 'perpetual' ? ' checked' : '') . '> perpetual</label>'
            . '<p class="hint">Paid licences are annual: 365 days is the default.</p>'
            . '<label for="count">How many keys</label><input id="count" name="count" inputmode="numeric" value="' . $value('count', '1') . '" style="max-width:8em">'
            . '<label for="orderRef">Order reference</label><input id="orderRef" name="orderRef" maxlength="200" value="' . $value('orderRef') . '" placeholder="e.g. Razorpay payment id">'
            . '<p class="hint">With an order reference, creating again for the same order shows the keys already made instead of new ones.</p>'
            . '<label for="notes">Notes</label><textarea id="notes" name="notes" rows="3" maxlength="2000">' . $value('notes') . '</textarea>'
            . '<p></p><button type="submit">Create</button></form>';

        return $this->page('Create licences', $body, 'create', $status);
    }

    private function createdPage(): Response
    {
        $result = Session::takeFlash('created');
        if (!is_array($result)) {
            return Html::redirect('?page=licences');
        }

        $keys = array_map(static fn (array $licence): string => $licence['key'], $result['licenses']);
        $list = '';
        foreach ($result['licenses'] as $licence) {
            $list .= '<tr><td>' . Html::copyable($licence['key'], 'Licence key') . '</td><td><a href="?page=licence&amp;key=' . rawurlencode($licence['key']) . '">details</a></td></tr>';
        }

        $mail = $result['mail'] ?? null;
        $sent = is_array($mail) && $mail[0] === 'ok';
        $body = '<h1>' . ($result['created'] ? 'New licences' : 'Already created for this order') . '</h1>'
            . (is_array($mail) ? Html::notice($mail[0], Html::e($mail[1])) : '')
            . Html::notice($result['created'] ? 'ok' : 'warn', match (true) {
                !$result['created'] => 'Licences for this order reference already existed, so no new ones were made. These are the existing keys.',
                $sent => 'The customer has the key' . (count($keys) === 1 ? '' : 's') . ' by e-mail; ' . (count($keys) === 1 ? 'it is' : 'they are') . ' below too. This page is shown once.',
                default => 'Copy the key' . (count($keys) === 1 ? '' : 's') . ' now and e-mail ' . (count($keys) === 1 ? 'it' : 'them') . ' to the customer. This page is shown once.',
            })
            . '<div class="scroll"><table><tbody>' . $list . '</tbody></table></div>'
            . (count($keys) > 1 ? '<h2>All keys</h2>' . Html::copyable(implode("\n", $keys), 'All keys', true) : '')
            . '<p><a href="?page=create">Create more</a></p>';

        return $this->page('New licences', $body, 'create');
    }

    private function apiPage(): Response
    {
        $config = $this->app->config();
        $token = Session::takeFlash('api-token');
        $enabled = $config->apiTokenHash() !== null;
        $site = $config->siteUrl() ?? ('https://' . ($this->request->header('host') ?? 'your-site'));

        $body = '<h1>Admin API token</h1>' . $this->flashNotice()
            . (is_string($token) ? Html::notice('ok', '<p><strong>Copy this token now — it is shown only once.</strong> Store it in your payment webhook’s secret settings.</p>'
                . Html::copyable($token, 'API token')) : '')
            . '<div class="card"><p>The JSON admin API lets a payment webhook create, renew and revoke licences automatically '
            . '(same routes as the reference server: <code>/v1/admin/licenses</code>). It is <strong>' . ($enabled ? 'on' : 'off') . '</strong>.'
            . ($enabled ? '' : ' While it is off, its addresses answer 404 as if they did not exist.') . '</p>'
            . '<div class="actions"><form method="post" action="./"' . ($enabled ? ' data-confirm="Replace the API token? The old one stops working immediately."' : '') . '>'
            . Session::csrfField() . '<input type="hidden" name="action" value="api-generate"><button type="submit">'
            . ($enabled ? 'Replace the token' : 'Generate a token') . '</button></form>'
            . ($enabled ? '<form method="post" action="./" data-confirm="Turn the admin API off?">' . Session::csrfField()
                . '<input type="hidden" name="action" value="api-disable"><button class="secondary" type="submit">Turn the API off</button></form>' : '')
            . '</div></div><div class="card"><h2>Example</h2><pre class="mono">' . Html::e(
                "curl -sS {$site}/v1/admin/licenses \\\n  -H \"Authorization: Bearer \$TOKEN\" \\\n  -H 'Content-Type: application/json' \\\n"
                . "  -d '{\"edition\":\"professional\",\"days\":365,\"registeredTo\":\"Jane Doe\",\"email\":\"jane@example.com\",\"orderRef\":\"razorpay:pay_123\"}'",
            ) . '</pre><p class="hint">With <code>orderRef</code> set, a webhook delivered twice gets the same key back (200, <code>"created": false</code>) instead of a second licence.</p></div>';

        return $this->page('API token', $body, 'api');
    }

    private function backupPage(): Response
    {
        $body = '<h1>Backup</h1>' . $this->flashNotice()
            . '<div class="grid"><div class="card"><h2>Licence database</h2><p>Every licence sold and every computer activated. '
            . 'Download a copy at least weekly (daily while you sell a lot) and keep the last few.</p>'
            . '<form method="post" action="./">' . Session::csrfField() . '<input type="hidden" name="action" value="backup-db">'
            . '<button type="submit">Download database snapshot</button></form>'
            . '<p class="hint">A consistent snapshot, safe to take while customers activate.</p></div>'
            . '<div class="card"><h2>Signing key</h2><p>Needed to issue any activation. It never changes, so one offline copy in two places is enough. '
            . 'Anyone holding it can mint licences — keep it out of e-mail and cloud folders you share.</p>'
            . '<form method="post" action="./">' . Session::csrfField() . '<input type="hidden" name="action" value="backup-key">'
            . '<label for="kp">Confirm your admin password</label><input id="kp" type="password" name="password" required autocomplete="current-password">'
            . '<p></p><button type="submit">Download signing key (PEM)</button></form></div></div>'
            . '<div class="card"><h2>Restoring</h2><p>See “Backups and restoring” in the README: upload the snapshot as '
            . '<code>recoverx-licensing/data/licences.db</code> (after deleting <code>licences.db-wal</code> and <code>licences.db-shm</code>) '
            . 'and the key as <code>recoverx-licensing/data/signing.key</code>.</p></div>'
            . $this->retentionCard();

        return $this->page('Backup', $body, 'backup');
    }

    /**
     * The event-retention pass, by hand. It also runs by itself once a day
     * (`App::housekeeping`); the button is for the vendor who wants to see it
     * done, or to apply a shorter retention at once.
     */
    private function retentionCard(): string
    {
        $retention = $this->app->eventRetention();
        $pending = $retention->pending();
        $days = $retention->days;
        $before = Html::date($retention->cutoff());
        $what = $pending === 1 ? '1 event' : "{$pending} events";

        return '<div class="card"><h2>Activation history</h2><p>Every activation and move is recorded with the address it came from. '
            . 'The privacy policy promises that this history is kept for 13 months and then deleted, so entries older than '
            . '<strong>' . $days . ' days</strong> are deleted automatically, once a day — and so are the monthly log files in '
            . '<code>recoverx-licensing/data/logs/</code> once they are that old. The same pass forgets the rate-limit counters, which are '
            . 'kept per address, once they have refilled, failed sign-ins after a day, and orders from the website form once they have not changed for 24 months.</p>'
            . '<dl class="facts"><dt>Older than ' . $days . ' days now</dt><dd>' . Html::e($what) . ' (recorded before ' . Html::e($before) . ')</dd>'
            . '<dt>Last tidied</dt><dd>' . Html::e($retention->lastRun() === null ? 'not yet' : Html::time($retention->lastRun())) . '</dd></dl>'
            . '<form method="post" action="./" data-confirm="' . Html::e("Delete {$what} recorded before {$before}? This cannot be undone.") . '">'
            . Session::csrfField() . '<input type="hidden" name="action" value="prune-events">'
            . '<p></p><button type="submit" class="secondary">Delete old history now</button></form>'
            . '<p class="hint">The period is <code>event_retention_days</code> in config.local.php (README → Settings). It can never be shorter than '
            . 'the self-service move window (<code>self_release_window_days</code>), because moves are counted from this history.</p></div>';
    }

    private function passwordPage(?string $error, int $status = 200): Response
    {
        $body = '<h1>Change password</h1>' . $this->flashNotice() . ($error === null ? '' : Html::notice('error', Html::e($error)))
            . '<form method="post" action="./" class="card">' . Session::csrfField() . '<input type="hidden" name="action" value="password">'
            . '<label for="current">Current password</label><input id="current" type="password" name="current" required autocomplete="current-password">'
            . '<label for="new">New password</label><input id="new" type="password" name="password" required minlength="' . Config::MIN_PASSWORD_LENGTH . '" autocomplete="new-password">'
            . '<label for="confirm">New password again</label><input id="confirm" type="password" name="confirm" required autocomplete="new-password">'
            . '<p class="hint">At least ' . Config::MIN_PASSWORD_LENGTH . ' characters. Changing it signs out every other session.</p>'
            . '<button type="submit">Change password</button></form>';

        return $this->page('Password', $body, 'password', $status);
    }

    // --- actions ----------------------------------------------------------------------------

    private function act(string $action): Response
    {
        $key = $this->request->field('key');
        $back = '?page=licence&key=' . rawurlencode($key);
        $context = ['actor' => 'admin-panel', 'ip' => (new Api($this->app))->clientAddress($this->request)];
        $authority = $this->app->authority();

        try {
            switch ($action) {
                case 'logout':
                    Session::destroy();

                    return Html::redirect('./');

                case 'create':
                    return $this->create($context);

                case 'order-update':
                case 'order-delete':
                    return $this->orderAct($action, $context);

                case 'email-key':
                    $licence = $authority->show($key)['license'];
                    $this->emailKeys([$licence], $context);
                    Session::flash('notice', ['ok', 'Licence key e-mailed to ' . $licence['email'] . '.']);

                    return Html::redirect($back);

                case 'revoke':
                    $authority->revoke($key, $this->text('reason'), $context);
                    Session::flash('notice', ['ok', 'Licence revoked. Computers that already hold it keep working until their activation expires; it can no longer be activated or renewed.']);

                    return Html::redirect($back);

                case 'restore':
                    $authority->restore($key, $context);
                    Session::flash('notice', ['ok', 'Licence restored.']);

                    return Html::redirect($back);

                case 'extend':
                    $change = new \stdClass();
                    match ($this->request->field('term')) {
                        'perpetual' => $change->perpetual = true,
                        'date' => $change->expires = $this->request->field('expires'),
                        default => $change->days = self::wholeNumber($this->request->field('days'), 'days'),
                    };
                    $licence = $authority->extend($key, $change, $context);
                    Session::flash('notice', ['ok', 'End date saved: ' . ($licence['expiresAt'] === null ? 'never expires.' : Html::time($licence['expiresAt']) . '.')]);

                    return Html::redirect($back);

                case 'release':
                    $released = $authority->release($key, $this->request->field('machineId'), $context);
                    Session::flash('notice', ['ok', $released ? 'Seat released.' : 'That computer’s seat was already free.']);

                    return Html::redirect($back);

                case 'reset':
                    $count = $authority->resetSeats($key, $context);
                    Session::flash('notice', ['ok', "{$count} seat" . ($count === 1 ? '' : 's') . ' released.']);

                    return Html::redirect($back);

                case 'details':
                    $input = new \stdClass();
                    foreach (['registeredTo', 'email', 'notes'] as $name) {
                        $input->{$name} = $this->text($name);
                    }
                    $authority->updateDetails($key, $input);
                    $this->app->logger()->info('Licence details corrected', ['key' => Authority::logSafeKey($key), 'ip' => $context['ip']]);
                    Session::flash('notice', ['ok', 'Details saved.']);

                    return Html::redirect($back);

                case 'erase':
                    $erased = $authority->erasePersonalDetails($key);
                    $this->app->logger()->info('Personal details erased', [
                        'key' => Authority::logSafeKey($key),
                        'addresses' => $erased['addresses'],
                        'orderRef' => $erased['orderRefErased'],
                        'ip' => $context['ip'],
                    ]);
                    Session::flash('notice', ['ok', 'Personal details erased: the name, e-mail and notes, and '
                        . ($erased['addresses'] === 1 ? '1 recorded address' : "{$erased['addresses']} recorded addresses")
                        . ($erased['orderRefErased'] ? ', and the order reference, as the licence ended more than 8 years ago' : '')
                        . ($erased['orders'] > 0 ? '; the website order behind it was deleted too.' : '.')]);

                    return Html::redirect($back);

                case 'offline':
                    $result = $authority->issueOffline($key, $this->request->field('machineId'), $context);
                    Session::flash('offline', ['token' => $result['token'], 'machine' => $result['claims']['machine']]);

                    return Html::redirect($back);

                case 'api-generate':
                    $token = Config::newApiToken();
                    $this->saveConfig(['api_token_hash' => Config::hashApiToken($token)]);
                    Session::flash('api-token', $token);
                    $this->app->logger()->info('Admin API token generated', ['ip' => $context['ip']]);

                    return Html::redirect('?page=api');

                case 'api-disable':
                    $this->saveConfig(['api_token_hash' => null]);
                    Session::flash('notice', ['ok', 'The admin API is off.']);
                    $this->app->logger()->info('Admin API turned off', ['ip' => $context['ip']]);

                    return Html::redirect('?page=api');

                case 'backup-db':
                    return $this->downloadDatabase($context['ip']);

                case 'prune-events':
                    $retention = $this->app->eventRetention();
                    $result = $retention->prune();
                    $this->app->logger()->info('Pruned the event log', ['via' => 'admin'] + $retention->logFields($result) + ['ip' => $context['ip']]);
                    Session::flash('notice', ['ok', ($result['deleted'] === 1 ? '1 event' : "{$result['deleted']} events")
                        . ' recorded before ' . Html::date($result['cutoff']) . ' deleted'
                        . ($result['logFiles'] === 0 ? '' : ', with ' . $result['logFiles'] . ' old log file' . ($result['logFiles'] === 1 ? '' : 's'))
                        . ($result['orders'] === 0 ? '' : ', and ' . ($result['orders'] === 1 ? '1 order' : "{$result['orders']} orders") . ' unchanged for 24 months')
                        . '.']);

                    return Html::redirect('?page=backup');

                case 'backup-key':
                    $check = $this->reconfirm($this->request->field('password'), 'signing key download');
                    if ($check === 'signed-out') {
                        return $this->signedOutAfterWrongPasswords();
                    }
                    if ($check === 'wrong') {
                        Session::flash('notice', ['error', 'That password is not right, so the key was not downloaded.']);

                        return Html::redirect('?page=backup');
                    }
                    $this->app->logger()->info('Signing key backup downloaded', ['via' => 'admin', 'ip' => $context['ip']]);

                    return Html::download('license-signing-key.pem', $this->app->signer()->key()->toPem(), 'application/x-pem-file');

                case 'password':
                    return $this->changePassword();
            }
        } catch (LicenseError $error) {
            Session::flash('notice', ['error', $error->getMessage()]);

            return Html::redirect($key === '' ? './' : $back);
        } catch (MailError $error) {
            $this->app->logger()->warn('Licence e-mail not sent', ['key' => Authority::logSafeKey($key), 'error' => $error->getMessage(), 'ip' => $context['ip']]);
            Session::flash('notice', ['error', $error->getMessage()]);

            return Html::redirect($key === '' ? './' : $back);
        }

        return $this->page('Unknown action', Html::notice('error', 'That action is not known.'), 'dashboard', 400);
    }

    /** @param array{actor: string, ip: string} $context */
    private function create(array $context): Response
    {
        $r = $this->request;
        $sticky = [];
        foreach (['edition', 'registeredTo', 'email', 'sendEmail', 'seats', 'unlimited', 'term', 'days', 'expires', 'count', 'orderRef', 'notes'] as $name) {
            $sticky[$name] = $r->field($name);
        }

        try {
            $input = new \stdClass();
            $input->edition = $sticky['edition'];
            foreach (['registeredTo', 'email', 'orderRef', 'notes'] as $name) {
                $value = $this->text($name);
                if ($value !== null) {
                    $input->{$name} = $value;
                }
            }

            if ($sticky['unlimited'] === '1') {
                $input->seats = null;
            } elseif (trim($sticky['seats']) !== '') {
                $input->seats = self::wholeNumber($sticky['seats'], 'computers');
            }

            match ($sticky['term']) {
                'perpetual' => null,
                'date' => $input->expires = $sticky['expires'],
                default => $input->days = self::wholeNumber($sticky['days'], 'days'),
            };

            if (trim($sticky['count']) !== '') {
                $input->count = self::wholeNumber($sticky['count'], 'keys');
            }

            $result = $this->app->authority()->createLicenses($input, $context);
        } catch (LicenseError $error) {
            return $this->createPage($sticky, $error->getMessage(), 400);
        }

        // An order from the website form with this reference now has its
        // licences. The keys are made and must be shown, so a failure here
        // is only logged.
        if ($result['created'] && isset($input->orderRef)) {
            try {
                if ($this->app->store()->markOrderLicensed($input->orderRef, $this->app->now())) {
                    $this->app->logger()->info('Order marked licensed', ['ref' => $input->orderRef, 'ip' => $context['ip']]);
                }
            } catch (\Throwable $error) {
                $this->app->logger()->warn('Licences created, but their order could not be marked licensed', ['error' => $error->getMessage(), 'ip' => $context['ip']]);
            }
        }

        // Only for keys made just now: a repeated order reference shows the
        // existing keys, and must not mail them again.
        $result['mail'] = $sticky['sendEmail'] === '1' && $result['created'] ? $this->mailNewKeys($result['licenses'], $context) : null;
        Session::flash('created', $result);

        return Html::redirect('?page=created');
    }

    /**
     * Change an order's status and notes, or delete it. Each goes back to
     * where the vendor came from, with what happened as a notice.
     *
     * @param 'order-update'|'order-delete' $action
     * @param array{actor: string, ip: string} $context
     */
    private function orderAct(string $action, array $context): Response
    {
        $store = $this->app->store();
        $id = self::orderId($this->request->field('id'));
        $order = $id === null ? null : $store->getOrder($id);
        if ($id === null || $order === null) {
            Session::flash('notice', ['error', 'That order no longer exists.']);

            return Html::redirect('?page=orders');
        }

        $back = '?page=order&id=' . $id;

        if ($action === 'order-delete') {
            if ($this->request->field('confirm') !== '1') {
                Session::flash('notice', ['error', 'Tick “Yes, delete ' . $order['ref'] . '” to confirm, then delete again. Nothing was deleted.']);

                return Html::redirect($back);
            }

            $store->deleteOrder($id);
            $this->app->logger()->info('Order deleted', ['ref' => $order['ref'], 'ip' => $context['ip']]);
            Session::flash('notice', ['ok', 'Order ' . $order['ref'] . ' deleted.']);

            return Html::redirect('?page=orders');
        }

        try {
            $status = $this->request->field('status');
            if (!array_key_exists($status, Store::ORDER_STATUSES)) {
                throw LicenseError::invalidArgument('Choose one of the listed statuses.');
            }
            $notes = $this->text('notes');
            if ($notes !== null && Js::length($notes) > self::NOTES_MAX) {
                throw LicenseError::invalidArgument('The notes can be at most ' . self::NOTES_MAX . ' characters long.');
            }
        } catch (LicenseError $error) {
            Session::flash('notice', ['error', $error->getMessage() . ' Nothing was changed.']);

            return Html::redirect($back);
        }

        $store->updateOrder($id, $status, $notes, $this->app->now());
        $this->app->logger()->info('Order updated', ['ref' => $order['ref'], 'status' => $status, 'ip' => $context['ip']]);
        Session::flash('notice', ['ok', 'Saved: ' . $order['ref'] . ' is now “' . Store::ORDER_STATUSES[$status] . '”.']);

        return Html::redirect($back);
    }

    /**
     * E-mail keys just created, for the "created" page to report.
     *
     * @param list<array<string, mixed>> $licences
     * @param array{actor: string, ip: string} $context
     * @return null|array{0: 'ok'|'warn'|'error', 1: string}
     */
    private function mailNewKeys(array $licences, array $context): ?array
    {
        if ($this->app->mailer() === null) {
            return null;
        }

        $to = $licences[0]['email'] ?? null;
        if (!is_string($to) || $to === '') {
            return ['warn', 'No e-mail address was given, so nothing was e-mailed.'];
        }

        try {
            $this->emailKeys($licences, $context);

            return ['ok', "E-mailed to {$to}."];
        } catch (MailError | LicenseError $error) {
            $this->app->logger()->warn('Licence e-mail not sent', ['error' => $error->getMessage(), 'ip' => $context['ip']]);

            return ['error', 'The licence was created, but the e-mail was not sent. ' . $error->getMessage()
                . ' Copy the key below, or use “E-mail the key” on the licence page once the problem is fixed.'];
        }
    }

    /**
     * Send licence keys to their customer in one e-mail, and note it in each
     * licence's history.
     *
     * @param list<array<string, mixed>> $licences all for the same e-mail address
     * @param array{actor: string, ip: string} $context
     */
    private function emailKeys(array $licences, array $context): void
    {
        $mailer = $this->app->mailer();
        if ($mailer === null) {
            throw new MailError('E-mail is off: set mail_from and ses_region in config.local.php (README → Settings).');
        }

        $to = $licences[0]['email'] ?? null;
        if (!is_string($to) || $to === '') {
            throw new MailError('This licence has no e-mail address. Add it under Personal details, then send.');
        }

        foreach ($licences as $licence) {
            if ($licence['revokedAt'] !== null) {
                throw new MailError('This licence is revoked, so its key was not sent.');
            }
            if ($licence['email'] !== $to) {
                throw new \LogicException('One e-mail can only carry the keys of one customer.');
            }
        }

        $site = $this->app->config()->siteUrl() ?? ('https://' . ($this->request->header('host') ?? 'localhost'));
        $mail = LicenceMail::compose($licences, $site);
        $messageId = $mailer->send($to, $mail['subject'], $mail['text'], null, $mail['html']);

        foreach ($licences as $licence) {
            $this->app->authority()->recordKeyEmailed($licence['key'], $messageId, $context);
        }

        $this->app->logger()->info('Licence key e-mailed', [
            'keys' => implode(', ', array_map(static fn (array $licence): string => LicenseKey::mask($licence['key']), $licences)),
            'messageId' => $messageId,
            'ip' => $context['ip'],
        ]);
    }

    /**
     * The licence page's "E-mail the key" card: the button, or why it is not offered.
     *
     * @param array<string, mixed> $licence
     */
    private function emailKeyCard(array $licence, \Closure $form): string
    {
        $label = '<label>E-mail the key to the customer</label>';
        $mailer = $this->app->mailer();

        if ($mailer === null) {
            return $label . '<p class="hint">E-mail is off. Set <code>mail_from</code> and <code>ses_region</code> in config.local.php (README → Settings).</p>';
        }

        if ($licence['email'] === null) {
            return $label . '<p class="hint">This licence has no e-mail address. Add it under Personal details below, then send.</p>';
        }

        if ($licence['revokedAt'] !== null) {
            return $label . '<p class="hint">A revoked licence cannot be activated, so its key is not sent.</p>';
        }

        return $form('email-key', $label . '<p>The key and the activation steps go to <strong>' . Html::e($licence['email']) . '</strong>, '
            . 'from <code>' . Html::e($mailer->fromLine()) . '</code>.</p><button type="submit">E-mail the key</button>',
            'E-mail this licence key to ' . $licence['email'] . '?');
    }

    private function mailSummary(): string
    {
        $mailer = $this->app->mailer();

        return $mailer === null
            ? 'off <span class="muted">(README → Settings: <code>mail_from</code>)</span>'
            : 'on, from <code>' . Html::e($mailer->fromLine()) . '</code> through Amazon SES (' . Html::e($mailer->region) . ')'
                . ($mailer->replyTo === null ? '' : '; replies go to <code>' . Html::e($mailer->replyTo) . '</code>');
    }

    private function changePassword(): Response
    {
        $check = $this->reconfirm($this->request->field('current'), 'password change');
        if ($check === 'signed-out') {
            return $this->signedOutAfterWrongPasswords();
        }
        if ($check === 'wrong') {
            return $this->passwordPage('The current password is not right.', 400);
        }

        $problem = Config::passwordProblem($this->request->field('password'), $this->request->field('confirm'));
        if ($problem !== null) {
            return $this->passwordPage($problem, 400);
        }

        $this->saveConfig(['admin_password_hash' => Config::hashPassword($this->request->field('password'))]);
        $config = $this->app->reloadConfig();

        Session::regenerate();
        $_SESSION['admin']['pw'] = self::passwordTag($config);
        Session::flash('notice', ['ok', 'Password changed. Other sessions have been signed out.']);
        $this->app->logger()->info('Admin password changed', ['ip' => (new Api($this->app))->clientAddress($this->request)]);

        return Html::redirect('?page=password');
    }

    private function downloadDatabase(string $ip): Response
    {
        $store = $this->app->store();
        $tmp = $this->app->paths->tmpDir();
        if (!is_dir($tmp)) {
            @mkdir($tmp, 0700, true);
        }

        $file = $tmp . '/snapshot-' . bin2hex(random_bytes(8)) . '.db';
        try {
            $store->snapshot($file);
            $contents = file_get_contents($file);
        } finally {
            @unlink($file);
        }

        if ($contents === false) {
            throw new \RuntimeException('The database snapshot could not be read back.');
        }

        $this->app->logger()->info('Database snapshot downloaded', ['ip' => $ip, 'bytes' => strlen($contents)]);

        return Html::download('recoverx-licences-' . gmdate('Ymd-His') . '.db', $contents, 'application/vnd.sqlite3');
    }

    // --- helpers -----------------------------------------------------------------------------

    /** @param array<string, mixed> $changes */
    private function saveConfig(array $changes): void
    {
        $document = array_merge($this->app->config()->document, $changes, ['updated_at' => gmdate('c')]);
        Config::write($this->app->paths, $document);
        $this->app->reloadConfig();
    }

    /** A trimmed text field, `null` when empty; refuses bytes that are not UTF-8. */
    private function text(string $name): ?string
    {
        $value = $this->request->field($name);
        if (!Js::isUtf8($value)) {
            throw LicenseError::invalidArgument("The {$name} field contains characters that could not be read.");
        }

        $trimmed = Js::trim($value);

        return $trimmed === '' ? null : $trimmed;
    }

    private static function wholeNumber(string $value, string $what): int
    {
        $trimmed = trim($value);
        if (preg_match('/^\d{1,9}$/D', $trimmed) !== 1) {
            throw LicenseError::invalidArgument("The number of {$what} must be a whole number.");
        }

        return (int) $trimmed;
    }

    private function query(string $name): string
    {
        $value = $this->request->query()[$name] ?? '';

        return Js::isUtf8($value) ? $value : '';
    }

    private function flashNotice(): string
    {
        $html = '';
        $notice = Session::takeFlash('notice');
        if (is_array($notice) && count($notice) === 2) {
            $html .= Html::notice($notice[0] === 'error' ? 'error' : 'ok', Html::e($notice[1]));
        }

        $offline = Session::takeFlash('offline');
        if (is_array($offline)) {
            $html .= Html::notice('ok', '<p><strong>Offline activation for ' . Html::e($offline['machine']) . '</strong> — send this to the customer. '
                . 'In RecoverX they open Licence, choose the Offline activation method and paste it as the activation code.</p>'
                . Html::copyable($offline['token'], 'Offline activation', true)
                . '<p><a download="recoverx-activation-' . Html::e(substr((string) $offline['machine'], 0, 9)) . '.txt" href="data:text/plain;charset=utf-8,'
                . rawurlencode($offline['token']) . '">Save as a file</a></p>');
        }

        return $html;
    }

    /** @param array<string, mixed> $event */
    private function eventRow(array $event, bool $withKey): string
    {
        $detail = '';
        $decoded = is_string($event['detail']) ? json_decode($event['detail'], true) : null;
        if (is_array($decoded)) {
            $parts = [];
            foreach ($decoded as $name => $value) {
                if (in_array($name, ['expiresAt', 'from', 'to', 'revokedAt'], true) && is_int($value)) {
                    $value = Html::time($value);
                }
                $parts[] = $name . ': ' . (is_scalar($value) ? (is_bool($value) ? ($value ? 'yes' : 'no') : (string) $value) : ($value === null ? '—' : json_encode($value)));
            }
            $detail = implode(' · ', $parts);
        }

        $key = $event['key'];
        $keyCell = $withKey
            ? '<td class="mono key">' . ($key === null ? '' : '<a href="?page=licence&amp;key=' . rawurlencode($key) . '">' . Html::e(LicenseKey::mask($key)) . '</a>') . '</td>'
            : '';

        return '<tr><td class="when">' . Html::time($event['at']) . '</td><td><span class="ev" data-ev="' . Html::e($event['type']) . '">'
            . Html::e($event['type']) . '</span></td>' . $keyCell
            . '<td class="mono">' . Html::e($event['machineId'] ?? '') . '</td><td>' . Html::e($event['ip'] ?? '') . '</td>'
            . '<td class="muted">' . Html::e($detail) . '</td></tr>';
    }

    /** An order's status as a coloured pill (the stylesheet colours it by `data-order`). */
    private static function orderBadge(string $status): string
    {
        return '<span class="badge" data-order="' . Html::e($status) . '">' . Html::e(Store::ORDER_STATUSES[$status] ?? $status) . '</span>';
    }

    /** An order's number from a query or form field, or `null` when it is not one. */
    private static function orderId(string $value): ?int
    {
        return preg_match('/^[1-9][0-9]{0,17}$/D', $value) === 1 ? (int) $value : null;
    }

    /** An edition as a coloured chip (the stylesheet colours it by `data-ed`). */
    private static function editionChip(string $edition): string
    {
        return '<span class="ed" data-ed="' . Html::e($edition) . '">' . Html::e(self::EDITIONS[$edition][0] ?? $edition) . '</span>';
    }

    /**
     * A signed-in page: `Html::page` puts `nav` in the side panel, so this is
     * the grouped links and, below them, who is signed in and the sign-out form.
     */
    private function page(string $title, string $body, string $active, int $status = 200): Response
    {
        try {
            $newOrders = $this->app->store()->countOrdersByStatus()['new'];
        } catch (\Throwable) {
            // The page matters more than the count beside a link.
            $newOrders = 0;
        }

        $groups = [
            'overview' => ['Overview', ['dashboard' => ['./', 'Dashboard']]],
            'orders' => ['Orders', ['orders' => ['?page=orders', 'Orders' . ($newOrders > 0 ? " ({$newOrders})" : '')]]],
            'licences' => ['Licences', ['licences' => ['?page=licences', 'All licences'], 'create' => ['?page=create', 'Create licence']]],
            'integrations' => ['Integrations', ['api' => ['?page=api', 'API token']]],
            'system' => ['System', ['backup' => ['?page=backup', 'Backup'], 'password' => ['?page=password', 'Password']]],
        ];

        $nav = '<nav class="side-nav" aria-label="Admin">';
        foreach ($groups as $id => [$heading, $links]) {
            $nav .= '<div class="nav-group" role="group" aria-labelledby="nav-' . Html::e($id) . '">'
                . '<p class="nav-label" id="nav-' . Html::e($id) . '">' . Html::e($heading) . '</p>';
            foreach ($links as $name => [$href, $label]) {
                $nav .= '<a href="' . Html::e($href) . '"' . ($name === $active ? ' class="active" aria-current="page"' : '') . '>' . Html::e($label) . '</a>';
            }
            $nav .= '</div>';
        }
        $nav .= '</nav>';

        $idle = (int) $this->app->config()->settings['admin_idle_minutes'];
        $nav .= '<div class="side-foot"><p class="who"><span class="who-label">Signed in as</span><span class="who-name">Administrator</span>'
            . '<span class="who-meta">Idle sign-out: ' . Html::e($idle) . ' min</span></p>'
            . '<form method="post" action="./">' . Session::csrfField() . '<input type="hidden" name="action" value="logout">'
            . '<button class="secondary" type="submit">Sign out</button></form></div>';

        return Html::page($title, $body, ['status' => $status, 'nav' => $nav]);
    }
}

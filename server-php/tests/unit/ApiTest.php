<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\App;
use RecoverX\Licensing\Http\Api;
use RecoverX\Licensing\Http\Request;
use RecoverX\Licensing\Http\Response;
use RecoverX\Licensing\LicenseKey;
use RecoverX\Licensing\Messages;

/*
 * The JSON API in-process: the request pipeline (routing, admin
 * authorisation, methods, rate limits, bodies) without a web server. The
 * contract-parity test drives the same code through PHP's built-in server.
 */

const ADMIN_TOKEN = 'test-admin-token-0123456789-abcdefghijklmnop';

function call(App $app, string $method, string $uri, mixed $json = null, array $headers = [], ?string $body = null, string $ip = '198.51.100.7'): array
{
    if ($json !== null) {
        $body = json_encode($json);
        $headers['Content-Type'] ??= 'application/json';
    }

    $response = (new Api($app))->handle(Request::create($method, $uri, $headers, $body, $ip));

    return [$response->status, $response->body === '' ? null : json_decode($response->body, true), $response];
}

function admin(App $app, string $method, string $uri, mixed $json = null): array
{
    return call($app, $method, $uri, $json, ['Authorization' => 'Bearer ' . ADMIN_TOKEN]);
}

function installed(array $settings = ['rate_limit_burst' => 1000], ?string $token = ADMIN_TOKEN): array
{
    return Kit::installation($settings, $token);
}

test('reports health with the headers every reply carries', function (): void {
    ['app' => $app] = installed();
    [$status, $body, $response] = call($app, 'GET', '/healthz');

    Assert::same(200, $status);
    Assert::same(['ok' => true], $body);
    Assert::same('no-store', $response->header('cache-control'));
    Assert::same('nosniff', $response->header('x-content-type-options'));
    Assert::same('application/json; charset=utf-8', $response->header('content-type'));
    Assert::matches('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', (string) $response->header('x-request-id'));
    Assert::same(200, call($app, 'HEAD', '/healthz')[0]);
});

test('activates, refuses a second machine, deactivates and moves', function (): void {
    ['app' => $app] = installed();
    [$status, $created] = admin($app, 'POST', '/v1/admin/licenses', ['edition' => 'professional', 'registeredTo' => 'Jane Doe']);
    Assert::same(201, $status);
    $key = $created['licenses'][0]['key'];

    [$status, $body] = call($app, 'POST', '/v1/activate', ['key' => $key, 'machineId' => Kit::MACHINE_A, 'product' => 'recoverx']);
    Assert::same(200, $status);
    Assert::same(['token'], array_keys($body));
    $token = $body['token'];

    [$status, $body] = call($app, 'POST', '/v1/activate', ['key' => $key, 'machineId' => Kit::MACHINE_B, 'product' => 'recoverx']);
    Assert::same(409, $status);
    Assert::same(['error' => Messages::seatsExhausted(1)], $body);

    Assert::same([200, ['released' => true]], array_slice(call($app, 'POST', '/v1/deactivate', ['token' => $token]), 0, 2));
    Assert::same(200, call($app, 'POST', '/v1/activate', ['key' => $key, 'machineId' => Kit::MACHINE_B, 'product' => 'recoverx'])[0]);
    Assert::same([200, ['released' => false]], array_slice(call($app, 'POST', '/v1/deactivate', ['token' => $token]), 0, 2));
});

test('answers transport problems with the reference statuses and sentences', function (): void {
    ['app' => $app] = installed();

    Assert::same([404, ['error' => Messages::NOT_FOUND]], array_slice(call($app, 'GET', '/v1/nothing-here'), 0, 2));

    [$status, $body, $response] = call($app, 'GET', '/v1/activate');
    Assert::same([405, ['error' => Messages::METHOD_NOT_ALLOWED]], [$status, $body]);
    Assert::same('POST', $response->header('allow'));
    Assert::same('GET, HEAD', call($app, 'POST', '/healthz')[2]->header('allow'));

    Assert::same([415, ['error' => Messages::WRONG_CONTENT_TYPE]], array_slice(call($app, 'POST', '/v1/activate', null, ['Content-Type' => 'text/plain'], 'key=RECX'), 0, 2));
    Assert::same(400, call($app, 'POST', '/v1/activate', ['key' => 'x'], ['Content-Type' => 'application/json; charset=utf-8'])[0]);

    $large = json_encode(['key' => str_repeat('x', Api::MAX_BODY_BYTES), 'machineId' => Kit::MACHINE_A, 'product' => 'recoverx']);
    [$status, $body, $response] = call($app, 'POST', '/v1/activate', null, ['Content-Type' => 'application/json'], $large);
    Assert::same([413, ['error' => Messages::BODY_TOO_LARGE]], [$status, $body]);
    Assert::same('close', $response->header('connection'));

    // A body longer than its declared length is cut off at the limit too.
    [$status] = call($app, 'POST', '/v1/activate', null, ['Content-Type' => 'application/json', 'Content-Length' => '10'], $large);
    Assert::same(413, $status);

    Assert::same([400, ['error' => Messages::UNREADABLE_REQUEST]], array_slice(call($app, 'POST', '/v1/activate', null, ['Content-Type' => 'application/json'], '{"key": '), 0, 2));
    Assert::same([400, ['error' => Messages::INCOMPLETE_REQUEST]], array_slice(call($app, 'POST', '/v1/activate', ['key' => 'x']), 0, 2));
    Assert::same([400, ['error' => Messages::INCOMPLETE_REQUEST]], array_slice(call($app, 'POST', '/v1/activate', [1, 2]), 0, 2));
    Assert::same([400, ['error' => Messages::TOKEN_UNREADABLE]], array_slice(call($app, 'POST', '/v1/deactivate', ['token' => 'not-a-token']), 0, 2));
    Assert::same([400, ['error' => Messages::INCOMPLETE_REQUEST]], array_slice(call($app, 'POST', '/v1/deactivate', ['token' => '']), 0, 2));
});

test('resolves the path as a URL parser would', function (): void {
    ['app' => $app] = installed();
    Assert::same(200, call($app, 'GET', '/v1/../healthz?probe=1')[0]);
    Assert::same(200, call($app, 'GET', '/v1/%2e%2e/healthz')[0]);
    Assert::same(404, call($app, 'GET', '/healthz/')[0]);
});

test('requires the admin bearer token, and throttles guesses separately', function (): void {
    ['app' => $app] = installed(['rate_limit_burst' => 2]);

    [$status, , $response] = call($app, 'GET', '/v1/admin/licenses');
    Assert::same(401, $status);
    Assert::matches('/^Bearer/', (string) $response->header('www-authenticate'));
    Assert::same(401, call($app, 'GET', '/v1/admin/licenses', null, ['Authorization' => 'Bearer ' . ADMIN_TOKEN . 'x'])[0]);
    Assert::same(429, call($app, 'GET', '/v1/admin/licenses', null, ['Authorization' => 'Basic ' . base64_encode('admin:' . ADMIN_TOKEN)])[0]);
    Assert::same(200, admin($app, 'GET', '/v1/admin/licenses')[0]);
    Assert::same(200, call($app, 'GET', '/v1/admin/licenses', null, ['Authorization' => 'bearer   ' . ADMIN_TOKEN . '  '])[0]);
});

test('hides the admin API entirely until a token exists', function (): void {
    ['app' => $app] = installed(['rate_limit_burst' => 1000], null);

    Assert::same(404, call($app, 'GET', '/v1/admin/licenses')[0]);
    Assert::same(404, admin($app, 'POST', '/v1/admin/licenses', ['edition' => 'professional'])[0]);
    Assert::same(200, call($app, 'GET', '/healthz')[0]);
});

test('rate limits the public routes per client with Retry-After, never the health check', function (): void {
    ['app' => $app, 'clock' => $clock] = installed(['rate_limit_burst' => 2, 'rate_limit_per_minute' => 6]);
    $key = LicenseKey::generate(static fn (): int => 1);
    $activate = static fn (string $ip = '198.51.100.7'): array => call($app, 'POST', '/v1/activate', ['key' => $key, 'machineId' => Kit::MACHINE_A, 'product' => 'recoverx'], [], null, $ip);

    Assert::same(404, $activate()[0]);
    Assert::same(404, $activate()[0]);
    [$status, $body, $response] = $activate();
    Assert::same([429, ['error' => Messages::RATE_LIMITED]], [$status, $body]);
    Assert::same('10', $response->header('retry-after'));
    Assert::same(404, $activate('198.51.100.8')[0], 'another client has its own budget');
    Assert::same(200, call($app, 'GET', '/healthz')[0]);

    $clock->advance(10_000);
    Assert::same(404, $activate()[0]);
});

test('takes the client address from X-Forwarded-For only when told to trust a proxy', function (): void {
    $from = static fn (Api $api, ?string $forwarded): string => $api->clientAddress(
        Request::create('GET', '/', $forwarded === null ? [] : ['X-Forwarded-For' => $forwarded], null, '10.0.0.2'),
    );

    ['app' => $direct] = installed();
    Assert::same('10.0.0.2', $from(new Api($direct), '203.0.113.9'));

    // One proxy: the entry it added, at the end. Whatever the visitor sent
    // before it is ignored, so a made-up address buys no fresh rate limit.
    ['app' => $proxied] = installed(['trust_proxy' => true]);
    $api = new Api($proxied);
    Assert::same('203.0.113.9', $from($api, '203.0.113.9'));
    Assert::same('203.0.113.9', $from($api, ' 198.51.100.66 , 203.0.113.9 '));
    Assert::same('2001:db8::7', $from($api, 'made-up, 2001:db8::7'));
    Assert::same('10.0.0.2', $from($api, '203.0.113.9, garbage'));
    Assert::same('10.0.0.2', $from($api, ''));
    Assert::same('10.0.0.2', $from($api, null));

    // Two proxies, each adding one entry: the client is second from the end.
    ['app' => $chained] = installed(['trust_proxy' => 2]);
    $api = new Api($chained);
    Assert::same('203.0.113.9', $from($api, '198.51.100.66, 203.0.113.9, 192.0.2.1'));
    Assert::same('203.0.113.9', $from($api, '203.0.113.9, 192.0.2.1'));
    // Shorter than the chain: it did not come through both proxies.
    Assert::same('10.0.0.2', $from($api, '203.0.113.9'));
});

test('runs the admin routes with the reference bodies and statuses', function (): void {
    ['app' => $app, 'clock' => $clock] = installed();

    $order = ['edition' => 'business', 'count' => 2, 'days' => 365, 'registeredTo' => 'Contoso Ltd', 'email' => 'it@contoso.example', 'orderRef' => 'razorpay:pay_123'];
    [$status, $created] = admin($app, 'POST', '/v1/admin/licenses', $order);
    Assert::same([201, true], [$status, $created['created']]);
    [$status, $replay] = admin($app, 'POST', '/v1/admin/licenses', $order);
    Assert::same([200, false], [$status, $replay['created']]);
    Assert::same(2, count(admin($app, 'GET', '/v1/admin/licenses?orderRef=razorpay%3Apay_123')[1]['licenses']));

    [$status, $body] = admin($app, 'POST', '/v1/admin/licenses', ['edition' => 'free']);
    Assert::same(400, $status);
    Assert::matches('/Free edition/', $body['error']);
    [$status, $body] = admin($app, 'POST', '/v1/admin/licenses', ['edition' => 'professional', 'registered_to' => 'Jane']);
    Assert::same([400, 'The request body is invalid: <root>: Unrecognized key: "registered_to"'], [$status, $body['error']]);
    Assert::same(400, admin($app, 'GET', '/v1/admin/licenses?limit=zero')[0]);
    Assert::same(404, admin($app, 'GET', '/v1/admin/licenses/' . LicenseKey::generate(static fn (): int => 4))[0]);
    Assert::same(400, admin($app, 'GET', '/v1/admin/licenses/%E0%A4%A')[0]);

    $key = $created['licenses'][0]['key'];
    call($app, 'POST', '/v1/activate', ['key' => $key, 'machineId' => Kit::MACHINE_A, 'product' => 'recoverx']);
    call($app, 'POST', '/v1/activate', ['key' => $key, 'machineId' => Kit::MACHINE_B, 'product' => 'recoverx']);

    [$status, $shown] = admin($app, 'GET', '/v1/admin/licenses/' . strtolower($key));
    Assert::same(200, $status);
    Assert::same(['license', 'standing', 'activeSeats', 'selfReleases', 'activations', 'events'], array_keys($shown));
    Assert::same(['active', 2], [$shown['standing'], $shown['activeSeats']]);
    Assert::same(['id', 'at', 'type', 'key', 'machineId', 'ip', 'detail'], array_keys($shown['events'][0]));

    Assert::same(Kit::NOW, admin($app, 'POST', "/v1/admin/licenses/{$key}/revoke")[1]['license']['revokedAt']);
    Assert::same(null, admin($app, 'POST', "/v1/admin/licenses/{$key}/restore")[1]['license']['revokedAt']);
    Assert::same(Kit::NOW + 730 * Kit::DAY, admin($app, 'POST', "/v1/admin/licenses/{$key}/extend", ['days' => 365])[1]['license']['expiresAt']);
    Assert::same([200, ['released' => true]], array_slice(admin($app, 'POST', "/v1/admin/licenses/{$key}/release", ['machineId' => Kit::MACHINE_A]), 0, 2));
    Assert::same([200, ['released' => 1]], array_slice(admin($app, 'POST', "/v1/admin/licenses/{$key}/reset"), 0, 2));
    Assert::same(400, admin($app, 'POST', "/v1/admin/licenses/{$key}/reset", ['extra' => 1])[0]);
    Assert::same(400, admin($app, 'POST', "/v1/admin/licenses/{$key}/extend", ['days' => 5, 'perpetual' => true])[0]);

    [$status, $offline] = admin($app, 'POST', "/v1/admin/licenses/{$key}/offline", ['machineId' => strtolower(Kit::MACHINE_C)]);
    Assert::same(200, $status);
    Assert::same(Kit::MACHINE_C, $offline['claims']['machine']);
    Assert::same(true, $app->signer()->verifySignature($offline['token'])['ok']);
    $clock->advance(0);
});

test('never writes a full licence key, a token or the admin token to the log', function (): void {
    ['app' => $app, 'paths' => $paths] = installed();
    $key = admin($app, 'POST', '/v1/admin/licenses', ['edition' => 'professional'])[1]['licenses'][0]['key'];
    $token = call($app, 'POST', '/v1/activate', ['key' => $key, 'machineId' => Kit::MACHINE_A, 'product' => 'recoverx'])[1]['token'];
    admin($app, 'GET', "/v1/admin/licenses/{$key}");
    call($app, 'POST', '/v1/deactivate', ['token' => $token]);

    $log = implode('', array_map('file_get_contents', glob($paths->logDir() . '/*.log') ?: []));
    Assert::true(str_contains($log, '"route":"activate"'));
    Assert::true(str_contains($log, substr($key, -5)));
    Assert::notContains($key, $log);
    Assert::notContains($token, $log);
    Assert::notContains(ADMIN_TOKEN, $log);
    foreach (explode("\n", trim($log)) as $line) {
        Assert::true(is_array(json_decode($line, true)), $line);
    }
});

test('answers 500 without detail when the server is not set up', function (): void {
    $root = Kit::tempDir('rx-empty-');
    mkdir($root . '/recoverx-licensing/app', 0700, true);
    $app = new App(\RecoverX\Licensing\Paths::detect($root . '/recoverx-licensing/app'));

    Assert::same([500, ['error' => Messages::INTERNAL]], array_slice(call($app, 'GET', '/healthz'), 0, 2));
    Assert::same(404, call($app, 'GET', '/v1/admin/licenses')[0]);
    Assert::same(404, call($app, 'GET', '/nothing')[0]);
});

test('sends nothing but the headers for HEAD', function (): void {
    $response = Response::json(200, ['ok' => true]);
    ob_start();
    $response->send(true);
    Assert::same('', ob_get_clean());
});

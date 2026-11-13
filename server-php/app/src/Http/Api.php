<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Http;

use RecoverX\Licensing\App;
use RecoverX\Licensing\Authority;
use RecoverX\Licensing\ConfigError;
use RecoverX\Licensing\Js;
use RecoverX\Licensing\LicenseError;
use RecoverX\Licensing\Logger;
use RecoverX\Licensing\Messages;
use RecoverX\Licensing\Store;
use RecoverX\Licensing\Validator;

/**
 * The licence server's JSON API — the same contract as src/server/http.ts.
 *
 * Public routes, used by the desktop application:
 *     POST /v1/activate     { key, machineId, product }  → 200 { token }
 *     POST /v1/deactivate   { token }                    → 200 { released }
 *     GET  /healthz                                       → 200 { ok: true }
 *
 * Admin routes (Bearer token; answered 404, as if absent, until a token is
 * generated in the admin panel): create, list, show, revoke, restore, extend,
 * release, reset and offline under /v1/admin/licenses.
 *
 * The pipeline runs in the reference's order — route, admin authorisation,
 * method, rate limit, body — so the same request gets the same status from
 * either server. Every error is `{ "error": "<sentence>" }`; on the public
 * routes the application shows the sentence to the customer verbatim.
 */
final class Api
{
    /** Largest request body accepted. Real requests are a few hundred bytes. */
    public const MAX_BODY_BYTES = 16 * 1024;

    /** Retry hint sent with a 503 when the database is momentarily locked. */
    private const BUSY_RETRY_SECONDS = 2;

    private const EDITIONS = ['professional', 'business', 'technician', 'enterprise'];

    public function __construct(private readonly App $app)
    {
    }

    /** Serve the current request, then do any periodic work that is due. */
    public static function run(App $app): void
    {
        $request = Request::fromGlobals();
        (new self($app))->handle($request)->send($request->method === 'HEAD');
        $app->housekeeping();
    }

    public function handle(Request $request): Response
    {
        $started = hrtime(true);
        $requestId = self::uuid();
        $ip = $this->clientAddress($request);
        $log = [];
        $routeName = 'unmatched';

        try {
            $path = $request->path();
            $route = $this->match($path);

            if ($route === null) {
                throw new HttpRefusal(404, Messages::NOT_FOUND);
            }
            $routeName = $route['name'];

            if ($route['scope'] === 'admin') {
                // A disabled admin API is indistinguishable from an absent one,
                // and so is the API of a server not yet set up.
                $expected = $this->app->isSetUp() ? $this->app->config()->apiTokenHash() : null;
                if ($expected === null) {
                    throw new HttpRefusal(404, Messages::NOT_FOUND);
                }
                $this->authorise($request, $expected, $ip);
            }

            $method = $request->method === 'HEAD' ? 'GET' : $request->method;
            $handler = $route['methods'][$method] ?? null;

            if ($handler === null) {
                $allowed = array_keys($route['methods']);
                if (in_array('GET', $allowed, true)) {
                    $allowed[] = 'HEAD';
                }
                throw new HttpRefusal(405, Messages::METHOD_NOT_ALLOWED, ['Allow' => implode(', ', $allowed)]);
            }

            if ($route['scope'] === 'public') {
                $decision = $this->app->rateLimiter()->take($ip);
                if (!$decision['allowed']) {
                    throw new HttpRefusal(429, Messages::RATE_LIMITED, ['Retry-After' => (string) $decision['retryAfterSeconds']]);
                }
            }

            $response = $handler($request, $route['params'], $ip, $log);
        } catch (\Throwable $error) {
            $response = $this->replyForError($error, $log);

            if ($response->status >= 500) {
                $this->app->logger()->error('Request failed', ['requestId' => $requestId, 'route' => $routeName, 'error' => $error]);
            }
        }

        $response = $response->withHeaders(['X-Request-Id' => $requestId]);

        $fields = [
            'requestId' => $requestId,
            'method' => $request->method,
            'route' => $routeName,
            'status' => $response->status,
            'durationMs' => round((hrtime(true) - $started) / 1e6, 1),
            'ip' => $ip,
        ] + $log;

        if ($response->status >= 500) {
            $this->app->logger()->warn('request', $fields);
        } else {
            $this->app->logger()->info('request', $fields);
        }

        return $response;
    }

    /**
     * The address a request came from.
     *
     * Behind a CDN every connection comes from the CDN, so the client is read
     * from X-Forwarded-For — only when the operator has said a proxy is in
     * front (`trust_proxy`), and only from the end. A proxy adds the address
     * it was reached from to the end of whatever the visitor sent, so the
     * last entry (N from the end, behind N proxies) is the one a proxy wrote,
     * and everything before it is the visitor's own invention. Reading the
     * first entry, as the reference server does behind a proxy configured to
     * overwrite the header, would let anyone behind an appending CDN choose a
     * fresh address per request and walk past the rate limit. Where a proxy
     * does overwrite, the header has one entry and both readings agree.
     *
     * A header shorter than the proxies said to be in front did not come
     * through them, and is ignored, as is the header altogether when no proxy
     * is trusted.
     */
    public function clientAddress(Request $request): string
    {
        $hops = 0;
        try {
            $hops = $this->app->isSetUp() ? $this->app->config()->proxyHops() : 0;
        } catch (\Throwable) {
            // An unreadable configuration is reported by whatever needs it.
        }

        if ($hops > 0) {
            $entries = array_map('trim', explode(',', $request->header('x-forwarded-for') ?? ''));
            $added = count($entries) >= $hops ? $entries[count($entries) - $hops] : '';
            if ($added !== '' && filter_var($added, FILTER_VALIDATE_IP) !== false) {
                return $added;
            }
        }

        return $request->remoteAddress;
    }

    // --- routes -------------------------------------------------------------------------

    /** @return null|array{name: string, scope: string, methods: array<string, callable>, params: list<string>} */
    private function match(string $path): ?array
    {
        foreach ($this->routes() as [$name, $pattern, $scope, $methods]) {
            if (preg_match($pattern, $path, $match) === 1) {
                return ['name' => $name, 'scope' => $scope, 'methods' => $methods, 'params' => array_slice($match, 1)];
            }
        }

        return null;
    }

    /** @return list<array{0: string, 1: string, 2: string, 3: array<string, callable>}> */
    private function routes(): array
    {
        $licence = static fn (string $suffix): string => '#^/v1/admin/licenses/([^/]+)' . preg_quote($suffix, '#') . '$#D';
        $customer = static fn (string $ip): array => ['actor' => 'customer', 'ip' => $ip];
        $operator = static fn (string $ip): array => ['actor' => 'admin-api', 'ip' => $ip];

        return [
            ['healthz', '#^/healthz$#D', 'health', [
                'GET' => function (): Response {
                    $this->app->store()->ping();

                    return Response::json(200, ['ok' => true]);
                },
            ]],
            ['activate', '#^/v1/activate$#D', 'public', [
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($customer): Response {
                    $body = $this->readJson($request, 'customer');
                    [$key, $machineId, $product] = $this->activationBody($body);
                    $log['key'] = Authority::logSafeKey($key);
                    $log['machine'] = $machineId;

                    $result = $this->app->authority()->activate($key, $machineId, $product, $customer($ip));
                    $log['reused'] = $result['reused'];
                    $log['edition'] = $result['claims']['edition'];

                    return Response::json(200, ['token' => $result['token']]);
                },
            ]],
            // 200 { released } when the seat was freed or already free. A 409
            // is the self-service allowance refusing the move; the seat is
            // still held and the client keeps its licence.
            ['deactivate', '#^/v1/deactivate$#D', 'public', [
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($customer): Response {
                    $body = $this->readJson($request, 'customer');
                    $v = new Validator($body);
                    $token = $v->string('token', Validator::REQUIRED, 1, 4096);
                    $this->finish($v, 'customer', false);

                    $result = $this->app->authority()->deactivate((string) $token, $customer($ip));
                    $log['key'] = Authority::logSafeKey($result['key']);
                    $log['machine'] = $result['machineId'];
                    $log['released'] = $result['released'];

                    return Response::json(200, ['released' => $result['released']]);
                },
            ]],
            ['admin.licenses', '#^/v1/admin/licenses$#D', 'admin', [
                'GET' => function (Request $request): Response {
                    $v = Validator::forQuery($request->query());
                    $query = [
                        'limit' => $v->coercedInt('limit', 1, 1000),
                        'offset' => $v->coercedInt('offset', 0, null),
                        'search' => $v->string('search', Validator::OPTIONAL, 0, 200),
                        'orderRef' => $v->string('orderRef', Validator::OPTIONAL, 0, 200),
                        'edition' => $v->enum('edition', self::EDITIONS, Validator::OPTIONAL),
                    ];
                    $this->finish($v, 'operator');

                    return Response::json(200, ['licenses' => $this->app->authority()->list($query)]);
                },
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($operator): Response {
                    $body = $this->readJson($request, 'operator');
                    [$issues, $parsed] = Authority::parseCreate($body);
                    if ($issues !== []) {
                        throw new HttpRefusal(400, 'The request body is invalid: ' . Validator::format($issues));
                    }

                    $result = $this->app->authority()->createLicenses($body, $operator($ip));
                    $log['created'] = $result['created'] ? count($result['licenses']) : 0;
                    $log['edition'] = $parsed['edition'];

                    // A replayed order is answered 200 with the original
                    // licences, so a webhook can tell "minted now" from
                    // "already minted".
                    return Response::json($result['created'] ? 201 : 200, $result);
                },
            ]],
            ['admin.license', $licence(''), 'admin', [
                'GET' => function (Request $request, array $params, string $ip, array &$log): Response {
                    $key = self::routeKey($params);
                    $log['key'] = Authority::logSafeKey($key);

                    return Response::json(200, $this->app->authority()->show($key));
                },
            ]],
            ['admin.license.revoke', $licence('/revoke'), 'admin', [
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($operator): Response {
                    $key = self::routeKey($params);
                    $log['key'] = Authority::logSafeKey($key);
                    $v = new Validator($this->readJson($request, 'operator', true));
                    $reason = $v->string('reason', Validator::NULLISH, 0, 500);
                    $this->finish($v, 'operator');

                    return Response::json(200, ['license' => $this->app->authority()->revoke($key, $reason, $operator($ip))]);
                },
            ]],
            ['admin.license.restore', $licence('/restore'), 'admin', [
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($operator): Response {
                    $key = self::routeKey($params);
                    $log['key'] = Authority::logSafeKey($key);
                    $this->finish(new Validator($this->readJson($request, 'operator', true)), 'operator');

                    return Response::json(200, ['license' => $this->app->authority()->restore($key, $operator($ip))]);
                },
            ]],
            ['admin.license.extend', $licence('/extend'), 'admin', [
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($operator): Response {
                    $key = self::routeKey($params);
                    $log['key'] = Authority::logSafeKey($key);
                    $body = $this->readJson($request, 'operator');
                    [$issues] = Authority::parseExtend($body);
                    if ($issues !== []) {
                        throw new HttpRefusal(400, 'The request body is invalid: ' . Validator::format($issues));
                    }

                    return Response::json(200, ['license' => $this->app->authority()->extend($key, $body, $operator($ip))]);
                },
            ]],
            ['admin.license.reset', $licence('/reset'), 'admin', [
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($operator): Response {
                    $key = self::routeKey($params);
                    $log['key'] = Authority::logSafeKey($key);
                    $this->finish(new Validator($this->readJson($request, 'operator', true)), 'operator');

                    return Response::json(200, ['released' => $this->app->authority()->resetSeats($key, $operator($ip))]);
                },
            ]],
            ['admin.license.release', $licence('/release'), 'admin', [
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($operator): Response {
                    $key = self::routeKey($params);
                    $log['key'] = Authority::logSafeKey($key);
                    $machineId = $this->machineBody($request);
                    $log['machine'] = $machineId;

                    return Response::json(200, ['released' => $this->app->authority()->release($key, $machineId, $operator($ip))]);
                },
            ]],
            ['admin.license.offline', $licence('/offline'), 'admin', [
                'POST' => function (Request $request, array $params, string $ip, array &$log) use ($operator): Response {
                    $key = self::routeKey($params);
                    $log['key'] = Authority::logSafeKey($key);
                    $machineId = $this->machineBody($request);
                    $result = $this->app->authority()->issueOffline($key, $machineId, $operator($ip));
                    $log['machine'] = $result['claims']['machine'];

                    return Response::json(200, ['token' => $result['token'], 'claims' => $result['claims']]);
                },
            ]],
        ];
    }

    // --- bodies -------------------------------------------------------------------------

    /**
     * Read, size-check and decode a JSON body, cheapest checks first: the
     * content type, then the declared length (so an honest oversized request
     * is refused before it is read), then the bytes actually received.
     *
     * An optional body that is absent reads as `{}`, for admin actions with
     * nothing to say.
     */
    private function readJson(Request $request, string $audience, bool $optional = false): mixed
    {
        $declared = $request->declaredLength();
        $chunked = $request->header('transfer-encoding') !== null;

        if ($optional && !$chunked && ($declared === null || $declared === 0)) {
            return new \stdClass();
        }

        $mediaType = strtolower(trim(explode(';', $request->header('content-type') ?? '')[0]));
        if ($mediaType !== 'application/json') {
            throw new HttpRefusal(415, Messages::WRONG_CONTENT_TYPE);
        }

        if ($declared !== null && $declared > self::MAX_BODY_BYTES) {
            throw new HttpRefusal(413, Messages::BODY_TOO_LARGE, ['Connection' => 'close']);
        }

        $raw = $request->body(self::MAX_BODY_BYTES);
        if ($raw === null) {
            throw new HttpRefusal(413, Messages::BODY_TOO_LARGE, ['Connection' => 'close']);
        }

        try {
            // Invalid UTF-8 becomes U+FFFD, as Node's decoder makes it, so the
            // same bytes reach validation on either server.
            return json_decode($raw, false, 512, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (\JsonException) {
            throw new HttpRefusal(400, Messages::UNREADABLE_REQUEST);
        }
    }

    /** @return array{0: string, 1: string, 2: string} */
    private function activationBody(mixed $body): array
    {
        $v = new Validator($body);
        $key = $v->string('key', Validator::REQUIRED, 0, 200);
        $machineId = $v->string('machineId', Validator::REQUIRED, 0, 200);
        $product = $v->string('product', Validator::REQUIRED, 0, 100);
        $this->finish($v, 'customer', false);

        return [(string) $key, (string) $machineId, (string) $product];
    }

    private function machineBody(Request $request): string
    {
        $v = new Validator($this->readJson($request, 'operator'));
        $machineId = $v->string('machineId', Validator::REQUIRED, 1, 200);
        $this->finish($v, 'operator');

        return (string) $machineId;
    }

    /** Turn validation issues into the 400 the audience reads: one plain sentence for a customer. */
    private function finish(Validator $validator, string $audience, bool $strict = true): void
    {
        $issues = $validator->finish($strict);
        if ($issues === []) {
            return;
        }

        throw new HttpRefusal(
            400,
            $audience === 'customer' ? Messages::INCOMPLETE_REQUEST : 'The request body is invalid: ' . Validator::format($issues),
        );
    }

    /**
     * The licence key in the address, percent-decoded the way
     * `decodeURIComponent` does — refusing a malformed escape or bytes that
     * are not UTF-8 rather than guessing.
     *
     * @param list<string> $params
     */
    private static function routeKey(array $params): string
    {
        $raw = $params[0] ?? '';
        $decoded = rawurldecode($raw);

        if (preg_match('/%(?![0-9A-Fa-f]{2})/', $raw) === 1 || !Js::isUtf8($decoded)) {
            throw new HttpRefusal(400, 'The licence key in the address is not readable.');
        }

        return $decoded;
    }

    // --- authorisation and errors -------------------------------------------------------

    /**
     * Check the admin bearer token. Both sides are compared as SHA-256 digests
     * with `hash_equals`, so the comparison takes the same time whatever is
     * sent. Failures are rate limited in their own bucket, so the real token
     * is never throttled by someone else guessing.
     */
    private function authorise(Request $request, string $expectedHash, string $ip): void
    {
        $header = $request->header('authorization') ?? '';
        if (preg_match('/^Bearer\s+(\S+)\s*$/iD', $header, $match) === 1) {
            if (hash_equals($expectedHash, hash('sha256', $match[1]))) {
                return;
            }
        }

        $decision = $this->app->rateLimiter()->take($ip, 'admin-auth');
        if (!$decision['allowed']) {
            throw new HttpRefusal(429, Messages::RATE_LIMITED, ['Retry-After' => (string) $decision['retryAfterSeconds']]);
        }

        throw new HttpRefusal(401, Messages::UNAUTHORIZED, ['WWW-Authenticate' => 'Bearer realm="recoverx-licensing"']);
    }

    /** @param array<string, mixed> $log */
    private function replyForError(\Throwable $error, array &$log): Response
    {
        if ($error instanceof HttpRefusal) {
            return Response::json($error->status, ['error' => $error->getMessage()], $error->headers);
        }

        if ($error instanceof LicenseError) {
            $log['refusal'] = $error->refusal;

            // A deactivation learns its key and machine from the verified
            // token; the refusal carries them out for the log.
            if ($error->subject !== null) {
                $log['key'] ??= Authority::logSafeKey($error->subject['key']);
                $log['machine'] ??= $error->subject['machineId'];
            }

            return Response::json($error->status, ['error' => $error->getMessage()]);
        }

        if (Store::isBusy($error)) {
            return Response::json(503, ['error' => Messages::BUSY], ['Retry-After' => (string) self::BUSY_RETRY_SECONDS]);
        }

        if ($error instanceof ConfigError) {
            $log['configuration'] = 'not usable';
        }

        return Response::json(500, ['error' => Messages::INTERNAL]);
    }

    /** A random (version 4) UUID for the X-Request-Id header and the log line. */
    public static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}

<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\App;
use RecoverX\Licensing\Config;
use RecoverX\Licensing\ConfigError;
use RecoverX\Licensing\Http\Request;
use RecoverX\Licensing\Http\Response;
use RecoverX\Licensing\Mail\SesMailer;
use RecoverX\Licensing\Order\CallingCodes;
use RecoverX\Licensing\Order\OrderForm;

/* The website's order form (POST /order/): validation, abuse limits, the stored order and the two e-mails it sends. */

const ORDER_SETTINGS = [
    'mail_from' => 'licences@snapkio.com',
    'mail_reply_to' => 'info@appsgain.in',
    'ses_region' => 'ap-south-1',
    'order_notify_to' => ['sales@example.com', 'owner@example.com'],
];

const ORDER_REF = '/^RX-[0-9A-F]{8}$/D';

/** @return array<string, string> */
function orderFields(array $overrides = []): array
{
    return $overrides + [
        'edition' => 'business',
        'quantity' => '2',
        'name' => 'Jane Doe',
        'email' => 'jane@example.com',
        'phoneCountry' => 'IN',
        'phone' => '98765 43210',
        'registerTo' => 'Doe Studio',
        'gstin' => '22aaaaa0000a1z5',
        'message' => "Please send a GST invoice.\nThanks!",
        'nectar' => '',
    ];
}

/**
 * @param list<array{status: int, body: string}|\RecoverX\Licensing\Mail\MailError> $answers
 * @return array{app: App, http: FakeHttp}
 */
function orderApp(array $answers = [], array $settings = ORDER_SETTINGS): array
{
    ['app' => $app] = Kit::installation($settings);
    $http = new FakeHttp($answers);
    if (($settings['mail_from'] ?? '') !== '') {
        $app->useMailer(new SesMailer('ap-south-1', 'licences@snapkio.com', 'RecoverX', 'info@appsgain.in', static fn (): array => FAKE_CREDENTIALS, $http, new FakeClock()));
    }

    return ['app' => $app, 'http' => $http];
}

function postOrder(App $app, array $fields, array $headers = [], string $ip = '203.0.113.7'): Response
{
    return (new OrderForm($app, Request::create('POST', '/order/', $headers, '', $ip, $fields)))->handle();
}

/** @return array<string, mixed> */
function sentPayload(FakeHttp $http, int $index): array
{
    return json_decode($http->requests[$index]['body'], true);
}

function sentText(FakeHttp $http, int $index): string
{
    return sentPayload($http, $index)['Content']['Simple']['Body']['Text']['Data'];
}

/** @return list<array<string, mixed>> the orders table's rows, as stored, oldest first */
function storedOrders(App $app): array
{
    return $app->store()->pdo->query('SELECT * FROM orders ORDER BY id')->fetchAll();
}

/** What the order form would make of these fields. */
function parsedOrder(array $fields): ?array
{
    return OrderForm::parse(Request::create('POST', '/order/', [], '', '203.0.113.7', $fields));
}

function orderLog(App $app): string
{
    return (string) file_get_contents($app->logger()->currentFile() ?? '');
}

const OK_ANSWER = ['status' => 200, 'body' => '{"MessageId":"m"}'];

test('a GET goes back to the form on /buy/', function (): void {
    ['app' => $app] = orderApp();
    $response = (new OrderForm($app, Request::create('GET', '/order/')))->handle();
    Assert::same(303, $response->status);
    Assert::same('/buy/#order', $response->header('Location'));
});

test('stores the order, e-mails it to the vendor with Reply-To the customer, then confirms to the customer', function (): void {
    ['app' => $app, 'http' => $http] = orderApp([['status' => 200, 'body' => '{"MessageId":"n-1"}'], ['status' => 200, 'body' => '{"MessageId":"c-1"}']]);

    $response = postOrder($app, orderFields(), ['Origin' => 'https://licensing.test']);
    Assert::same('/buy/sent/', $response->header('Location'));
    Assert::same(2, count($http->requests));

    $rows = storedOrders($app);
    Assert::same(1, count($rows));
    $row = $rows[0];
    $ref = (string) $row['ref'];
    Assert::matches(ORDER_REF, $ref);
    unset($row['ref']);
    Assert::same([
        'id' => 1,
        'created_at' => Kit::NOW,
        'updated_at' => Kit::NOW,
        'status' => 'new',
        'edition' => 'business',
        'quantity' => 2,
        'name' => 'Jane Doe',
        'email' => 'jane@example.com',
        'phone' => '+91 9876543210',
        'phone_country' => 'IN',
        'register_to' => 'Doe Studio',
        'gstin' => '22AAAAA0000A1Z5',
        'message' => "Please send a GST invoice.\nThanks!",
        'ip' => '203.0.113.7',
        'notes' => null,
        'mailed_at' => Kit::NOW,
    ], $row);

    $notice = sentPayload($http, 0);
    Assert::same(['sales@example.com', 'owner@example.com'], $notice['Destination']['ToAddresses']);
    Assert::same(['jane@example.com'], $notice['ReplyToAddresses']);
    Assert::same("RecoverX order {$ref}: Business × 2 — Jane Doe", $notice['Content']['Simple']['Subject']['Data']);
    $body = sentText($http, 0);
    foreach (["Reference:    {$ref}", 'Licences:     2', 'E-mail:       jane@example.com', 'Mobile:       +91 9876543210', 'Register to:  Doe Studio',
        'GSTIN:        22AAAAA0000A1Z5', "Please send a GST invoice.\nThanks!", 'Open it in the admin panel: https://licensing.test/admin/?page=order&id=1'] as $expected) {
        Assert::true(str_contains($body, $expected), "notification contains {$expected}");
    }
    Assert::notContains('Phone:', $body, 'the number is the mobile');
    Assert::notContains('?page=create', $body, 'the stored order is the starting point');

    $confirmation = sentPayload($http, 1);
    Assert::same(['jane@example.com'], $confirmation['Destination']['ToAddresses']);
    Assert::same(['info@appsgain.in'], $confirmation['ReplyToAddresses']);
    $text = sentText($http, 1);
    Assert::true(str_contains($text, 'RecoverX Business × 2'), 'confirmation names the edition and count');
    Assert::true(str_contains($text, "Your reference: {$ref}"), 'confirmation gives the reference');
    foreach (['Jane', 'invoice', '9876543210', 'Doe Studio'] as $typed) {
        Assert::notContains($typed, $text, 'confirmation repeats no free text');
    }

    Assert::matches('/"msg":"Order request received","ref":"RX-[0-9A-F]{8}","edition":"business","quantity":2,"stored":true,"messageId":"n-1"/', orderLog($app));
});

test('optional fields may be left empty, and are stored as NULL', function (): void {
    ['app' => $app, 'http' => $http] = orderApp([OK_ANSWER, OK_ANSWER]);
    $response = postOrder($app, orderFields(['registerTo' => '', 'gstin' => '', 'message' => '', 'edition' => 'enterprise', 'quantity' => '1']));
    Assert::same('/buy/sent/', $response->header('Location'));
    foreach (['Register to:  —', 'GSTIN:        —', "Message:\n—"] as $expected) {
        Assert::true(str_contains(sentText($http, 0), $expected), "{$expected} shown as a dash");
    }

    $row = storedOrders($app)[0];
    Assert::same([null, null, null], [$row['register_to'], $row['gstin'], $row['message']]);
    Assert::same(['enterprise', 1], [$row['edition'], $row['quantity']]);
});

test('reads the mobile number as the country\'s calling code and the national digits', function (): void {
    Assert::same('91', CallingCodes::dialCode('IN'));
    Assert::same('1', CallingCodes::dialCode('US'));
    Assert::same('383', CallingCodes::dialCode('XK'));
    Assert::same(null, CallingCodes::dialCode('in'));
    Assert::same(null, CallingCodes::dialCode('ZZ'));
    Assert::same(null, CallingCodes::dialCode(''));
    Assert::same(243, count(CallingCodes::all()));

    $cases = [
        ['IN', '98765 43210', '+91 9876543210'],
        ['IN', '  98765-43210  ', '+91 9876543210'],
        ['IN', "98765\t43210", '+91 9876543210'],
        ['US', '(555) 123-4567', '+1 5551234567'],
        ['CA', '555 123 4567', '+1 5551234567'],
        ['GB', '020 7946 0958', '+44 02079460958'],
        ['XK', '4412 3456', '+383 44123456'],
        ['IN', '1234', '+91 1234'],
        // E.164: the calling code and the number together, 15 digits at most.
        ['IN', '9876543210987', '+91 9876543210987'],
        ['US', '98765432109876', '+1 98765432109876'],
    ];
    foreach ($cases as [$country, $phone, $expected]) {
        $order = parsedOrder(orderFields(['phoneCountry' => $country, 'phone' => $phone]));
        Assert::same([$country, $expected], [$order['phoneCountry'] ?? null, $order['phone'] ?? null], json_encode([$country, $phone]));
    }
});

test('refuses malformed or missing fields without storing or sending anything', function (): void {
    $bad = [
        ['edition' => 'free'], ['edition' => 'gold'], ['quantity' => '0'], ['quantity' => '101'], ['quantity' => 'two'],
        ['name' => ''], ['name' => "Jane\r\nBcc: x@example.com"], ['name' => str_repeat('a', 201)],
        ['email' => ''], ['email' => 'jane'], ['email' => 'Jane <jane@example.com>'], ['email' => "jane@example.com\nx"],
        // The mobile number: required, national digits only (the code comes from the country), 4 to 14 digits, E.164.
        ['phone' => ''], ['phone' => '   '], ['phone' => '+91 98765 43210'], ['phone' => 'abc'], ['phone' => '123'], ['phone' => '12 3'],
        ['phone' => '98765 4321O'], ['phone' => "98765\n43210"], ['phone' => '98765.43210'], ['phone' => str_repeat('9', 21)],
        ['phone' => '98765432109876'], ['phone' => '987654321098765'], ['phone' => "98765\xC3\x28"],
        ['phoneCountry' => ''], ['phoneCountry' => 'ZZ'], ['phoneCountry' => 'in'], ['phoneCountry' => ' IN'], ['phoneCountry' => '91'],
        ['gstin' => '123'], ['message' => str_repeat('m', 2001)],
        ['message' => "bad \xC3\x28 bytes"], ['registerTo' => "\xFF\xFE"],
    ];
    foreach ($bad as $override) {
        $what = json_encode($override, JSON_INVALID_UTF8_SUBSTITUTE);
        Assert::same(null, parsedOrder(orderFields($override)), $what);
        ['app' => $app, 'http' => $http] = orderApp();
        Assert::same('/buy/error/', postOrder($app, orderFields($override))->header('Location'), $what);
        Assert::same(0, count($http->requests), "nothing sent for {$what}");
        Assert::same([], storedOrders($app), "nothing stored for {$what}");
    }

    $missing = orderFields();
    unset($missing['phone']);
    Assert::same(null, parsedOrder($missing), 'no phone field at all');
    $missing = orderFields();
    unset($missing['phoneCountry']);
    Assert::same(null, parsedOrder($missing), 'no country field at all');
});

test('a filled hidden field looks like success but stores and sends nothing', function (): void {
    ['app' => $app, 'http' => $http] = orderApp();
    Assert::same('/buy/sent/', postOrder($app, orderFields(['nectar' => 'http://spam.example']))->header('Location'));
    Assert::same(0, count($http->requests));
    Assert::same([], storedOrders($app));
});

test('refuses a post from another site, accepts one without an Origin header', function (): void {
    ['app' => $app, 'http' => $http] = orderApp([OK_ANSWER, OK_ANSWER]);
    Assert::same('/buy/error/', postOrder($app, orderFields(), ['Origin' => 'https://evil.test'])->header('Location'));
    Assert::same(0, count($http->requests));
    Assert::same([], storedOrders($app));
    Assert::same('/buy/sent/', postOrder($app, orderFields())->header('Location'));
    Assert::same(1, count(storedOrders($app)));
});

test('limits requests per address', function (): void {
    $answers = [];
    for ($i = 0; $i < 12; $i++) { // two e-mails per accepted request
        $answers[] = OK_ANSWER;
    }
    ['app' => $app, 'http' => $http] = orderApp($answers);
    for ($i = 0; $i < 5; $i++) {
        Assert::same('/buy/sent/', postOrder($app, orderFields())->header('Location'), "request {$i}");
    }
    Assert::same('/buy/error/', postOrder($app, orderFields())->header('Location'), 'sixth request');
    Assert::same('/buy/sent/', postOrder($app, orderFields(), [], '198.51.100.9')->header('Location'), 'another address still gets through');
    // Six orders reached the vendor, but jane@example.com got one confirmation a day.
    Assert::same(7, count($http->requests), 'six notifications and one confirmation');
    $refs = array_column(storedOrders($app), 'ref');
    Assert::same(6, count(array_unique($refs)), 'six orders stored, each with its own reference');
});

test('pruning the activation limiter\'s refilled buckets keeps the order limits', function (): void {
    $answers = [];
    for ($i = 0; $i < 10; $i++) {
        $answers[] = OK_ANSWER;
    }
    ['app' => $app] = orderApp($answers);
    for ($i = 0; $i < 5; $i++) {
        postOrder($app, orderFields());
    }
    // Judged by the activation limiter's burst (20) and refill (30 a minute),
    // every bucket looks refilled an hour later; the order buckets are not.
    $store = $app->store();
    $before = $store->rateLimitCount();
    $store->deleteRefilledBuckets(20, 30 / 60_000, $app->now() + 3_600_000);
    Assert::same($before, $store->rateLimitCount(), 'order buckets kept');
    Assert::same('/buy/error/', postOrder($app, orderFields())->header('Location'), 'still limited');
});

test('a stored order counts as sent when the vendor cannot be e-mailed', function (): void {
    // SES refuses the notification; the order waits in the admin panel, and the customer is still told.
    ['app' => $app, 'http' => $http] = orderApp([['status' => 400, 'body' => '{"message":"Email address is not verified."}'], OK_ANSWER]);
    Assert::same('/buy/sent/', postOrder($app, orderFields())->header('Location'));
    $row = storedOrders($app)[0];
    Assert::same(null, $row['mailed_at'], 'not e-mailed');
    Assert::same(2, count($http->requests));
    Assert::true(str_contains(sentText($http, 1), 'Your reference: ' . $row['ref']), 'the confirmation still went');
    Assert::true(str_contains(orderLog($app), '"msg":"Order form could not e-mail the request"'), 'the failure is logged');

    // Only the confirmation fails: the vendor has it, so that is fine too.
    ['app' => $app, 'http' => $http] = orderApp([OK_ANSWER, ['status' => 400, 'body' => '{"message":"Address blacklisted."}']]);
    Assert::same('/buy/sent/', postOrder($app, orderFields())->header('Location'));
    Assert::same(2, count($http->requests));
    Assert::same(Kit::NOW, storedOrders($app)[0]['mailed_at']);

    // E-mail switched off altogether: stored, sent, and a warning in the log.
    ['app' => $app] = orderApp([], []);
    Assert::same('/buy/sent/', postOrder($app, orderFields())->header('Location'), 'e-mail switched off');
    $row = storedOrders($app)[0];
    Assert::same(['new', null], [$row['status'], $row['mailed_at']]);
    Assert::matches('/"level":"warn","msg":"Order stored but not e-mailed: e-mail is off or order_notify_to is empty"/', orderLog($app));
});

test('fails only when the order can be neither stored nor e-mailed', function (): void {
    $refuseInserts = static fn (App $app) => $app->store()->pdo->exec(
        "CREATE TRIGGER no_orders BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT, 'read only'); END",
    );

    // Not stored, but e-mailed: the vendor has it, without a reference.
    ['app' => $app, 'http' => $http] = orderApp([OK_ANSWER, OK_ANSWER]);
    $refuseInserts($app);
    Assert::same('/buy/sent/', postOrder($app, orderFields())->header('Location'));
    Assert::same('RecoverX order: Business × 2 — Jane Doe', sentPayload($http, 0)['Content']['Simple']['Subject']['Data']);
    Assert::true(str_contains(sentText($http, 0), 'Reference:    — (not stored'), 'the e-mail says it was not stored');
    Assert::true(str_contains(sentText($http, 0), 'https://licensing.test/admin/?page=create'), 'and points to the create page instead');
    Assert::notContains('Your reference', sentText($http, 1), 'no reference to confirm');
    Assert::matches('/"level":"error","msg":"Order form could not store the request".*read only/', orderLog($app));

    // Neither: the visitor is told it failed.
    ['app' => $app, 'http' => $http] = orderApp([['status' => 400, 'body' => '{"message":"Email address is not verified."}']]);
    $refuseInserts($app);
    Assert::same('/buy/error/', postOrder($app, orderFields())->header('Location'));
    Assert::same(1, count($http->requests), 'no confirmation for an order nobody has');

    ['app' => $app] = orderApp([], []);
    $refuseInserts($app);
    Assert::same('/buy/error/', postOrder($app, orderFields())->header('Location'), 'not stored and e-mail switched off');
    Assert::matches('/"level":"error","msg":"Order form cannot e-mail the request: e-mail is off or order_notify_to is empty"/', orderLog($app));
});

test('validates order_notify_to', function (): void {
    Assert::same(['a@example.com', 'b@example.com'], Config::validate(['order_notify_to' => ['a@example.com', 'b@example.com']])['order_notify_to']);
    Assert::same([], Config::validate([])['order_notify_to']);
    foreach ([['x' => 'a@example.com'], ['not-an-address'], array_fill(0, 6, 'a@example.com'), 'a@example.com'] as $value) {
        Assert::throws(ConfigError::class, static fn () => Config::validate(['order_notify_to' => $value]), '/order_notify_to must be a list/');
    }
});

test('sends one message to several recipients with its own Reply-To', function (): void {
    $http = new FakeHttp([['status' => 200, 'body' => '{"MessageId":"m"}']]);
    mailer($http)->send(['a@example.com', 'b@example.com'], 'S', 'T', 'customer@example.com');
    $payload = json_decode($http->requests[0]['body'], true);
    Assert::same(['a@example.com', 'b@example.com'], $payload['Destination']['ToAddresses']);
    Assert::same(['customer@example.com'], $payload['ReplyToAddresses']);
    Assert::throws(\RecoverX\Licensing\Mail\MailError::class, static fn () => mailer(new FakeHttp([]))->send([], 'S', 'T'), '/between 1 and 50/');
    Assert::throws(\RecoverX\Licensing\Mail\MailError::class, static fn () => mailer(new FakeHttp([]))->send('a@example.com', "S\r\nBcc: x", 'T'), '/subject/');
});

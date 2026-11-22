<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Order;

use RecoverX\Licensing\Admin\Panel;
use RecoverX\Licensing\App;
use RecoverX\Licensing\Http\Api;
use RecoverX\Licensing\Http\Request;
use RecoverX\Licensing\Http\Response;
use RecoverX\Licensing\Mail\MailError;
use RecoverX\Licensing\Mail\SesMailer;
use RecoverX\Licensing\RateLimiter;
use RecoverX\Licensing\Web\Html;

/**
 * The website's order form, posted to /order/.
 *
 * The website is static (no scripts, no cookies), so the form posts here and
 * every outcome is a 303 to a static page: /buy/sent/ or /buy/error/. Each
 * request is stored first, in the private `orders` table, where the admin
 * panel lists it under a reference such as `RX-1A2B3C4D` for the vendor to
 * follow up; then it is e-mailed to the vendor (`order_notify_to`), with
 * Reply-To set to the customer. The visitor is told it was sent when either
 * worked — the vendor finds it in one place or the other — and that it failed
 * only when both did. The customer gets a short confirmation that repeats
 * nothing they typed except the edition and count (and the reference, which
 * the server made) — so the form cannot be used to send someone else a
 * message of one's choice.
 *
 * The name, the e-mail address and a mobile number are required. The number
 * comes as a country (`phoneCountry`, an ISO code from `calling-codes.json`,
 * since several countries share a calling code) and the national digits
 * (`phone`), and is stored as `+<code> <digits>`, e.g. `+91 9876543210`.
 *
 * Abuse limits: a hidden "nectar" field that people leave empty, a POST from
 * another site's page refused by its Origin header, and token buckets per
 * address and overall.
 */
final class OrderForm
{
    public const SENT = '/buy/sent/';
    public const FAILED = '/buy/error/';
    public const FORM = '/buy/#order';

    /** Requests one address may send: a burst, then this many per hour. */
    private const PER_ADDRESS_BURST = 5;
    private const PER_ADDRESS_PER_HOUR = 5;

    /** Requests from everywhere together: a burst, then this many per day. */
    private const OVERALL_BURST = 100;
    private const OVERALL_PER_DAY = 200;

    /** Confirmations one customer address may receive per day. */
    private const CONFIRMATIONS_PER_DAY = 1;

    /** Longest value accepted per field, in characters. */
    private const MAX = ['name' => 200, 'email' => 254, 'registerTo' => 200, 'gstin' => 15, 'message' => 2000];

    /** National digits of a mobile number: at least, at most. */
    private const PHONE_MIN_DIGITS = 4;
    private const PHONE_MAX_DIGITS = 14;

    /** E.164: the calling code and the national number together. */
    private const E164_MAX_DIGITS = 15;

    public const MAX_QUANTITY = 100;

    public function __construct(private readonly App $app, private readonly Request $request)
    {
    }

    public static function run(App $app): void
    {
        $request = Request::fromGlobals();
        (new self($app, $request))->handle()->send($request->method === 'HEAD');
    }

    public function handle(): Response
    {
        if ($this->request->method !== 'POST') {
            return Html::redirect(self::FORM);
        }

        if (!$this->app->isSetUp()) {
            return Html::redirect(self::FAILED);
        }

        $logger = $this->app->logger();
        $ip = (new Api($this->app))->clientAddress($this->request);
        $site = rtrim($this->app->config()->siteUrl() ?? ('https://' . ($this->request->header('host') ?? 'localhost')), '/');

        // A browser posting from another site's page says so; refuse it.
        $origin = $this->request->header('origin');
        if ($origin !== null && $origin !== '' && strcasecmp(rtrim($origin, '/'), $site) !== 0) {
            $logger->warn('Order form refused: foreign origin', ['origin' => mb_substr($origin, 0, 100), 'ip' => $ip]);

            return Html::redirect(self::FAILED);
        }

        // People leave the hidden field empty; form-filling robots do not. Pretend it worked.
        if (trim($this->request->field('nectar')) !== '') {
            $logger->info('Order form: honeypot filled, nothing sent', ['ip' => $ip]);

            return Html::redirect(self::SENT);
        }

        $order = self::parse($this->request);
        if ($order === null) {
            $logger->info('Order form: invalid fields', ['ip' => $ip]);

            return Html::redirect(self::FAILED);
        }

        $store = $this->app->store();
        $now = $this->app->now();
        $mine = $store->takeToken('order|' . RateLimiter::clientBucketId($ip), self::PER_ADDRESS_BURST, self::PER_ADDRESS_PER_HOUR / 3_600_000, $now, 10_000);
        $all = $mine['allowed'] ? $store->takeToken('order|*', self::OVERALL_BURST, self::OVERALL_PER_DAY / 86_400_000, $now, 10_000) : $mine;
        if (!$mine['allowed'] || !$all['allowed']) {
            $logger->warn('Order form rate limited', ['ip' => $ip, 'overall' => $mine['allowed']]);

            return Html::redirect(self::FAILED);
        }

        // Stored first: the admin panel is where the vendor follows orders up,
        // and a stored order survives an e-mail that does not arrive.
        $saved = null;
        try {
            $saved = $store->insertOrder($order, $ip, $now);
        } catch (\Throwable $error) {
            $logger->error('Order form could not store the request', ['error' => $error->getMessage(), 'ip' => $ip]);
        }

        $settings = $this->app->config()->settings;
        $recipients = $settings['order_notify_to'] !== [] ? $settings['order_notify_to']
            : ($settings['mail_reply_to'] !== '' ? [$settings['mail_reply_to']] : []);
        $mailer = $this->app->mailer();
        $messageId = null;

        if ($mailer === null || $recipients === []) {
            $context = ['ref' => $saved['ref'] ?? null, 'ip' => $ip];
            if ($saved === null) {
                $logger->error('Order form cannot e-mail the request: e-mail is off or order_notify_to is empty', $context);
            } else {
                $logger->warn('Order stored but not e-mailed: e-mail is off or order_notify_to is empty', $context);
            }
        } else {
            try {
                $notice = self::notification($order, $site, $now, $saved);
                $messageId = $mailer->send($recipients, $notice['subject'], $notice['text'], $order['email']);
            } catch (MailError|\JsonException $error) {
                $logger->error('Order form could not e-mail the request', ['error' => $error->getMessage(), 'ref' => $saved['ref'] ?? null, 'ip' => $ip]);
            }
        }

        if ($saved === null && $messageId === null) {
            return Html::redirect(self::FAILED);
        }

        if ($saved !== null && $messageId !== null) {
            try {
                $store->markOrderMailed($saved['id'], $now);
            } catch (\Throwable $error) {
                $logger->warn('Order e-mailed, but that could not be noted on it', ['error' => $error->getMessage(), 'ref' => $saved['ref']]);
            }
        }

        // The confirmation is a courtesy: the vendor already has the request.
        // One per address a day, so the form cannot be used to flood an inbox.
        if ($mailer !== null) {
            $recipientBucket = 'order|to|' . substr(hash('sha256', strtolower($order['email'])), 0, 32);
            if ($store->takeToken($recipientBucket, self::CONFIRMATIONS_PER_DAY, self::CONFIRMATIONS_PER_DAY / 86_400_000, $now, 10_000)['allowed']) {
                try {
                    $confirmation = self::confirmation($order, $site, $saved['ref'] ?? null);
                    $mailer->send($order['email'], $confirmation['subject'], $confirmation['text']);
                } catch (MailError|\JsonException $error) {
                    $logger->warn('Order form could not confirm to the customer', ['error' => $error->getMessage()]);
                }
            }
        }

        $logger->info('Order request received', [
            'ref' => $saved['ref'] ?? null,
            'edition' => $order['edition'],
            'quantity' => $order['quantity'],
            'stored' => $saved !== null,
            'messageId' => $messageId,
            'ip' => $ip,
        ]);

        return Html::redirect(self::SENT);
    }

    /**
     * The fields, checked and trimmed, or `null` when anything required is
     * missing or anything is malformed. The website's form enforces most of
     * the same rules in the browser.
     *
     * `phone` comes back as `+<calling code> <digits>`, e.g. `+91 9876543210`,
     * and `phoneCountry` as the ISO code it was chosen by.
     *
     * @return null|array{edition: string, quantity: int, name: string, email: string, phoneCountry: string, phone: string, registerTo: string, gstin: string, message: string}
     */
    public static function parse(Request $request): ?array
    {
        // Browsers send UTF-8; anything else could not be stored or e-mailed (JSON).
        foreach (['edition', 'quantity', 'name', 'email', 'phoneCountry', 'phone', 'registerTo', 'gstin', 'message'] as $field) {
            if (!mb_check_encoding($request->field($field), 'UTF-8')) {
                return null;
            }
        }

        // One-line fields: a tab (which can be pasted in) counts as a space; a
        // line break or other control character is refused outright (the form
        // cannot send one); runs of spaces are collapsed.
        $line = static function (string $name) use ($request): ?string {
            $raw = str_replace("\t", ' ', $request->field($name));
            if (preg_match('/[\x00-\x1F\x7F]/', $raw) === 1) {
                return null;
            }
            $value = trim(preg_replace('/\s+/u', ' ', $raw) ?? '');

            return mb_strlen($value) > self::MAX[$name] ? null : $value;
        };

        $edition = $request->field('edition');
        if (!array_key_exists($edition, Panel::EDITIONS)) {
            return null;
        }

        $quantityText = trim($request->field('quantity'));
        $quantity = preg_match('/^\d{1,3}$/D', $quantityText) === 1 ? (int) $quantityText : 0;
        if ($quantity < 1 || $quantity > self::MAX_QUANTITY) {
            return null;
        }

        $name = $line('name');
        $email = $line('email');
        $registerTo = $line('registerTo');
        $gstin = $line('gstin');
        if ($name === null || $name === '' || $email === null || !SesMailer::isAddress($email)
            || $registerTo === null || $gstin === null) {
            return null;
        }

        $phoneCountry = $request->field('phoneCountry');
        $phone = self::phone($phoneCountry, $request->field('phone'));
        if ($phone === null) {
            return null;
        }

        $gstin = strtoupper($gstin);
        if ($gstin !== '' && preg_match('/^[0-9A-Z]{15}$/D', $gstin) !== 1) {
            return null;
        }

        // The message keeps its line breaks; other control characters go.
        $message = trim(str_replace(["\r\n", "\r"], "\n", $request->field('message')));
        $message = preg_replace('/[\x00-\x08\x0B-\x1F\x7F]/', '', $message) ?? '';
        if (mb_strlen($message) > self::MAX['message']) {
            return null;
        }

        return compact('edition', 'quantity', 'name', 'email', 'phoneCountry', 'phone', 'registerTo', 'gstin', 'message');
    }

    /**
     * A mobile number as `+<calling code> <digits>`, or `null` when the
     * country is not on the list or the number is not one.
     *
     * The field holds the national number only — digits, spaces, brackets and
     * dashes, 4 to 20 characters, as the form's `pattern` allows; the calling
     * code comes from the country. What is kept is the digits: 4 to 14 of
     * them, and no more than E.164's 15 with the calling code.
     */
    private static function phone(string $country, string $input): ?string
    {
        $dial = CallingCodes::dialCode($country);
        if ($dial === null) {
            return null;
        }

        $text = trim(str_replace("\t", ' ', $input));
        if (preg_match('/^[0-9 ()\-]{4,20}$/D', $text) !== 1) {
            return null;
        }

        $digits = preg_replace('/\D/', '', $text) ?? '';
        $count = strlen($digits);
        if ($count < self::PHONE_MIN_DIGITS || $count > self::PHONE_MAX_DIGITS || strlen($dial) + $count > self::E164_MAX_DIGITS) {
            return null;
        }

        return "+{$dial} {$digits}";
    }

    /**
     * The e-mail to the vendor. Everything the customer typed is in the body,
     * as plain text; the subject carries only the reference, the edition, the
     * count and the name (one line, no control characters).
     *
     * @param array{edition: string, quantity: int, name: string, email: string, phone: string, registerTo: string, gstin: string, message: string} $order
     * @param null|array{id: int, ref: string} $saved the stored order, or `null` when it could not be stored
     * @return array{subject: string, text: string}
     */
    public static function notification(array $order, string $site, int $nowMs, ?array $saved = null): array
    {
        [$label, $seats, $price] = Panel::EDITIONS[$order['edition']];
        $none = '—';
        $lines = [
            'A new order request came in through the website order form.',
            '',
            'Reference:    ' . ($saved === null ? "{$none} (not stored: the database could not be written)" : $saved['ref']),
            "Edition:      {$label} ({$seats}; {$price})",
            "Licences:     {$order['quantity']}",
            "Name:         {$order['name']}",
            "E-mail:       {$order['email']}",
            "Mobile:       {$order['phone']}",
            'Register to:  ' . ($order['registerTo'] === '' ? $none : $order['registerTo']),
            'GSTIN:        ' . ($order['gstin'] === '' ? $none : $order['gstin']),
            'Received:     ' . gmdate('Y-m-d H:i', intdiv($nowMs, 1000)) . ' UTC',
            '',
            'Message:',
            $order['message'] === '' ? $none : $order['message'],
            '',
            'Reply to this e-mail to answer the customer: Reply-To is their address.',
            $saved === null
                ? "Once they have paid, create the licence and e-mail the key: {$site}/admin/?page=create"
                : "Open it in the admin panel: {$site}/admin/?page=order&id={$saved['id']}",
        ];

        return [
            'subject' => 'RecoverX order' . ($saved === null ? '' : ' ' . $saved['ref']) . ": {$label} × {$order['quantity']} — {$order['name']}",
            'text' => implode("\n", $lines) . "\n",
        ];
    }

    /**
     * The confirmation to the customer. It repeats only the edition, the
     * count and the reference the server gave the order, never free text, so
     * nobody can use the form to send a stranger words of their own.
     *
     * @param array{edition: string, quantity: int} $order
     * @return array{subject: string, text: string}
     */
    public static function confirmation(array $order, string $site, ?string $ref = null): array
    {
        [$label] = Panel::EDITIONS[$order['edition']];
        $text = implode("\n", [
            'Hello,',
            '',
            'Thank you for your interest in RecoverX. We have received your order request:',
            '',
            "    RecoverX {$label} × {$order['quantity']}",
            '',
            ...($ref === null ? [] : ["Your reference: {$ref}", '']),
            'We will reply to this e-mail with how to pay, usually within one business day.',
            'Your licence key follows by e-mail once the payment has been received.',
            '',
            'If you did not send this request, you can ignore this e-mail.',
            '',
            'RecoverX',
            $site,
        ]) . "\n";

        return ['subject' => 'Your RecoverX order request', 'text' => $text];
    }
}

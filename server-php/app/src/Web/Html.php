<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Web;

use RecoverX\Licensing\Http\Response;

/**
 * HTML for the admin panel and the setup page: escaping, the page shell and
 * the security headers every page carries.
 *
 * Everything that reaches a page from the database or the request goes
 * through `e()`. The pages load nothing from anywhere else — no fonts, no
 * scripts, no images — and the Content-Security-Policy says so, with a
 * per-response nonce for the few lines of inline script (copy buttons).
 */
final class Html
{
    private static ?string $nonce = null;

    private function __construct()
    {
    }

    /** Escape text for HTML element content and quoted attribute values. */
    public static function e(mixed $value): string
    {
        return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }

    public static function nonce(): string
    {
        return self::$nonce ??= rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
    }

    /** An epoch-millisecond instant as `2026-11-12 14:05 UTC`, or a dash. */
    public static function time(?int $epochMs): string
    {
        if ($epochMs === null) {
            return '—';
        }

        return gmdate('Y-m-d H:i', intdiv($epochMs, 1000)) . ' UTC';
    }

    /** A date only, as `2027-11-12`, or a dash. */
    public static function date(?int $epochMs): string
    {
        return $epochMs === null ? '—' : gmdate('Y-m-d', intdiv($epochMs, 1000));
    }

    /**
     * A complete page.
     *
     * Without `nav` (sign-in, setup) the page is a slim top bar over the
     * content. With `nav` (the signed-in admin panel) it is a side panel —
     * fixed on wide screens, a drawer below 1024px — beside the content.
     * The drawer needs no script: `#side-toggle` is a real checkbox, styled
     * as the menu button, so it is reachable and operable from the keyboard,
     * and the dimmed backdrop is a label for it, so a tap there closes it.
     *
     * @param array{nav?: string, status?: int, headers?: array<string, string>} $options
     */
    public static function page(string $title, string $body, array $options = []): Response
    {
        $nonce = self::nonce();
        $nav = $options['nav'] ?? '';
        $brand = '<span class="brand">RecoverX <span>licensing</span></span>';
        $shell = $nav === ''
            ? '<body><header class="top"><div class="wrap">' . $brand . '</div></header><main class="wrap">' . $body . '</main>'
            : '<body class="with-side"><a class="skip" href="#main">Skip to content</a>'
                . '<input type="checkbox" id="side-toggle" class="side-toggle" aria-label="Menu" aria-controls="side" autocomplete="off">'
                . '<label for="side-toggle" class="side-scrim" aria-hidden="true"></label>'
                . '<header class="bar">' . $brand . '</header>'
                . '<div class="side" id="side"><div class="side-head">' . $brand . '</div>' . $nav . '</div>'
                . '<div class="content"><main id="main" class="page" tabindex="-1">' . $body . '</main></div>';
        $html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<meta name="robots" content="noindex, nofollow">'
            . '<title>' . self::e($title) . ' · RecoverX licensing</title>'
            . '<style>' . self::CSS . '</style></head>' . $shell
            . '<script nonce="' . $nonce . '">' . self::SCRIPT . '</script></body></html>';

        return new Response($options['status'] ?? 200, $html, ($options['headers'] ?? []) + self::headers());
    }

    /** @return array<string, string> */
    public static function headers(): array
    {
        return [
            'Content-Type' => 'text/html; charset=utf-8',
            'Cache-Control' => 'no-store',
            'Pragma' => 'no-cache',
            'X-Content-Type-Options' => 'nosniff',
            'X-Frame-Options' => 'DENY',
            'Referrer-Policy' => 'no-referrer',
            'Content-Security-Policy' => "default-src 'none'; style-src 'unsafe-inline'; img-src data:; "
                . "script-src 'nonce-" . self::nonce() . "'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ];
    }

    /** A 303 redirect after a form post, so a refresh never repeats the action. */
    public static function redirect(string $location): Response
    {
        return new Response(303, '', ['Location' => $location, 'Cache-Control' => 'no-store']);
    }

    /** A file download. */
    public static function download(string $filename, string $contents, string $type): Response
    {
        return new Response(200, $contents, [
            'Content-Type' => $type,
            'Content-Disposition' => 'attachment; filename="' . str_replace('"', '', $filename) . '"',
            'Content-Length' => (string) strlen($contents),
            'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    /** @param 'ok'|'error'|'warn'|'info' $kind */
    public static function notice(string $kind, string $html): string
    {
        return '<div class="notice ' . $kind . '" role="' . ($kind === 'error' ? 'alert' : 'status') . '">' . $html . '</div>';
    }

    /** A read-only value with a copy button. */
    public static function copyable(string $value, string $label, bool $multiline = false): string
    {
        $id = 'c' . bin2hex(random_bytes(4));
        $field = $multiline
            ? '<textarea id="' . $id . '" readonly rows="4" aria-label="' . self::e($label) . '">' . self::e($value) . '</textarea>'
            : '<input id="' . $id . '" readonly value="' . self::e($value) . '" aria-label="' . self::e($label) . '">';

        return '<div class="copy">' . $field . '<button type="button" class="secondary" data-copy="' . $id . '">Copy</button></div>';
    }

    private const SCRIPT = <<<'JS'
        document.querySelectorAll('[data-copy]').forEach(function (button) {
          button.addEventListener('click', function () {
            var field = document.getElementById(button.getAttribute('data-copy'));
            field.select();
            var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.textContent = 'Copy'; }, 1500); };
            if (navigator.clipboard) { navigator.clipboard.writeText(field.value).then(done, function () { document.execCommand('copy'); done(); }); }
            else { document.execCommand('copy'); done(); }
          });
        });
        document.querySelectorAll('form[data-confirm]').forEach(function (form) {
          form.addEventListener('submit', function (event) {
            if (!window.confirm(form.getAttribute('data-confirm'))) { event.preventDefault(); }
          });
        });
        JS;

    private const CSS = <<<'CSS'
        /* RecoverX licensing admin: "Night & Paper" (same tokens as the website).
           Stylesheet only: every image is a data: SVG (CSP img-src data:), no fonts, no network.
           Icons are masks, so they take currentColor. Motion stops under prefers-reduced-motion. */
        :root {
          --i-dashboard: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='7' height='9' x='3' y='3' rx='1.5'/%3E%3Crect width='7' height='5' x='14' y='3' rx='1.5'/%3E%3Crect width='7' height='9' x='14' y='12' rx='1.5'/%3E%3Crect width='7' height='5' x='3' y='16' rx='1.5'/%3E%3C/svg%3E");
          --i-key: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='7.5' cy='15.5' r='5.5'/%3E%3Cpath d='m21 2-9.6 9.6'/%3E%3Cpath d='m15.5 7.5 3 3L22 7l-3-3'/%3E%3C/svg%3E");
          --i-plus: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12h14'/%3E%3Cpath d='M12 5v14'/%3E%3C/svg%3E");
          --i-plus-circle: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M8 12h8'/%3E%3Cpath d='M12 8v8'/%3E%3C/svg%3E");
          --i-code: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='16 18 22 12 16 6'/%3E%3Cpolyline points='8 6 2 12 8 18'/%3E%3C/svg%3E");
          --i-database: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cellipse cx='12' cy='5' rx='9' ry='3'/%3E%3Cpath d='M3 5v14a9 3 0 0 0 18 0V5'/%3E%3Cpath d='M3 12a9 3 0 0 0 18 0'/%3E%3C/svg%3E");
          --i-lock: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='11' x='3' y='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E");
          --i-logout: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'/%3E%3Cpolyline points='16 17 21 12 16 7'/%3E%3Cline x1='21' x2='9' y1='12' y2='12'/%3E%3C/svg%3E");
          --i-login: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4'/%3E%3Cpolyline points='10 17 15 12 10 7'/%3E%3Cline x1='15' x2='3' y1='12' y2='12'/%3E%3C/svg%3E");
          --i-search: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='7.5'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E");
          --i-copy: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='13' height='13' x='9' y='9' rx='2'/%3E%3Cpath d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/%3E%3C/svg%3E");
          --i-check: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E");
          --i-check-circle: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='m8.5 12 2.5 2.5 4.5-5'/%3E%3C/svg%3E");
          --i-alert: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'/%3E%3Cpath d='M12 9v4'/%3E%3Cpath d='M12 17h.01'/%3E%3C/svg%3E");
          --i-alert-circle: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 8v4'/%3E%3Cpath d='M12 16h.01'/%3E%3C/svg%3E");
          --i-info: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 16v-4'/%3E%3Cpath d='M12 8h.01'/%3E%3C/svg%3E");
          --i-ban: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='m4.9 4.9 14.2 14.2'/%3E%3C/svg%3E");
          --i-restore: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'/%3E%3Cpath d='M3 3v5h5'/%3E%3C/svg%3E");
          --i-calendar: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='18' x='3' y='4' rx='2'/%3E%3Cpath d='M16 2v4'/%3E%3Cpath d='M8 2v4'/%3E%3Cpath d='M3 10h18'/%3E%3Cpath d='M12 14v4'/%3E%3Cpath d='M10 16h4'/%3E%3C/svg%3E");
          --i-wifi-off: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 20h.01'/%3E%3Cpath d='M8.5 16.43a5 5 0 0 1 7 0'/%3E%3Cpath d='M5 12.86a10 10 0 0 1 5.17-2.69'/%3E%3Cpath d='M19 12.86a10 10 0 0 0-2-1.52'/%3E%3Cpath d='M2 8.82a15 15 0 0 1 4.18-2.64'/%3E%3Cpath d='M22 8.82a15 15 0 0 0-11.29-3.76'/%3E%3Cpath d='m2 2 20 20'/%3E%3C/svg%3E");
          --i-refresh: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'/%3E%3Cpath d='M21 3v5h-5'/%3E%3Cpath d='M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'/%3E%3Cpath d='M8 16H3v5'/%3E%3C/svg%3E");
          --i-unplug: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m19 5 3-3'/%3E%3Cpath d='m2 22 3-3'/%3E%3Cpath d='M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z'/%3E%3Cpath d='M7.5 13.5 10 11'/%3E%3Cpath d='M10.5 16.5 13 14'/%3E%3Cpath d='m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z'/%3E%3C/svg%3E");
          --i-save: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'/%3E%3Cpath d='M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7'/%3E%3Cpath d='M7 3v4a1 1 0 0 0 1 1h7'/%3E%3C/svg%3E");
          --i-user-pen: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M11.5 15H7a4 4 0 0 0-4 4v2'/%3E%3Cpath d='M21.38 16.63a1 1 0 0 0-3-3l-4.02 4a2 2 0 0 0-.5.86l-.84 2.87a.5.5 0 0 0 .62.62l2.87-.84a2 2 0 0 0 .85-.5z'/%3E%3Ccircle cx='10' cy='7' r='4'/%3E%3C/svg%3E");
          --i-eraser: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21'/%3E%3Cpath d='M22 21H7'/%3E%3Cpath d='m5 11 9 9'/%3E%3C/svg%3E");
          --i-trash: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 6h18'/%3E%3Cpath d='M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'/%3E%3Cpath d='M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'/%3E%3Cpath d='M10 11v6'/%3E%3Cpath d='M14 11v6'/%3E%3C/svg%3E");
          --i-download: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/%3E%3Cpolyline points='7 10 12 15 17 10'/%3E%3Cline x1='12' x2='12' y1='15' y2='3'/%3E%3C/svg%3E");
          --i-monitor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='20' height='14' x='2' y='3' rx='2'/%3E%3Cline x1='8' x2='16' y1='21' y2='21'/%3E%3Cline x1='12' x2='12' y1='17' y2='21'/%3E%3C/svg%3E");
          --i-shield-check: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'/%3E%3Cpath d='m9 12 2 2 4-4'/%3E%3C/svg%3E");
          --i-hourglass: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 22h14'/%3E%3Cpath d='M5 2h14'/%3E%3Cpath d='M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22'/%3E%3Cpath d='M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2'/%3E%3C/svg%3E");
          --i-power: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 2v10'/%3E%3Cpath d='M18.4 6.6a9 9 0 1 1-12.77.04'/%3E%3C/svg%3E");
          --img-logo: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%233B6FE0'/%3E%3Cstop offset='1' stop-color='%237C4DE8'/%3E%3C/linearGradient%3E%3Cmask id='m'%3E%3Crect width='64' height='64' fill='white'/%3E%3Cpath d='M27.2 33.92 30.592 38.4 37.44 28.16' fill='none' stroke='black' stroke-width='3.968' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/mask%3E%3C/defs%3E%3Crect width='64' height='64' rx='13.44' fill='url(%23g)'/%3E%3Cpath d='M17.862 12.8H46.138L47.04 24.704A15.04 27.776 0 0 1 32 52.48A15.04 27.776 0 0 1 16.96 24.704Z' fill='white' mask='url(%23m)'/%3E%3C/svg%3E");
          --img-user: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='8' r='4.5'/%3E%3Cpath d='M20 21a8 8 0 0 0-16 0'/%3E%3C/svg%3E");
          --img-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236B7699' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
          --img-chevron-night: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23A9B3D3' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
          --img-search: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236B7699' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='7.5'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E");
          --img-menu: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23E9EDFB' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M4 7h16'/%3E%3Cpath d='M4 12h16'/%3E%3Cpath d='M4 17h10'/%3E%3C/svg%3E");
          --img-close: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23E9EDFB' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M18 6 6 18'/%3E%3Cpath d='m6 6 12 12'/%3E%3C/svg%3E");
          --img-search-night: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23A9B3D3' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='7.5'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E");
        }
        /* ---- Tokens ------------------------------------------------------------- */
        :root {
          color-scheme: light dark;
          --font: "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Roboto, Arial, sans-serif;
          --font-display: "Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Roboto, Arial, sans-serif;
          --mono: "Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, "SF Mono", Menlo, monospace;
          --brand-a: #3B6FE0; --brand-b: #7C4DE8; --lum-a: #86A9FF; --lum-b: #B9A0FF;
          --grad: linear-gradient(135deg, #3B6FE0, #7C4DE8);
          --grad-lum: linear-gradient(92deg, #86A9FF, #B9A0FF);
          --night-0: #04071A; --night-1: #070C24; --night-2: #0C1333; --night-3: #141C46;
          --on-night: #F3F5FF; --on-night-2: #B7C1E2; --on-night-3: #929DC4; --night-line: rgba(168, 186, 255, .13);
          --ease: cubic-bezier(.2, .7, .2, 1);
          --wrap: 1280px; --gutter: clamp(16px, 4vw, 32px);
          --r-sm: 10px; --r: 14px; --r-lg: 18px;

          /* Paper (light) */
          --bg: #F4F6FC; --surface: #FFFFFF; --surface-2: #F7F8FD; --input: #FFFFFF;
          --text: #0A1030; --text-2: #475172; --text-3: #5E6886;
          --line: #E2E6F1; --line-2: #CDD4E6;
          --link: #2D52C4; --focus: #3B6FE0;
          --chip-bg: #F1F4FF; --chip-text: #22337A; --chip-line: #DCE3FA;
          --zebra: #FAFBFE; --hover: #EFF3FF;
          --shadow: 0 1px 2px rgba(10, 16, 48, .05), 0 12px 32px -14px rgba(10, 16, 48, .18);
          --shadow-hi: 0 1px 2px rgba(10, 16, 48, .06), 0 22px 44px -18px rgba(10, 16, 48, .28);
          --ring: 0 0 0 4px rgba(59, 111, 224, .18);
          /* The page header beside the side panel. */
          --head-bg: #FFFFFF; --head-glow: rgba(124, 77, 232, .085);
          --head-bar: var(--grad); --head-bar-glow: 0 0 12px rgba(91, 110, 240, .45);

          /* Tones: text / tint / line, then a solid dot. AA on their tint. */
          --green: #047857; --green-bg: #E7F8F0; --green-line: #BCEBD6; --green-dot: #10B981;
          --teal: #0F766E; --teal-bg: #E4F6F3; --teal-line: #B5E5DD; --teal-dot: #14B8A6;
          --cyan: #0E7490; --cyan-bg: #E3F5FA; --cyan-line: #B7E3EF; --cyan-dot: #06B6D4;
          --blue: #1D4ED8; --blue-bg: #EAF1FF; --blue-line: #C9D9FB; --blue-dot: #3B82F6;
          --indigo: #4338CA; --indigo-bg: #EEF0FF; --indigo-line: #D3D7FB; --indigo-dot: #6366F1;
          --violet: #6D28D9; --violet-bg: #F3EEFF; --violet-line: #DDD0FB; --violet-dot: #8B5CF6;
          --amber: #92400E; --amber-bg: #FDF5E2; --amber-line: #F4DFA8; --amber-dot: #F59E0B;
          --orange: #B23A0A; --orange-bg: #FFF0E6; --orange-line: #FBD0B5; --orange-dot: #F97316;
          --red: #B91C1C; --red-bg: #FDECEC; --red-line: #F6C8C8; --red-dot: #EF4444;
          --slate: #475569; --slate-bg: #F1F4F8; --slate-line: #D9DFE8; --slate-dot: #94A3B8;

          /* Names the original stylesheet used, kept so nothing that refers to them breaks. */
          --panel: var(--surface); --muted: var(--text-2); --accent: var(--brand-a);
          --ok: var(--green); --warn: var(--amber); --bad: var(--red);
        }
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) {
            --bg: #090E25; --surface: #10173A; --surface-2: #121A40; --input: #0C1333;
            --text: #E9EDFB; --text-2: #A9B3D3; --text-3: #8F9AC0;
            --line: rgba(255, 255, 255, .09); --line-2: rgba(255, 255, 255, .16);
            --link: #9AB6FF; --focus: #A6BEFF;
            --chip-bg: rgba(134, 169, 255, .09); --chip-text: #D2DCFF; --chip-line: rgba(134, 169, 255, .22);
            --zebra: rgba(255, 255, 255, .018); --hover: rgba(134, 169, 255, .075);
            --shadow: 0 1px 0 rgba(255, 255, 255, .04) inset, 0 16px 40px -18px rgba(0, 0, 0, .7);
            --shadow-hi: 0 1px 0 rgba(255, 255, 255, .06) inset, 0 24px 50px -20px rgba(0, 0, 0, .85);
            --ring: 0 0 0 4px rgba(134, 169, 255, .22);
            --head-bg: #0C1231; --head-glow: rgba(124, 77, 232, .2);
            --head-bar: var(--grad-lum); --head-bar-glow: 0 0 14px rgba(134, 169, 255, .7);
            --night-0: #03051A; --night-1: #050A20;
            --green: #6EE7B7; --green-bg: rgba(52, 211, 153, .12); --green-line: rgba(52, 211, 153, .32); --green-dot: #34D399;
            --teal: #5ED3C2; --teal-bg: rgba(45, 212, 191, .11); --teal-line: rgba(45, 212, 191, .3); --teal-dot: #2DD4BF;
            --cyan: #67E8F9; --cyan-bg: rgba(34, 211, 238, .11); --cyan-line: rgba(34, 211, 238, .3); --cyan-dot: #22D3EE;
            --blue: #93C5FD; --blue-bg: rgba(96, 165, 250, .12); --blue-line: rgba(96, 165, 250, .32); --blue-dot: #60A5FA;
            --indigo: #A5B4FC; --indigo-bg: rgba(129, 140, 248, .13); --indigo-line: rgba(129, 140, 248, .34); --indigo-dot: #818CF8;
            --violet: #C4B5FD; --violet-bg: rgba(167, 139, 250, .13); --violet-line: rgba(167, 139, 250, .34); --violet-dot: #A78BFA;
            --amber: #FCD34D; --amber-bg: rgba(251, 191, 36, .12); --amber-line: rgba(251, 191, 36, .32); --amber-dot: #FBBF24;
            --orange: #FDBA74; --orange-bg: rgba(251, 146, 60, .12); --orange-line: rgba(251, 146, 60, .32); --orange-dot: #FB923C;
            --red: #FCA5A5; --red-bg: rgba(248, 113, 113, .12); --red-line: rgba(248, 113, 113, .32); --red-dot: #F87171;
            --slate: #CBD5E1; --slate-bg: rgba(163, 174, 201, .12); --slate-line: rgba(163, 174, 201, .3); --slate-dot: #A3AEC9;
          }
        }
        /* ---- Base --------------------------------------------------------------- */
        * { box-sizing: border-box; }
        html { -webkit-text-size-adjust: 100%; overflow-x: clip; }
        body {
          margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
          font: 400 15px/1.55 var(--font); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
        }
        .wrap { max-width: var(--wrap); margin: 0 auto; padding: 0 var(--gutter); }
        main.wrap { padding-bottom: 72px; }
        a { color: var(--link); text-underline-offset: 3px; text-decoration-thickness: 1px; transition: color .2s; }
        a:hover { text-decoration-thickness: 2px; }
        p { margin: 0 0 12px; text-wrap: pretty; }
        p:last-child { margin-bottom: 0; }
        p:empty { margin: 0; height: 14px; }
        :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 6px; }
        ::selection { background: rgba(124, 77, 232, .22); }
        strong { font-weight: 650; }
        em { font-style: italic; }
        .muted { color: var(--text-2); }
        .sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
        .hint { color: var(--text-3); font-size: 13px; line-height: 1.5; margin: 6px 0 0; }
        code, .mono { font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
        code {
          padding: 1px 6px; border-radius: 6px; background: var(--chip-bg); color: var(--chip-text);
          border: 1px solid var(--chip-line); box-decoration-break: clone; -webkit-box-decoration-break: clone;
        }
        pre.mono {
          margin: 0 0 12px; padding: 16px 18px; border-radius: 12px; overflow-x: auto; white-space: pre; word-break: normal;
          font-size: 12.5px; line-height: 1.65; color: #D2DCFF; background:
            radial-gradient(60% 120% at 100% 0%, rgba(124, 77, 232, .22), transparent 70%),
            linear-gradient(180deg, #0C1333, #070C24);
          border: 1px solid var(--night-line); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .05);
        }

        /* ---- Headings ----------------------------------------------------------- */
        h1, h2, h3 { font-family: var(--font-display); text-wrap: balance; }
        h1 { font-size: clamp(1.7rem, 1.25rem + 1.5vw, 2.4rem); line-height: 1.1; letter-spacing: -.03em; font-weight: 750; margin: 0 0 20px; }
        h2 {
          display: flex; align-items: center; gap: 10px;
          font-size: 17px; line-height: 1.3; letter-spacing: -.01em; font-weight: 700; margin: 36px 0 14px;
        }
        h2::before { content: ""; flex: none; width: 18px; height: 3px; border-radius: 3px; background: var(--grad); }
        .card h2 { margin: 28px 0 10px; font-size: 16px; }
        .card > h2:first-of-type { margin-top: 0; }

        /* Pages without the side panel (setup): the title opens on a night band, like every page of the website. */
        main.wrap > h1:first-child {
          position: relative; margin: 0 0 28px; padding: 38px 0 42px;
          background-image:
            linear-gradient(100deg, transparent 0 38%, rgba(255, 255, 255, .95) 50%, transparent 62%),
            linear-gradient(92deg, #FFFFFF 0, #D9E2FF 120px, #B9A0FF 340px, #C9B6FF 560px);
          background-size: 260px 100%, 100% 100%; background-repeat: no-repeat; background-position: -300px 0, 0 0;
          -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent;
          animation: rx-sheen 1.6s .35s var(--ease) backwards;
        }
        main.wrap > h1:first-child::before {
          content: ""; position: absolute; z-index: -1; top: -80px; bottom: 0; left: calc(50% - 50vw); width: 100vw;
          background:
            radial-gradient(40% 120% at 88% 0%, rgba(124, 77, 232, .34), transparent 70%),
            radial-gradient(36% 110% at 8% 0%, rgba(59, 111, 224, .30), transparent 70%),
            radial-gradient(30% 80% at 55% 120%, rgba(91, 110, 240, .22), transparent 70%),
            linear-gradient(180deg, #060A22 0%, #0A0F33 70%, #0B0B2E 100%);
          border-bottom: 1px solid var(--night-line);
        }
        main.wrap > h1:first-child::after {
          content: ""; position: absolute; left: 0; bottom: 26px; width: 44px; height: 3px; border-radius: 3px;
          background: var(--grad-lum); box-shadow: 0 0 14px rgba(134, 169, 255, .7);
          transform-origin: left; animation: rx-grow .7s .25s var(--ease) backwards;
        }

        /* ---- Top bar (pages without the side panel: sign-in, setup) ------------- */
        header.top {
          position: sticky; top: 0; z-index: 40; margin: 0; color: var(--on-night);
          background: rgba(6, 9, 30, .93); -webkit-backdrop-filter: saturate(160%) blur(16px); backdrop-filter: saturate(160%) blur(16px);
          border-bottom: 1px solid var(--night-line);
        }
        header.top::before {
          content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; opacity: .9;
          background-image: linear-gradient(rgba(160, 180, 255, .05) 1px, transparent 1px), linear-gradient(90deg, rgba(160, 180, 255, .05) 1px, transparent 1px);
          background-size: 48px 48px; background-position: center top;
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 30%, #000 70%, transparent); mask-image: linear-gradient(90deg, transparent, #000 30%, #000 70%, transparent);
        }
        header.top .wrap { position: relative; display: flex; align-items: center; gap: 8px 20px; min-height: 64px; flex-wrap: nowrap; }
        header.top :focus-visible { outline-color: #A6BEFF; }
        .brand {
          display: inline-flex; align-items: center; gap: 10px; flex: none; margin-right: 8px; white-space: nowrap;
          font: 700 18px/1 var(--font-display); letter-spacing: -.015em;
          background: linear-gradient(92deg, #FFFFFF 0, #DCE4FF 60px, #B9A0FF 120px);
          -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent;
        }
        .brand::before {
          content: ""; width: 32px; height: 32px; flex: none; border-radius: 9px; background: var(--img-logo) center / contain no-repeat;
          box-shadow: 0 6px 18px -6px rgba(124, 77, 232, .9), 0 0 0 1px rgba(255, 255, 255, .08);
        }
        .brand span {
          margin-left: 2px; padding: 3px 8px 4px; border-radius: 999px; font: 600 10.5px/1 var(--font); letter-spacing: .12em; text-transform: uppercase;
          color: var(--on-night-2); -webkit-text-fill-color: var(--on-night-2); background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .12);
        }
        /* ---- Side panel shell (signed-in admin pages) --------------------------- */
        /* A night panel on the left: fixed from 1024px, an off-canvas drawer below that.
           #side-toggle is a real checkbox drawn as the menu button (Tab to it, Space toggles);
           .side-scrim is a <label> for it, so a tap on the dimmed backdrop closes the drawer.
           A closed drawer is visibility:hidden, so its links leave the tab order. No script. */
        .with-side { --side-w: 240px; --bar-h: 56px; --head-h: 84px; --drawer-w: min(300px, calc(100vw - 48px)); }
        .skip {
          position: fixed; top: 10px; left: 12px; z-index: 100; padding: 10px 16px; border-radius: 10px;
          font-weight: 650; font-size: 14px; color: #0A1030; background: #FFFFFF; text-decoration: none;
          box-shadow: 0 12px 30px -10px rgba(0, 0, 0, .6); transform: translateY(-180%); transition: transform .2s var(--ease);
        }
        .skip:focus { transform: none; }
        .side {
          position: fixed; inset: 0 auto 0 0; z-index: 50; width: var(--side-w); display: flex; flex-direction: column;
          color: var(--on-night); color-scheme: dark; overflow-y: auto; overscroll-behavior: contain;
          scrollbar-width: thin; scrollbar-color: rgba(168, 186, 255, .22) transparent;
          background:
            radial-gradient(130% 30% at 0% 0%, rgba(59, 111, 224, .24), transparent 72%),
            radial-gradient(120% 28% at 100% 100%, rgba(124, 77, 232, .22), transparent 72%),
            linear-gradient(180deg, #070C24 0%, #060A1F 55%, #050819 100%);
          border-right: 1px solid var(--night-line);
        }
        .side::before {
          content: ""; position: absolute; top: 0; left: 0; right: 0; height: 260px; z-index: -1; pointer-events: none;
          background-image: linear-gradient(rgba(160, 180, 255, .05) 1px, transparent 1px), linear-gradient(90deg, rgba(160, 180, 255, .05) 1px, transparent 1px);
          background-size: 24px 24px;
          -webkit-mask-image: radial-gradient(100% 100% at 0% 0%, #000, transparent 72%); mask-image: radial-gradient(100% 100% at 0% 0%, #000, transparent 72%);
        }
        /* As tall as the page header, so the two hairlines meet. */
        .side-head { flex: none; display: flex; align-items: center; min-height: var(--head-h); padding: 0 20px; border-bottom: 1px solid var(--night-line); }
        .side .brand, .bar .brand { margin: 0; font-size: 17px; }
        .side .brand::before, .bar .brand::before { width: 34px; height: 34px; }
        .side .brand span, .bar .brand span { font-size: 9.5px; padding: 3px 7px 4px; }

        .side-nav { flex: 1 0 auto; display: flex; flex-direction: column; gap: 22px; padding: 22px 12px 24px; }
        .nav-group { display: flex; flex-direction: column; gap: 3px; }
        .nav-label {
          display: flex; align-items: center; gap: 10px; margin: 0 0 6px; padding: 0 12px;
          font: 650 10.5px/1.4 var(--font); letter-spacing: .14em; text-transform: uppercase; color: var(--on-night-3);
        }
        .nav-label::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(168, 186, 255, .16), transparent); }
        .side-nav a {
          --icon: none; position: relative; display: flex; align-items: center; gap: 12px; min-height: 42px; padding: 0 12px; border-radius: 11px;
          color: var(--on-night-2); text-decoration: none; font-size: 14.5px; font-weight: 550; letter-spacing: -.003em;
          transition: color .2s, background-color .2s;
        }
        .side-nav a::before {
          content: ""; width: 18px; height: 18px; flex: none; background: currentColor; opacity: .8;
          -webkit-mask: var(--icon) center / contain no-repeat; mask: var(--icon) center / contain no-repeat;
          transition: transform .25s var(--ease), opacity .2s;
        }
        .side-nav a:hover { color: #FFFFFF; background-color: rgba(255, 255, 255, .06); text-decoration: none; }
        .side-nav a:hover::before { opacity: 1; transform: translateX(2px); }
        .side-nav a:focus-visible { outline: 2px solid #A6BEFF; outline-offset: 2px; }
        .side-nav a.active {
          color: #FFFFFF; font-weight: 600;
          background: linear-gradient(90deg, rgba(76, 110, 245, .44), rgba(124, 77, 232, .26) 62%, rgba(124, 77, 232, .08)) left center / 100% 100% no-repeat;
          box-shadow: inset 0 0 0 1px rgba(134, 169, 255, .24), inset 0 1px 0 rgba(255, 255, 255, .07), 0 10px 26px -14px rgba(98, 92, 236, .95);
          animation: rx-pill .55s var(--ease) backwards;
        }
        .side-nav a.active:hover::before { transform: none; }
        .side-nav a.active::before { opacity: 1; background: #D2DCFF; }
        /* The accent bar sits on the panel's edge, beside the pill, and glows. */
        .side-nav a.active::after {
          content: ""; position: absolute; left: -12px; top: 9px; bottom: 9px; width: 3px; border-radius: 0 3px 3px 0;
          background: linear-gradient(180deg, #86A9FF, #B9A0FF);
          box-shadow: 0 0 10px 1px rgba(134, 169, 255, .85), 0 0 22px 2px rgba(124, 77, 232, .45);
          animation: rx-grow-y .5s .12s var(--ease) backwards;
        }
        .side-nav a[href="./"] { --icon: var(--i-dashboard); }
        .side-nav a[href="?page=licences"] { --icon: var(--i-key); }
        .side-nav a[href="?page=create"] { --icon: var(--i-plus-circle); }
        .side-nav a[href="?page=api"] { --icon: var(--i-code); }
        .side-nav a[href="?page=backup"] { --icon: var(--i-database); }
        .side-nav a[href="?page=password"] { --icon: var(--i-lock); }

        /* Who is signed in, and the way out. */
        .side-foot {
          flex: none; display: grid; gap: 12px; margin: 0 12px 14px; padding: 14px; border-radius: 14px;
          background: linear-gradient(180deg, rgba(255, 255, 255, .055), rgba(255, 255, 255, .025)); border: 1px solid var(--night-line);
        }
        .who { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); column-gap: 11px; align-items: center; margin: 0; }
        .who::before {
          content: ""; grid-row: 1 / 4; width: 36px; height: 36px; border-radius: 50%;
          background: var(--img-user) center / 18px no-repeat, var(--grad);
          box-shadow: 0 0 0 2px #0B1030, 0 0 0 3px rgba(134, 169, 255, .4);
        }
        .who::after {
          content: ""; position: absolute; left: 27px; top: 50%; margin-top: 7px; width: 10px; height: 10px; border-radius: 50%;
          background: #34D399; box-shadow: 0 0 0 2px #0B1030;
        }
        .who-label { font: 650 10px/1.4 var(--font); letter-spacing: .12em; text-transform: uppercase; color: var(--on-night-3); }
        .who-name { font-weight: 650; font-size: 14px; line-height: 1.3; color: var(--on-night); }
        .who-meta { font-size: 12px; line-height: 1.4; color: var(--on-night-3); }
        .side-foot form { margin: 0; }
        .side-foot button.secondary {
          width: 100%; min-height: 40px; font-size: 14px; color: var(--on-night);
          background: rgba(255, 255, 255, .06); border-color: rgba(255, 255, 255, .16); box-shadow: none;
        }
        .side-foot button.secondary:hover { color: #FFFFFF; background: rgba(255, 255, 255, .12); border-color: rgba(255, 255, 255, .3); box-shadow: none; }
        .side button:focus-visible { outline-color: #A6BEFF; }

        /* The content beside the panel. It is a size container, so its parts follow its width, not the window's. */
        .bar, .side-scrim, .with-side input.side-toggle { display: none; }
        .content { margin-left: var(--side-w); min-width: 0; container-type: inline-size; overflow-x: clip; }
        .page { max-width: 1320px; margin: 0 auto; padding: 0 clamp(16px, 1.7vw, 32px) 72px; }
        .page:focus { outline: none; }
        .page > :first-child:not(h1) { margin-top: 28px; }
        /* Table cells a little tighter than before, so the activity and licence lists still fit at 1440px beside the panel. */
        .page th, .page td { padding-left: 10px; padding-right: 10px; }
        .page th:first-child, .page td:first-child { padding-left: 16px; }
        .page th:last-child, .page td:last-child { padding-right: 16px; }
        .page td.muted { min-width: 13em; }
        .page table.t-licences td:nth-child(3) { min-width: 11em; }
        .page table.t-licences td:nth-child(3) .muted { font-size: 12px; }
        /* The page title is a slim header across the whole content area, with the gradient underline. */
        .page > h1:first-child {
          position: relative; display: flex; align-items: center; min-height: var(--head-h); margin: 0 0 28px; padding: 16px 0 22px;
          font-size: clamp(1.5rem, 1.25rem + .7vw, 1.9rem); line-height: 1.15; letter-spacing: -.025em; color: var(--text);
        }
        .page > h1:first-child::before {
          content: ""; position: absolute; z-index: -1; top: 0; bottom: 0; left: calc(50% - 50cqw); width: 100cqw;
          background: radial-gradient(36% 220% at 100% 0%, var(--head-glow), transparent 70%), var(--head-bg);
          border-bottom: 1px solid var(--line);
        }
        .page > h1:first-child::after {
          content: ""; position: absolute; left: 0; bottom: 14px; width: 44px; height: 3px; border-radius: 3px;
          background: var(--head-bar); box-shadow: var(--head-bar-glow);
          transform-origin: left; animation: rx-grow .7s .2s var(--ease) backwards;
        }
        @container (max-width: 899px) {
          .page > .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @container (min-width: 1040px) {
          .page > .card > dl.facts { grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr); column-gap: 28px; }
          .page > .card > dl.facts dd:nth-of-type(odd) { padding-right: 8px; }
        }

        /* Below 1024px: a slim night bar with the menu button; the panel slides in over a dimmed backdrop. */
        @media (max-width: 1023.98px) {
          .content { margin-left: 0; }
          .bar {
            display: flex; align-items: center; position: sticky; top: 0; z-index: 40; height: var(--bar-h); padding: 0 16px 0 68px;
            color: var(--on-night); background: rgba(6, 9, 30, .94); -webkit-backdrop-filter: saturate(160%) blur(16px); backdrop-filter: saturate(160%) blur(16px);
            border-bottom: 1px solid var(--night-line);
          }
          .with-side input.side-toggle {
            display: block; position: fixed; top: 6px; left: 12px; z-index: 60; width: 44px; height: 44px; min-height: 0; max-width: none;
            margin: 0; padding: 0; -webkit-appearance: none; appearance: none; cursor: pointer; border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, .14); background: var(--img-menu) center / 22px no-repeat, rgba(255, 255, 255, .06);
            box-shadow: none; transition: background-color .2s, border-color .2s;
          }
          .with-side input.side-toggle:hover { border-color: rgba(255, 255, 255, .3); background-color: rgba(255, 255, 255, .12); }
          .with-side input.side-toggle:focus { box-shadow: none; }
          .with-side input.side-toggle:checked {
            border-color: rgba(255, 255, 255, .2); background: var(--img-close) center / 22px no-repeat, rgba(255, 255, 255, .08);
          }
          .with-side input.side-toggle:checked:hover { border-color: rgba(255, 255, 255, .34); background-color: rgba(255, 255, 255, .14); }
          .with-side input.side-toggle:focus-visible { outline: 3px solid #A6BEFF; outline-offset: 2px; border-radius: 12px; }
          .side {
            width: var(--drawer-w); transform: translateX(-100%); visibility: hidden;
            transition: transform .3s var(--ease), visibility 0s linear .3s;
          }
          .side-toggle:checked ~ .side { transform: none; visibility: visible; box-shadow: 28px 0 70px -24px rgba(0, 0, 0, .75); transition: transform .4s var(--ease), visibility 0s; }
          /* The brand row stays put while a short drawer scrolls (landscape phone, 200% zoom), so the × never sits over a link. */
          .side-head {
            position: sticky; top: 0; z-index: 2; min-height: var(--bar-h); padding-left: 68px;
            background: rgba(6, 9, 30, .94); -webkit-backdrop-filter: saturate(160%) blur(16px); backdrop-filter: saturate(160%) blur(16px);
          }
          /* While the drawer is open the page behind it is out of reach: Tab goes from "Sign out" back round to the
             menu button instead of to links hidden under the drawer, and assistive technology reads only the drawer. */
          .side-toggle:checked ~ .content, body:has(.side-toggle:checked) .skip { interactivity: inert; }
          @supports not (interactivity: inert) {
            .content { transition: opacity .3s; }
            .side-toggle:checked ~ .content, body:has(.side-toggle:checked) .skip { visibility: hidden; opacity: 0; transition: opacity .3s, visibility 0s linear .3s; }
          }
          .side-scrim {
            display: block; position: fixed; inset: 0; z-index: 45; margin: 0; cursor: pointer;
            background: rgba(3, 5, 20, .62); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
            opacity: 0; visibility: hidden; transition: opacity .3s, visibility 0s linear .3s;
          }
          .side-toggle:checked ~ .side-scrim { opacity: 1; visibility: visible; transition: opacity .3s; }
          body.with-side:has(.side-toggle:checked) { overflow: hidden; }
        }
        @media (max-width: 600px) {
          .with-side { --head-h: 76px; }
          .page > h1:first-child { padding: 14px 0 20px; margin-bottom: 20px; }
          .page > h1:first-child::after { bottom: 12px; }
          .page > :first-child:not(h1) { margin-top: 20px; }
        }
        /* Short windows (a 1366x768 laptop leaves about 650px): a tighter panel, so "Sign out" stays in view. */
        @media (max-height: 760px) {
          .side-nav { gap: 14px; padding: 14px 12px 16px; }
          .nav-label { margin-bottom: 4px; }
          .side-nav a { min-height: 38px; }
          .side-nav a.active::after { top: 8px; bottom: 8px; }
          .side-foot { gap: 10px; padding: 12px; margin-bottom: 12px; }
        }
        /* Windows contrast themes: the panel is opaque (the drawer never shows the page through it), icons take the
           link colour, the current page is a Highlight pill, and the menu button keeps its night colours so its
           light icon shows on any Canvas. */
        @media (forced-colors: active) {
          .side, .side-head, .bar { background: Canvas; }
          .side-nav a::before { forced-color-adjust: none; background: LinkText; opacity: 1; }
          .side-nav a:hover { text-decoration: underline; }
          .side-nav a.active { forced-color-adjust: none; color: HighlightText; background: Highlight; box-shadow: none; }
          .side-nav a.active::before { background: HighlightText; }
          .side-nav a.active::after { forced-color-adjust: none; background: Highlight; box-shadow: none; }
          .side-nav a.active:focus-visible { outline-color: CanvasText; }
          .with-side input.side-toggle, .with-side input.side-toggle:hover,
          .with-side input.side-toggle:checked, .with-side input.side-toggle:checked:hover {
            forced-color-adjust: none; background-color: #0B1030; border-color: ButtonText;
          }
          .with-side input.side-toggle:focus-visible { outline-color: Highlight; }
        }

        /* ---- Cards and layout --------------------------------------------------- */
        .card {
          position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);
          padding: 20px 22px; margin-bottom: 16px; box-shadow: var(--shadow);
          animation: rx-rise .55s var(--ease) backwards;
        }
        .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr)); margin-bottom: 16px; }
        /* Single-form pages read better at a form's width. */
        main > form.card:not(.actions) { max-width: 760px; }
        main > form.card textarea { max-width: 100%; }
        .actions > div:has(> input[name="q"]) { flex: 1 1 300px; }
        .actions > div > input[name="q"] { max-width: none; }
        main > p:last-child { margin-top: 20px; }
        label.inline:has(> input[type="checkbox"]) { margin-left: 10px; }
        .grid > .card { margin-bottom: 0; }
        .grid > .card:nth-child(2) { animation-delay: .06s; }
        .grid > .card:nth-child(3) { animation-delay: .12s; }
        .grid > .card:nth-child(4) { animation-delay: .18s; }
        .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
        .actions form { margin: 0; }

        /* ---- Stat tiles (dashboard) --------------------------------------------- */
        .tiles { position: relative; display: grid; gap: 16px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0 0 8px; }
        .tile {
          --t: var(--blue); --dot: var(--blue-dot); --edge: var(--grad); --tb: var(--blue-bg); --icon: var(--i-key);
          position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; overflow: hidden;
          padding: 18px 20px 16px; border-radius: var(--r-lg); border: 1px solid var(--line);
          background: var(--edge) top / 100% 3px no-repeat, var(--surface);
          box-shadow: var(--shadow-hi); animation: rx-rise .6s var(--ease) backwards;
          transition: transform .25s var(--ease), box-shadow .25s var(--ease);
        }
        .tile:hover { transform: translateY(-2px); }
        .tile::before, .tile::after { content: ""; position: absolute; top: 16px; right: 16px; width: 38px; height: 38px; border-radius: 11px; }
        .tile::before { background: var(--tb); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dot) 28%, transparent); }
        .tile::after { background: var(--t); -webkit-mask: var(--icon) center / 20px no-repeat; mask: var(--icon) center / 20px no-repeat; }
        .tile-label { font-size: 13px; font-weight: 600; color: var(--text-2); padding-right: 46px; }
        .tile-value {
          font: 750 clamp(30px, 1.4rem + 1.2vw, 38px)/1.05 var(--font-display); letter-spacing: -.03em; font-variant-numeric: tabular-nums;
          margin-top: 6px; color: var(--text);
        }
        .tile-bar { display: flex; gap: 2px; height: 6px; margin-top: 10px; border-radius: 6px; overflow: hidden; background: var(--line); }
        .tile-bar i { flex: 0 1 0; min-width: 0; background: var(--slate-dot); }
        .tile-bar i:not([style*="flex-grow:0"]) { min-width: 4px; }
        .tile-bar i[data-ed="professional"] { background: var(--blue-dot); }
        .tile-bar i[data-ed="business"] { background: var(--violet-dot); }
        .tile-bar i[data-ed="technician"] { background: var(--teal-dot); }
        .tile-bar i[data-ed="enterprise"] { background: var(--amber-dot); }
        .tile-sub { font-size: 12.5px; color: var(--text-3); margin-top: 6px; }
        .tile.active { --t: var(--green); --dot: var(--green-dot); --tb: var(--green-bg); --edge: linear-gradient(90deg, #10B981, #5EEAD4); --icon: var(--i-shield-check); }
        .tile.seats { --t: var(--blue); --dot: var(--blue-dot); --tb: var(--blue-bg); --edge: var(--grad); --icon: var(--i-monitor); animation-delay: .07s; }
        .tile.expired { --t: var(--amber); --dot: var(--amber-dot); --tb: var(--amber-bg); --edge: linear-gradient(90deg, #F59E0B, #FCD34D); --icon: var(--i-hourglass); animation-delay: .14s; }
        .tile.revoked { --t: var(--red); --dot: var(--red-dot); --tb: var(--red-bg); --edge: linear-gradient(90deg, #EF4444, #F472B6); --icon: var(--i-ban); animation-delay: .21s; }
        .tile.active .tile-value { background: linear-gradient(92deg, var(--text) 30%, var(--green) 140%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
        .tile.seats .tile-value { background: linear-gradient(92deg, var(--text) 30%, var(--blue) 140%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }

        /* ---- Tables ------------------------------------------------------------- */
        .scroll {
          overflow: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);
          box-shadow: var(--shadow); margin-bottom: 16px; animation: rx-rise .55s var(--ease) backwards;
          scrollbar-width: thin; scrollbar-color: var(--line-2) transparent;
        }
        .scroll table { border: 0; }
        table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--surface); font-size: 14px; }
        th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
        th {
          position: sticky; top: 0; z-index: 2; background: var(--surface-2); color: var(--text-3);
          font-size: 11.5px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap;
          padding-top: 11px; padding-bottom: 11px;
        }
        tbody tr:last-child > td { border-bottom: 0; }
        tbody tr { animation: rx-row .45s var(--ease) backwards; animation-delay: .38s; }
        tbody tr:nth-child(1) { animation-delay: .04s; } tbody tr:nth-child(2) { animation-delay: .07s; }
        tbody tr:nth-child(3) { animation-delay: .1s; } tbody tr:nth-child(4) { animation-delay: .13s; }
        tbody tr:nth-child(5) { animation-delay: .16s; } tbody tr:nth-child(6) { animation-delay: .19s; }
        tbody tr:nth-child(7) { animation-delay: .22s; } tbody tr:nth-child(8) { animation-delay: .25s; }
        tbody tr:nth-child(9) { animation-delay: .28s; } tbody tr:nth-child(10) { animation-delay: .31s; }
        tbody tr:nth-child(11) { animation-delay: .34s; }
        tbody tr:nth-child(even) > td { background: var(--zebra); }
        tbody tr > td:first-child { box-shadow: inset 3px 0 0 transparent; transition: box-shadow .2s var(--ease); }
        tbody tr { --row: var(--brand-a); }
        tbody tr:hover > td { background: var(--hover); }
        tbody tr:hover > td:first-child { box-shadow: inset 3px 0 0 var(--row); }
        td.key, td.when, td.mono { white-space: nowrap; word-break: normal; }
        td.when { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 13px; }
        td.mono { font-size: 12px; color: var(--text-2); }
        td.muted { font-size: 13px; color: var(--text-3); min-width: 22em; }
        td.key a, td.mono.key a {
          display: inline-block; padding: 3px 9px; border-radius: 8px; text-decoration: none; letter-spacing: .02em;
          color: var(--chip-text); background: var(--chip-bg); border: 1px solid var(--chip-line);
          transition: border-color .2s, background-color .2s, transform .2s var(--ease);
        }
        td.key a:hover { border-color: var(--brand-a); background: var(--hover); }
        /* Tall tables keep their header in view inside the card: only those with a link or
           button in them, so the scrolling region can always be reached from the keyboard. */
        .scroll:has(tbody tr:nth-child(26)):has(a[href], button) { max-height: min(72vh, 680px); }
        /* Numbers: right-aligned, tabular. */
        table.t-editions td:nth-child(n+2):nth-child(-n+5), table.t-editions th:nth-child(n+2):nth-child(-n+5),
        table.t-licences td:nth-child(4), table.t-licences th:nth-child(4) { text-align: right; font-variant-numeric: tabular-nums; }
        table.t-editions td:nth-child(n+2):nth-child(-n+5) { font-weight: 650; font-size: 15px; }
        table.t-editions th:nth-child(n+2):nth-child(-n+4)::before {
          content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin: 0 7px 1px 0; vertical-align: middle;
        }
        table.t-editions th:nth-child(2)::before { background: var(--green-dot); }
        table.t-editions th:nth-child(3)::before { background: var(--amber-dot); }
        table.t-editions th:nth-child(4)::before { background: var(--red-dot); }
        table.t-editions td:last-child { color: var(--text-3); font-size: 13px; }
        table.t-licences td:nth-child(5), table.t-licences td:nth-child(8) { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--text-2); font-size: 13px; }
        table.t-licences td:nth-child(7) { font-family: var(--mono); font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
        table.t-licences td:nth-child(3) { min-width: 13em; font-weight: 550; }
        table.t-licences td:nth-child(3) .muted { font-weight: 400; font-size: 12.5px; color: var(--text-3); }
        table.t-licences tr:has(.badge.revoked) td:nth-child(3) { color: var(--text-3); }
        table.t-licences tr:has(.badge.active) { --row: var(--green-dot); }
        table.t-licences tr:has(.badge.expired) { --row: var(--amber-dot); }
        table.t-licences tr:has(.badge.revoked) { --row: var(--red-dot); }
        table.t-machines td:nth-child(4) { color: var(--text-3); font-size: 13px; white-space: nowrap; }
        table.t-machines td:last-child { text-align: right; }

        /* Activity as a timeline: a rail through the "When" column, a dot per event. */
        tr:has(.ev) > td.when { position: relative; padding-left: 36px; }
        tr:has(.ev) > td.when::before { content: ""; position: absolute; left: 18px; top: 0; bottom: 0; width: 2px; background: var(--line); }
        tbody tr:has(.ev):first-child > td.when::before { top: 50%; }
        tbody tr:has(.ev):last-child > td.when::before { bottom: 50%; }
        tr:has(.ev) > td.when::after {
          content: ""; position: absolute; left: 13px; top: 50%; width: 12px; height: 12px; margin-top: -6px; border-radius: 50%;
          background: var(--row); box-shadow: 0 0 0 3px var(--surface), 0 0 0 4px color-mix(in srgb, var(--row) 35%, transparent);
        }
        tbody tr:has(.ev):nth-child(even) > td.when::after { box-shadow: 0 0 0 3px var(--surface), 0 0 0 4px color-mix(in srgb, var(--row) 35%, transparent); }

        /* ---- Pills: events, editions, states ------------------------------------ */
        .ev, .ed, .badge {
          --t: var(--slate); --tb: var(--slate-bg); --tl: var(--slate-line); --d: var(--slate-dot);
          display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 3px 8px; border-radius: 999px; white-space: nowrap;
          font: 600 12px/1.5 var(--font); color: var(--t); background: var(--tb); border: 1px solid var(--tl);
        }
        .ev::before, .ed::before, .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--d); }
        .ev { font-family: var(--mono); font-size: 11.5px; font-weight: 600; letter-spacing: -.01em; }
        .ev[data-ev="activated"] { --t: var(--green); --tb: var(--green-bg); --tl: var(--green-line); --d: var(--green-dot); }
        .ev[data-ev="reactivated"] { --t: var(--green); --tb: transparent; --tl: var(--green-line); --d: var(--green-dot); }
        .ev[data-ev="offline-issued"] { --t: var(--cyan); --tb: var(--cyan-bg); --tl: var(--cyan-line); --d: var(--cyan-dot); }
        .ev[data-ev="deactivated"], .ev[data-ev="seat-released"] { --t: var(--blue); --tb: var(--blue-bg); --tl: var(--blue-line); --d: var(--blue-dot); }
        .ev[data-ev="seats-reset"] { --t: var(--orange); --tb: var(--orange-bg); --tl: var(--orange-line); --d: var(--orange-dot); }
        .ev[data-ev$="-refused"] { --t: var(--amber); --tb: var(--amber-bg); --tl: var(--amber-line); --d: var(--amber-dot); }
        .ev[data-ev="revoked"] { --t: var(--red); --tb: var(--red-bg); --tl: var(--red-line); --d: var(--red-dot); }
        .ev[data-ev="restored"] { --t: var(--teal); --tb: var(--teal-bg); --tl: var(--teal-line); --d: var(--teal-dot); }
        .ev[data-ev="license-created"] { --t: var(--violet); --tb: var(--violet-bg); --tl: var(--violet-line); --d: var(--violet-dot); }
        .ev[data-ev="extended"] { --t: var(--indigo); --tb: var(--indigo-bg); --tl: var(--indigo-line); --d: var(--indigo-dot); }
        tr:has(.ev[data-ev="activated"]), tr:has(.ev[data-ev="reactivated"]) { --row: var(--green-dot); }
        tr:has(.ev[data-ev="offline-issued"]) { --row: var(--cyan-dot); }
        tr:has(.ev[data-ev="deactivated"]), tr:has(.ev[data-ev="seat-released"]) { --row: var(--blue-dot); }
        tr:has(.ev[data-ev="seats-reset"]) { --row: var(--orange-dot); }
        tr:has(.ev[data-ev$="-refused"]) { --row: var(--amber-dot); }
        tr:has(.ev[data-ev="revoked"]) { --row: var(--red-dot); }
        tr:has(.ev[data-ev="restored"]) { --row: var(--teal-dot); }
        tr:has(.ev[data-ev="license-created"]) { --row: var(--violet-dot); }
        tr:has(.ev[data-ev="extended"]) { --row: var(--indigo-dot); }
        tr:has(.ev[data-ev="deactivation-noop"]) { --row: var(--slate-dot); }

        .ed { border-radius: 8px; padding: 2px 9px 3px 7px; }
        .ed::before { width: 8px; height: 8px; border-radius: 3px; }
        .ed[data-ed="professional"] { --t: var(--blue); --tb: var(--blue-bg); --tl: var(--blue-line); --d: var(--blue-dot); }
        .ed[data-ed="business"] { --t: var(--violet); --tb: var(--violet-bg); --tl: var(--violet-line); --d: var(--violet-dot); }
        .ed[data-ed="technician"] { --t: var(--teal); --tb: var(--teal-bg); --tl: var(--teal-line); --d: var(--teal-dot); }
        .ed[data-ed="enterprise"] { --t: var(--amber); --tb: var(--amber-bg); --tl: var(--amber-line); --d: var(--amber-dot); }

        .badge { text-transform: capitalize; }
        .badge.active { --t: var(--green); --tb: var(--green-bg); --tl: var(--green-line); --d: var(--green-dot); }
        .badge.active::before { animation: rx-pulse 2.4s ease-out infinite; }
        .badge.expired { --t: var(--amber); --tb: var(--amber-bg); --tl: var(--amber-line); --d: var(--amber-dot); }
        .badge.revoked { --t: var(--red); --tb: var(--red-bg); --tl: var(--red-line); --d: var(--red-dot); }
        .badge.unused { --t: var(--slate); --tb: var(--slate-bg); --tl: var(--slate-line); --d: var(--slate-dot); }

        /* ---- Buttons ------------------------------------------------------------ */
        button {
          --icon: none; position: relative; isolation: isolate; overflow: hidden;
          display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 0 18px;
          font: 600 14.5px/1 var(--font); white-space: nowrap; color: #FFFFFF; cursor: pointer;
          border: 1px solid transparent; border-radius: 11px; background: var(--grad);
          box-shadow: 0 8px 22px -10px rgba(98, 92, 236, .75), inset 0 1px 0 rgba(255, 255, 255, .22);
          transition: transform .2s var(--ease), box-shadow .2s var(--ease), background-color .2s, border-color .2s, color .2s, filter .2s;
        }
        button::before {
          content: ""; display: var(--icon-on, none); width: 16px; height: 16px; flex: none; background: currentColor;
          -webkit-mask: var(--icon) center / contain no-repeat; mask: var(--icon) center / contain no-repeat;
        }
        button::after {
          content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
          background: linear-gradient(110deg, transparent 25%, rgba(255, 255, 255, .32) 50%, transparent 75%);
          transform: translateX(-110%); transition: transform .7s var(--ease);
        }
        button:hover { transform: translateY(-1px); box-shadow: 0 14px 30px -12px rgba(98, 92, 236, .95), inset 0 1px 0 rgba(255, 255, 255, .3); filter: saturate(1.08); }
        button:hover::after { transform: translateX(110%); }
        button:active { transform: translateY(0) scale(.98); box-shadow: 0 4px 12px -6px rgba(98, 92, 236, .8), inset 0 2px 4px rgba(0, 0, 0, .18); transition-duration: .08s; }
        button:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
        button.secondary, button.ghost {
          color: var(--text); background: var(--surface); border-color: var(--line-2);
          box-shadow: 0 1px 2px rgba(10, 16, 48, .06);
        }
        button.secondary::after, button.ghost::after { display: none; }
        button.secondary:hover, button.ghost:hover { border-color: var(--brand-a); color: var(--link); background: var(--hover); box-shadow: 0 6px 16px -10px rgba(59, 111, 224, .5); filter: none; }
        button.secondary:active, button.ghost:active { box-shadow: inset 0 1px 3px rgba(10, 16, 48, .12); }
        button.ghost { background: transparent; border-color: transparent; box-shadow: none; }
        button.outline { color: var(--link); background: transparent; border-color: var(--brand-a); box-shadow: none; }
        button.danger {
          background: linear-gradient(135deg, #E5484D, #B4232A); color: #FFFFFF;
          box-shadow: 0 8px 22px -10px rgba(220, 38, 38, .7), inset 0 1px 0 rgba(255, 255, 255, .2);
        }
        button.danger:hover { box-shadow: 0 0 0 4px rgba(239, 68, 68, .16), 0 14px 30px -12px rgba(220, 38, 38, .9), inset 0 1px 0 rgba(255, 255, 255, .26); }
        button.danger:active { box-shadow: 0 4px 12px -6px rgba(220, 38, 38, .8), inset 0 2px 4px rgba(0, 0, 0, .2); }
        /* Icons, chosen by what the form does. */
        form:has(input[name="action"]) button[type="submit"], form[method="get"] button[type="submit"], button[data-copy] { --icon-on: inline-block; }
        form:has(input[name="action"][value="login"]) button { --icon: var(--i-login); }
        form:has(input[name="action"][value="create"]) button { --icon: var(--i-plus); }
        form:has(input[name="action"][value="revoke"]) button { --icon: var(--i-ban); }
        form:has(input[name="action"][value="restore"]) button { --icon: var(--i-restore); }
        form:has(input[name="action"][value="extend"]) button { --icon: var(--i-calendar); }
        form:has(input[name="action"][value="offline"]) button { --icon: var(--i-wifi-off); }
        form:has(input[name="action"][value="reset"]) button { --icon: var(--i-refresh); }
        form:has(input[name="action"][value="release"]) button { --icon: var(--i-unplug); }
        form:has(input[name="action"][value="details"]) button { --icon: var(--i-save); }
        form:has(input[name="action"][value="erase"]) button { --icon: var(--i-eraser); }
        form:has(input[name="action"][value="api-generate"]) button { --icon: var(--i-key); }
        form:has(input[name="action"][value="api-disable"]) button { --icon: var(--i-power); }
        form:has(input[name="action"][value^="backup"]) button, form:has(input[name="action"][value="download-key"]) button { --icon: var(--i-download); }
        form:has(input[name="action"][value="prune-events"]) button { --icon: var(--i-trash); }
        form:has(input[name="action"][value="password"]) button { --icon: var(--i-lock); }
        form:has(input[name="action"][value="logout"]) button { --icon: var(--i-logout); }
        form:has(input[name="code"]) button[type="submit"] { --icon-on: inline-block; --icon: var(--i-check); }
        form[method="get"] button[type="submit"] { --icon: var(--i-search); }
        button[data-copy] { --icon: var(--i-copy); }
        /* Links that act as buttons: the pager and "Create more". */
        p.actions a, main > p:last-child > a[href="?page=create"] {
          display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 16px; border-radius: 11px;
          font-weight: 600; font-size: 14px; text-decoration: none; color: var(--text); background: var(--surface);
          border: 1px solid var(--line-2); box-shadow: 0 1px 2px rgba(10, 16, 48, .06);
          transition: border-color .2s, color .2s, transform .2s var(--ease), background-color .2s;
        }
        p.actions a:hover, main > p:last-child > a[href="?page=create"]:hover { border-color: var(--brand-a); color: var(--link); background: var(--hover); transform: translateY(-1px); }
        main > p:last-child > a[href="?page=create"]::before {
          content: ""; width: 16px; height: 16px; background: currentColor;
          -webkit-mask: var(--i-plus) center / contain no-repeat; mask: var(--i-plus) center / contain no-repeat;
        }

        /* ---- Forms -------------------------------------------------------------- */
        label { display: block; font-weight: 600; font-size: 14px; color: var(--text); margin: 16px 0 6px; }
        form > label:first-of-type, .card > label:first-child, .actions > div > label { margin-top: 0; }
        input, select, textarea {
          font: inherit; font-size: 14.5px; color: var(--text); background: var(--input); width: 100%; max-width: 480px;
          border: 1px solid var(--line-2); border-radius: 10px; padding: 9px 12px; min-height: 42px;
          box-shadow: inset 0 1px 2px rgba(10, 16, 48, .04);
          transition: border-color .2s, box-shadow .2s, background-color .2s;
        }
        input::placeholder, textarea::placeholder { color: var(--text-3); opacity: .85; }
        input:hover, select:hover, textarea:hover { border-color: color-mix(in srgb, var(--brand-a) 45%, var(--line-2)); }
        input:focus, select:focus, textarea:focus { outline: none; border-color: var(--brand-a); box-shadow: var(--ring), inset 0 1px 2px rgba(10, 16, 48, .04); }
        input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; }
        input[readonly] { background: var(--surface-2); }
        select {
          -webkit-appearance: none; appearance: none; padding-right: 38px; cursor: pointer;
          background: var(--img-chevron) right 12px center / 16px no-repeat, var(--input);
        }
        input[type="date"] { min-height: 42px; }
        textarea { max-width: 100%; min-height: 84px; line-height: 1.5; resize: vertical; }
        input.mono, textarea.mono { font-family: var(--mono); font-size: 13px; }
        input[name="q"] { padding-left: 38px; background: var(--img-search) 12px center / 17px no-repeat, var(--input); }
        input[type="radio"], input[type="checkbox"] { width: auto; min-height: 0; box-shadow: none; padding: 0; accent-color: var(--brand-a); }
        input[type="radio"] { width: 16px; height: 16px; margin: 0; flex: none; }
        /* Checkbox as a switch (still a checkbox to assistive technology). */
        input[type="checkbox"] {
          -webkit-appearance: none; appearance: none; width: 38px; height: 22px; flex: none; margin: 0; border-radius: 999px; cursor: pointer;
          border: 1px solid var(--line-2); background: radial-gradient(circle, #FFFFFF 0 7.5px, transparent 8.5px) 0 50% / 20px 20px no-repeat, var(--line-2);
          transition: background-position .25s var(--ease), background-color .2s, border-color .2s;
        }
        input[type="checkbox"]:checked { border-color: transparent; background: radial-gradient(circle, #FFFFFF 0 7.5px, transparent 8.5px) 100% 50% / 20px 20px no-repeat, var(--grad); }
        input[type="checkbox"]:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
        /* Inline options: a radio becomes a segmented choice. */
        label.inline {
          display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; font-weight: 500; font-size: 14px; color: var(--text);
          margin: 4px 8px 4px 0; padding: 7px 12px; border-radius: 11px; border: 1px solid var(--line-2); background: var(--surface);
          cursor: pointer; transition: border-color .2s, background-color .2s, box-shadow .2s;
        }
        label.inline:hover { border-color: color-mix(in srgb, var(--brand-a) 50%, var(--line-2)); }
        label.inline:has(input[type="radio"]:checked) {
          border-color: var(--brand-a); background: var(--hover); box-shadow: 0 0 0 3px rgba(59, 111, 224, .12);
        }
        label.inline:has(input[type="checkbox"]) { border-color: transparent; background: transparent; padding-left: 0; }
        label.inline input:not([type="radio"]):not([type="checkbox"]) { min-height: 32px; padding: 4px 8px; font-size: 14px; }
        label.inline input[type="date"] { min-height: 32px; }
        label.inline + br { display: none; }
        label:not(.inline):not([for]) { font-size: 14px; }

        /* Copy fields: the value as a chip, the button beside it. */
        .copy { display: flex; gap: 8px; align-items: stretch; }
        .copy input, .copy textarea {
          max-width: none; font-family: var(--mono); font-size: 13px; letter-spacing: .02em;
          color: var(--chip-text); background: var(--chip-bg); border-color: var(--chip-line); box-shadow: none;
        }
        .copy input { min-height: 40px; }
        .copy button { flex: none; align-self: flex-start; min-height: 40px; }
        .copy textarea { min-height: 96px; }

        /* Card titles in the licence actions: the first label, with an icon. */
        .grid > .card > form:only-child:not(:has(> input[value="details"])) > label:first-of-type {
          --t: var(--blue); --tb: var(--blue-bg); --icon: var(--i-key);
          position: relative; display: flex; align-items: center; min-height: 34px; padding-left: 46px; margin: 0 0 14px;
          font: 650 15.5px/1.3 var(--font-display); letter-spacing: -.005em;
        }
        .grid > .card > form:only-child:not(:has(> input[value="details"])) > label:first-of-type::before,
        .grid > .card > form:only-child:not(:has(> input[value="details"])) > label:first-of-type::after {
          content: ""; position: absolute; left: 0; top: 50%; width: 34px; height: 34px; margin-top: -17px; border-radius: 10px;
        }
        .grid > .card > form:only-child:not(:has(> input[value="details"])) > label:first-of-type::before {
          background: var(--tb); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--t) 22%, transparent);
        }
        .grid > .card > form:only-child:not(:has(> input[value="details"])) > label:first-of-type::after {
          background: var(--t); -webkit-mask: var(--icon) center / 18px no-repeat; mask: var(--icon) center / 18px no-repeat;
        }
        .grid > .card > form:only-child:has(input[value="revoke"]) > label:first-of-type { --t: var(--red); --tb: var(--red-bg); --icon: var(--i-ban); }
        .grid > .card > form:only-child:has(input[value="erase"]) > label:first-of-type { --t: var(--red); --tb: var(--red-bg); --icon: var(--i-eraser); }
        .grid > .card > form:only-child:has(input[value="extend"]) > label:first-of-type { --t: var(--indigo); --tb: var(--indigo-bg); --icon: var(--i-calendar); }
        .grid > .card > form:only-child:has(input[value="offline"]) > label:first-of-type { --t: var(--cyan); --tb: var(--cyan-bg); --icon: var(--i-wifi-off); }
        .grid > .card > form:only-child:has(input[value="reset"]) > label:first-of-type { --t: var(--orange); --tb: var(--orange-bg); --icon: var(--i-refresh); }
        /* Action cards: buttons line up along the bottom of each row. */
        .grid > .card:has(> form:only-child) { display: flex; flex-direction: column; }
        .grid > .card > form:only-child { flex: 1; display: flex; flex-direction: column; align-items: stretch; }
        .grid > .card > form:only-child > button { align-self: flex-start; }
        .grid > .card > form:only-child > label.inline { align-self: flex-start; }
        .grid > .card > form:only-child > .hint { margin-bottom: 16px; }
        .grid > .card > form:only-child > p:empty { height: 16px; flex: none; }
        /* Danger zone: a card holding a destructive button gets a red edge. */
        .card:has(button.danger) { border-color: color-mix(in srgb, var(--red-dot) 30%, var(--line)); }
        .card:has(button.danger)::before {
          content: ""; position: absolute; inset: -1px -1px auto; height: 3px; border-radius: var(--r-lg) var(--r-lg) 0 0;
          background: linear-gradient(90deg, #EF4444, #F472B6);
        }
        .card:has(input[name="action"][value="restore"])::before {
          content: ""; position: absolute; inset: -1px -1px auto; height: 3px; border-radius: var(--r-lg) var(--r-lg) 0 0;
          background: linear-gradient(90deg, #10B981, #5EEAD4);
        }

        /* The licence actions: "end date" (the tall card) spans two rows; "free every computer" runs full width. */
        @media (min-width: 900px) {
          .grid > .card:has(input[name="action"][value="extend"]) { grid-row: span 2; }
          .grid > .card:has(input[name="action"][value="reset"]) { grid-column: 1 / -1; }
          .grid > .card > form:has(input[name="action"][value="reset"]) { flex-direction: row; align-items: center; gap: 16px; }
          .grid > .card > form:has(input[name="action"][value="reset"]) > label:first-of-type { margin: 0 auto 0 0; }
        }

        /* ---- Facts -------------------------------------------------------------- */
        dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0 24px; margin: 0; }
        dl.facts dt, dl.facts dd { padding: 9px 0; border-bottom: 1px solid var(--line); }
        dl.facts dt { color: var(--text-3); font-size: 13px; font-weight: 600; padding-top: 11px; }
        dl.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
        dl.facts dt:last-of-type, dl.facts dd:last-of-type { border-bottom: 0; }
        dl.facts dd .copy { max-width: 560px; }
        dl.facts dd code { font-size: 12px; }
        /* A page's own facts card (the licence) uses two columns of pairs on wide screens. */
        @media (min-width: 1100px) {
          main.wrap > .card > dl.facts { grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr); column-gap: 28px; }
          main.wrap > .card > dl.facts dd:nth-of-type(odd) { padding-right: 8px; }
        }
        main > .card:has(> dl.facts .copy) {
          background: radial-gradient(70% 140% at 100% 0%, color-mix(in srgb, var(--brand-b) 7%, transparent), transparent 60%), var(--surface);
        }
        main > .card:has(> dl.facts .copy)::before {
          content: ""; position: absolute; inset: -1px -1px auto; height: 3px; border-radius: var(--r-lg) var(--r-lg) 0 0; background: var(--grad);
        }

        main > .card:has(> dl.facts .badge.expired)::before { background: linear-gradient(90deg, #F59E0B, #FCD34D); }
        main > .card:has(> dl.facts .badge.revoked)::before { background: linear-gradient(90deg, #EF4444, #F472B6); }

        /* ---- Notices ------------------------------------------------------------ */
        .notice {
          --t: var(--blue); --tb: var(--blue-bg); --tl: var(--blue-line); --d: var(--blue-dot); --icon: var(--i-info);
          position: relative; margin-bottom: 18px; padding: 14px 18px 14px 54px; border-radius: var(--r);
          color: var(--text); background: linear-gradient(90deg, var(--tb), var(--surface) 140%); border: 1px solid var(--tl);
          box-shadow: inset 4px 0 0 var(--d), var(--shadow); animation: rx-toast .55s .15s var(--ease) backwards;
        }
        .notice::before {
          content: ""; position: absolute; left: 16px; top: 13px; width: 24px; height: 24px; background: var(--t);
          -webkit-mask: var(--icon) center / contain no-repeat; mask: var(--icon) center / contain no-repeat;
          animation: rx-pop .5s .45s var(--ease) backwards;
        }
        .notice.ok { --t: var(--green); --tb: var(--green-bg); --tl: var(--green-line); --d: var(--green-dot); --icon: var(--i-check-circle); }
        .notice.error { --t: var(--red); --tb: var(--red-bg); --tl: var(--red-line); --d: var(--red-dot); --icon: var(--i-alert-circle); }
        .notice.warn { --t: var(--amber); --tb: var(--amber-bg); --tl: var(--amber-line); --d: var(--amber-dot); --icon: var(--i-alert); }
        .notice p { margin: 0 0 10px; } .notice p:last-child { margin: 0; }
        .notice .copy { margin: 10px 0; }
        .notice a[download] {
          display: inline-flex; align-items: center; gap: 6px; font-weight: 600;
        }
        .notice a[download]::before {
          content: ""; width: 16px; height: 16px; background: currentColor;
          -webkit-mask: var(--i-download) center / contain no-repeat; mask: var(--i-download) center / contain no-repeat;
        }

        /* ---- Setup checks ------------------------------------------------------- */
        ul.checks { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
        ul.checks li { position: relative; margin: 0; padding: 8px 12px 8px 42px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); }
        .check::before {
          position: absolute; left: 10px; top: 8px; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
          font-size: 12px; font-weight: 700; line-height: 1;
        }
        .check.pass::before { content: "✔"; color: var(--green); background: var(--green-bg); }
        .check.fail::before { content: "✖"; color: var(--red); background: var(--red-bg); }
        .check.warn::before { content: "!"; color: var(--amber); background: var(--amber-bg); }
        .check.fail { border-color: var(--red-line); }
        .check.warn { border-color: var(--amber-line); }

        /* ---- Sign-in: full-bleed night, glass card ------------------------------- */
        body:has(.login) {
          color-scheme: dark; color: var(--on-night); background:
            radial-gradient(50% 45% at 50% 42%, rgba(91, 110, 240, .28), transparent 70%),
            radial-gradient(45% 40% at 88% 6%, rgba(124, 77, 232, .32), transparent 70%),
            radial-gradient(40% 40% at 10% 12%, rgba(59, 111, 224, .26), transparent 70%),
            linear-gradient(180deg, #060A22 0%, #0A0F33 55%, #0B0B2E 100%);
          background-attachment: fixed;
        }
        body:has(.login)::before {
          content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
          background-image: linear-gradient(rgba(160, 180, 255, .06) 1px, transparent 1px), linear-gradient(90deg, rgba(160, 180, 255, .06) 1px, transparent 1px);
          background-size: 56px 56px; background-position: center center;
          -webkit-mask-image: radial-gradient(ellipse 60% 55% at 50% 45%, #000 20%, transparent 75%); mask-image: radial-gradient(ellipse 60% 55% at 50% 45%, #000 20%, transparent 75%);
        }
        body:has(.login) header.top { background: transparent; border-bottom-color: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; }
        body:has(.login) header.top::before { display: none; }
        body:has(.login) main.wrap { min-height: calc(100vh - 65px); display: grid; place-items: center; padding-block: 24px 72px; }
        .card.login {
          width: 100%; max-width: 420px; margin: 0; padding: 32px 30px 26px; color: var(--on-night); border-radius: 22px;
          background: linear-gradient(180deg, rgba(255, 255, 255, .085), rgba(255, 255, 255, .03));
          border: 1px solid rgba(168, 186, 255, .2);
          -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%);
          box-shadow: 0 1px 0 rgba(255, 255, 255, .08) inset, 0 40px 90px -30px rgba(0, 0, 0, .85), 0 0 0 1px rgba(0, 0, 0, .2);
          animation: rx-rise .7s var(--ease) backwards;
        }
        .card.login::before {
          content: ""; display: block; width: 58px; height: 58px; margin: 0 auto 18px; border-radius: 16px;
          background: var(--img-logo) center / contain no-repeat;
          box-shadow: 0 14px 40px -8px rgba(124, 77, 232, .85), 0 0 0 1px rgba(255, 255, 255, .1);
          animation: rx-pop .7s .15s var(--ease) backwards;
        }
        .card.login h1 {
          text-align: center; font-size: 26px; margin: 0 0 22px;
          background: linear-gradient(92deg, #FFFFFF 20%, #C9D6FF 60%, #B9A0FF 100%); -webkit-background-clip: text; background-clip: text;
          color: transparent; -webkit-text-fill-color: transparent;
        }
        .card.login label { color: var(--on-night); }
        .card.login input:not([type="hidden"]) {
          max-width: none; color: #FFFFFF; background: rgba(4, 7, 26, .55); border-color: rgba(168, 186, 255, .22); min-height: 46px;
        }
        .card.login input:focus { border-color: #86A9FF; box-shadow: 0 0 0 4px rgba(134, 169, 255, .22); }
        .card.login button { width: 100%; min-height: 46px; font-size: 15px; margin-top: 4px; }
        .card.login .hint { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--night-line); color: var(--on-night-3); font-size: 12.5px; }
        .card.login a { color: #9AB6FF; }
        .card.login code { color: #D2DCFF; background: rgba(134, 169, 255, .1); border-color: rgba(134, 169, 255, .22); }
        .card.login :focus-visible { outline-color: #A6BEFF; }
        .card.login .notice {
          color: var(--on-night); background: rgba(248, 113, 113, .1); border-color: rgba(248, 113, 113, .3); box-shadow: inset 4px 0 0 #F87171;
          --t: #FCA5A5;
        }
        .card.login .notice.info { background: rgba(96, 165, 250, .1); border-color: rgba(96, 165, 250, .3); box-shadow: inset 4px 0 0 #60A5FA; --t: #93C5FD; }

        /* ---- Small screens ------------------------------------------------------ */
        @media (max-width: 1040px) {
          header.top .wrap { flex-wrap: wrap; min-height: 0; padding-top: 10px; gap: 4px 12px; }
          header.top .brand { min-height: 40px; }
        }
        @media (max-width: 600px) {
          body { font-size: 14.5px; }
          main.wrap > h1:first-child { padding: 26px 0 32px; margin-bottom: 20px; }
          main.wrap > h1:first-child::after { bottom: 18px; }
          .tiles { gap: 10px; }
          .tile { padding: 14px 14px 12px; }
          .tile::before, .tile::after { top: 12px; right: 12px; width: 30px; height: 30px; border-radius: 9px; }
          .tile::after { -webkit-mask-size: 16px; mask-size: 16px; }
          .tile-label { font-size: 12px; line-height: 1.45; padding-right: 34px; min-height: 2.9em; }
          .tile-sub { font-size: 11.5px; }
          .card { padding: 16px; border-radius: 16px; }
          .scroll { border-radius: 16px; }
          dl.facts { grid-template-columns: 1fr; }
          dl.facts dt { border-bottom: 0; padding-bottom: 0; }
          dl.facts dd { padding-top: 2px; }
          .copy:has(textarea) { flex-wrap: wrap; }
          td.muted { white-space: nowrap; min-width: 0; }
          label.inline:has(> input[type="checkbox"]) { margin-left: 0; }
          .copy button { width: auto; }
          .actions > div, .actions > div > input, .actions > div > select { width: 100%; max-width: none; }
          .card.login { padding: 26px 20px 20px; }
          h2 { margin-top: 30px; }
        }

        /* ---- Motion ------------------------------------------------------------- */
        @keyframes rx-rise { from { opacity: 0; transform: translateY(10px); } }
        @keyframes rx-row { from { opacity: 0; transform: translateY(4px); } }
        @keyframes rx-grow { from { transform: scaleX(0); } }
        @keyframes rx-grow-y { from { transform: scaleY(0); opacity: 0; } }
        @keyframes rx-pill { from { background-size: 0% 100%; } }
        @keyframes rx-pop { from { opacity: 0; transform: scale(.6); } }
        @keyframes rx-toast { from { opacity: 0; transform: translateY(-10px) scale(.985); } }
        @keyframes rx-sheen { from { background-position: -300px 0, 0 0; } to { background-position: 900px 0, 0 0; } }
        @keyframes rx-pulse {
          0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--d) 60%, transparent); }
          70% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--d) 0%, transparent); }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
        }
        CSS;
}

<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

/**
 * The HTML half of RecoverX's e-mails: a small builder of markup that e-mail
 * clients show alike — Gmail (web and the Android and iOS apps), Apple Mail,
 * Outlook — in the brand's colours (website/assets/site.css).
 *
 * E-mail clients are not browsers, so the markup keeps to what they all read:
 *  - tables for layout, 600px wide at most, and every style inline. The two
 *    <style> blocks only add extras — a phone tweak, dark mode — that a client
 *    may drop without anything breaking;
 *  - no images and nothing remote: the wordmark is live text, so nothing is
 *    blocked by default, nothing tracks, and nothing has to load;
 *  - coloured areas carry a solid `bgcolor` under their gradient, so Outlook
 *    (which ignores gradients) still shows the brand blue;
 *  - buttons are links in a coloured table cell: at least 44px tall, and still
 *    a readable link with the CSS stripped.
 *
 * Safety: every value is escaped here (`e()`, `multiline()`); a parameter
 * named `…Html` is markup made by this class or already escaped. Links are
 * built only from checked pieces — `mailto()` of an address SesMailer accepts,
 * `tel()`/`whatsapp()` of "+" and digits, `siteUrl()` of an https:// address
 * — and are escaped as well.
 *
 * The plain-text part sent alongside stays complete; this is a nicer view of
 * the same message, never the only copy of anything in it.
 */
final class EmailHtml
{
    public const COMPANY = 'Appsgain Technologies';
    public const SUPPORT_EMAIL = 'info@appsgain.in';
    public const HOME_URL = 'https://recoverx.snapkio.com';
    public const HOME_LABEL = 'recoverx.snapkio.com';

    /** The brand gradient's two ends. */
    public const BRAND_A = '#3b6fe0';
    public const BRAND_B = '#7c4de8';

    private const INK = '#0a1030';
    private const MUTED = '#475172';
    private const FAINT = '#5a6382';
    private const SOFT = '#f4f6fc';
    private const LINE = '#e4e8f4';
    private const ACCENT = '#6a3fd6'; // brand violet, dark enough for small text on white

    private const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
    private const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

    private const GRADIENT = 'background-color:#3b6fe0;background-image:linear-gradient(135deg,#3b6fe0 0%,#7c4de8 100%);';

    /** Text colours by name, and the class dark mode recolours them by. */
    private const TONE_TEXT = [
        'ink' => [self::INK, 'rx-ink'],
        'muted' => [self::MUTED, 'rx-muted'],
        'brand' => ['#2450c0', 'rx-link'],
        'violet' => [self::ACCENT, 'rx-accent'],
    ];

    /** Pills, callouts and small buttons: background and text, each pair WCAG AA. */
    private const TONES = [
        'brand' => ['#eaf0fd', '#2450c0'],
        'violet' => ['#f1ecfd', '#5b34c4'],
        'green' => ['#e5f6ec', '#0b6b37'],
        'amber' => ['#fff3d9', '#7a4800'],
        'grey' => ['#eef0f5', '#3d4663'],
    ];

    /** The phone tweak: Gmail's apps, Apple Mail and others read it; a client that does not keeps the desktop layout. */
    private const MOBILE_CSS = '@media only screen and (max-width:600px){'
        . '.rx-outer{padding:16px 8px !important}'
        . '.rx-pad{padding-left:18px !important;padding-right:18px !important}'
        . '.rx-boxpad{padding:16px 14px !important}'
        . '.rx-label{width:82px !important}'
        . '.rx-h1{font-size:24px !important;line-height:30px !important}'
        . '.rx-big{font-size:21px !important;line-height:27px !important}'
        . '.rx-key{font-size:14px !important;line-height:24px !important;letter-spacing:0 !important;padding:12px 4px !important}'
        . '.rx-full{width:100% !important}'
        . '.rx-wide{display:block !important}'
        . '}';

    /**
     * Dark mode for the clients that honour it (Apple Mail, Outlook for Mac
     * and others); kept in its own <style> so a client that rejects it keeps
     * the phone tweak above.
     */
    private const DARK_CSS = '@media (prefers-color-scheme: dark){'
        . '.rx-body{background-color:#070c24 !important}'
        . '.rx-card{background-color:#0c1333 !important;border-color:#1f2a5c !important}'
        . '.rx-soft{background-color:#141c46 !important;border-color:#25306a !important}'
        . '.rx-quote{background-color:#141c46 !important;color:#f3f5ff !important}'
        . '.rx-line{border-color:#25306a !important}'
        . '.rx-ink{color:#f3f5ff !important}'
        . '.rx-muted{color:#b7c1e2 !important}'
        . '.rx-link{color:#9db8ff !important}'
        . '.rx-accent{color:#c3adff !important}'
        . '.rx-foot{color:#929dc4 !important}'
        . '.rx-key{background-color:#04071a !important;color:#ffffff !important;border-color:#86a9ff !important}'
        . '}'
        . 'a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important}';

    /** Escape one value for HTML text or a quoted attribute. */
    public static function e(string|int|float|null $value): string
    {
        return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }

    /** Escape text that may span lines, keeping its line breaks. */
    public static function multiline(string $text): string
    {
        return nl2br(self::e(str_replace(["\r\n", "\r"], "\n", $text)), false);
    }

    /**
     * A whole message: the header band (wordmark, heading, badge), the white
     * card holding `$bodyHtml`, and the footer.
     *
     * @param string $title the document title (text)
     * @param string $preheader the line inbox lists show after the subject (text)
     * @param string $eyebrow a small label at the top right of the band (text)
     * @param string $heading the band's heading (text)
     * @param string $subheading the line under it (text; '' for none)
     * @param string $badgeHtml under that, e.g. reference() or pill() ('' for none)
     * @param string $bodyHtml the card's content, built from this class's blocks
     * @param string $footnote a small line under the footer (text; '' for none)
     */
    public static function document(
        string $title,
        string $preheader,
        string $eyebrow,
        string $heading,
        string $subheading,
        string $badgeHtml,
        string $bodyHtml,
        string $footnote = '',
    ): string {
        $font = 'font-family:' . self::FONT . ';';
        $support = self::mailto(self::SUPPORT_EMAIL) ?? '';

        $band = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
            . '<td valign="middle" style="' . $font . 'font-size:22px;line-height:26px;font-weight:800;letter-spacing:-0.4px;color:#ffffff;">RecoverX</td>'
            . '<td align="right" valign="middle" style="' . $font . 'font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#ffffff;">'
            . self::e($eyebrow) . '</td>'
            . '</tr></table>'
            . '<h1 class="rx-h1" style="margin:26px 0 0;' . $font . 'font-size:28px;line-height:34px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;">'
            . self::e($heading) . '</h1>'
            . ($subheading === '' ? '' : '<p style="margin:8px 0 0;' . $font . 'font-size:15px;line-height:22px;color:#f1f3ff;">' . self::e($subheading) . '</p>')
            . ($badgeHtml === '' ? '' : '<div style="margin:18px 0 0;">' . $badgeHtml . '</div>');

        $footer = '<p class="rx-foot" style="margin:0;' . $font . 'font-size:12px;line-height:19px;color:' . self::FAINT . ';">'
            . '<strong class="rx-ink" style="color:' . self::INK . ';">RecoverX</strong> by ' . self::e(self::COMPANY)
            . ' &nbsp;&middot;&nbsp; <a href="' . self::e(self::HOME_URL) . '" class="rx-foot" style="color:' . self::FAINT . ';text-decoration:underline;">' . self::e(self::HOME_LABEL) . '</a>'
            . ' &nbsp;&middot;&nbsp; <a href="' . self::e($support) . '" class="rx-foot" style="color:' . self::FAINT . ';text-decoration:underline;">' . self::e(self::SUPPORT_EMAIL) . '</a>'
            . '</p>'
            . ($footnote === '' ? '' : '<p class="rx-foot" style="margin:8px 0 0;' . $font . 'font-size:12px;line-height:18px;color:' . self::FAINT . ';">' . self::e($footnote) . '</p>');

        return '<!DOCTYPE html>' . "\n"
            . '<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">' . "\n"
            . '<head>' . "\n"
            . '<meta charset="utf-8">' . "\n"
            . '<meta name="viewport" content="width=device-width, initial-scale=1">' . "\n"
            . '<meta http-equiv="X-UA-Compatible" content="IE=edge">' . "\n"
            . '<meta name="x-apple-disable-message-reformatting">' . "\n"
            . '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">' . "\n"
            . '<meta name="color-scheme" content="light dark">' . "\n"
            . '<meta name="supported-color-schemes" content="light dark">' . "\n"
            . '<title>' . self::e($title) . '</title>' . "\n"
            . '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>'
            . '<style>table,td,p,a,h1,span,strong{font-family:\'Segoe UI\',Arial,sans-serif !important;}</style><![endif]-->' . "\n"
            . '<style>' . self::MOBILE_CSS . '</style>' . "\n"
            . '<style>' . self::DARK_CSS . '</style>' . "\n"
            . '</head>' . "\n"
            . '<body class="rx-body" style="margin:0;padding:0;width:100%;background-color:' . self::SOFT . ';-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">' . "\n"
            . '<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">'
            . self::e($preheader) . str_repeat('&#847;&zwnj;&nbsp;', 60) . '</div>' . "\n"
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' . self::SOFT . '" class="rx-body" style="background-color:' . self::SOFT . ';">'
            . '<tr><td align="center" class="rx-outer" style="padding:32px 16px;">' . "\n"
            . '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->' . "\n"
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">' . "\n"
            . '<tr><td bgcolor="' . self::BRAND_A . '" class="rx-pad" style="' . self::GRADIENT . 'border-radius:18px 18px 0 0;padding:26px 32px 30px;">'
            . $band . '</td></tr>' . "\n"
            . '<tr><td bgcolor="#ffffff" class="rx-card rx-pad" style="background-color:#ffffff;border:1px solid ' . self::LINE . ';border-top:0;border-radius:0 0 18px 18px;padding:30px 32px 32px;">' . "\n"
            . $bodyHtml . "\n"
            . '</td></tr>' . "\n"
            . '<tr><td align="center" style="padding:22px 20px 8px;">' . $footer . '</td></tr>' . "\n"
            . '</table>' . "\n"
            . '<!--[if mso]></td></tr></table><![endif]-->' . "\n"
            . '</td></tr></table>' . "\n"
            . '</body>' . "\n"
            . '</html>' . "\n";
    }

    /**
     * A paragraph or a line of text.
     *
     * @param string $html the content (escaped already)
     * @param 'ink'|'muted'|'brand'|'violet' $tone
     * @param 'left'|'center' $align
     */
    public static function text(string $html, int $size = 15, int $weight = 400, string $tone = 'ink', string $margin = '0 0 16px', string $align = 'left'): string
    {
        [$color, $class] = self::TONE_TEXT[$tone] ?? self::TONE_TEXT['ink'];
        $lineHeight = $size >= 20 ? $size + 6 : $size + 8;

        return '<p class="' . $class . '" style="margin:' . $margin . ';font-family:' . self::FONT . ';font-size:' . $size . 'px;line-height:' . $lineHeight . 'px;'
            . 'font-weight:' . $weight . ';color:' . $color . ';text-align:' . $align . ';">' . $html . '</p>';
    }

    /** A large headline figure or title inside a card, e.g. "Business × 2" (`$html` escaped already). */
    public static function big(string $html, string $margin = '0 0 12px'): string
    {
        return '<p class="rx-ink rx-big" style="margin:' . $margin . ';font-family:' . self::FONT . ';font-size:24px;line-height:30px;font-weight:800;letter-spacing:-0.3px;color:' . self::INK . ';">'
            . $html . '</p>';
    }

    /** A "× 2" in the accent colour, to follow a name in big(). */
    public static function times(int $count): string
    {
        return '<span class="rx-accent" style="color:' . self::ACCENT . ';">&times;&nbsp;' . $count . '</span>';
    }

    /** A small upper-case section label in the accent colour. */
    public static function sectionTitle(string $text): string
    {
        return '<p class="rx-accent" style="margin:0 0 10px;font-family:' . self::FONT . ';font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:' . self::ACCENT . ';">'
            . self::e($text) . '</p>';
    }

    /**
     * A panel holding other blocks: `soft` (tinted) or `outline` (white with a border).
     *
     * @param 'soft'|'outline' $style
     */
    public static function box(string $innerHtml, string $style = 'soft'): string
    {
        $soft = $style === 'soft';
        $background = $soft ? self::SOFT : '#ffffff';

        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>'
            . '<td bgcolor="' . $background . '" class="' . ($soft ? 'rx-soft' : 'rx-card') . ' rx-boxpad" style="background-color:' . $background . ';border:1px solid ' . self::LINE . ';border-radius:14px;padding:20px 22px;">'
            . $innerHtml . '</td></tr></table>' . self::spacer(20);
    }

    /**
     * Label and value rows; a row whose value is '' is left out, rather than shown as a dash.
     *
     * @param list<array{0: string, 1: string}> $rows the label (text) and the value (HTML)
     */
    public static function rows(array $rows): string
    {
        $kept = array_values(array_filter($rows, static fn (array $row): bool => $row[1] !== ''));
        $html = '';
        foreach ($kept as $index => [$label, $valueHtml]) {
            $rule = $index < count($kept) - 1 ? 'border-bottom:1px solid ' . self::LINE . ';' : '';
            $html .= '<tr>'
                . '<td valign="top" width="104" class="rx-muted rx-line rx-label" style="width:104px;padding:10px 12px 10px 0;' . $rule . 'font-family:' . self::FONT . ';font-size:13px;line-height:20px;color:' . self::MUTED . ';">'
                . self::e($label) . '</td>'
                . '<td valign="top" class="rx-ink rx-line" style="padding:10px 0;' . $rule . 'font-family:' . self::FONT . ';font-size:15px;line-height:20px;font-weight:600;color:' . self::INK . ';word-break:break-word;">'
                . $valueHtml . '</td>'
                . '</tr>';
        }

        return $html === '' ? '' : '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' . $html . '</table>';
    }

    /**
     * A rounded label, e.g. "3 computers per licence".
     *
     * @param 'brand'|'violet'|'green'|'amber'|'grey' $tone
     */
    public static function pill(string $text, string $tone = 'brand'): string
    {
        [$background, $color] = self::TONES[$tone] ?? self::TONES['brand'];

        return '<span style="display:inline-block;margin:0 6px 6px 0;padding:5px 12px;border-radius:999px;background-color:' . $background . ';color:' . $color . ';'
            . 'font-family:' . self::FONT . ';font-size:13px;line-height:18px;font-weight:600;">' . self::e($text) . '</span> ';
    }

    /** The white reference badge for the header band, e.g. "REFERENCE  RX-1A2B3C4D". */
    public static function reference(string $reference, string $label = 'Reference'): string
    {
        return '<span style="display:inline-block;padding:7px 14px;border-radius:999px;background-color:#ffffff;font-family:' . self::FONT . ';'
            . 'font-size:11px;line-height:18px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#5b34c4;">' . self::e($label)
            . '&nbsp;&nbsp;<span style="font-family:' . self::MONO . ';font-size:15px;letter-spacing:1px;text-transform:none;color:' . self::INK . ';">'
            . self::e($reference) . '</span></span>';
    }

    /** Text in the monospace face, e.g. a GSTIN. */
    public static function mono(string $text): string
    {
        return '<span style="font-family:' . self::MONO . ';letter-spacing:0.5px;">' . self::e($text) . '</span>';
    }

    /** A link, or just the text when there is no safe address for it. `$href` comes from this class's builders. */
    public static function link(?string $href, string $text): string
    {
        return $href === null ? self::e($text)
            : '<a href="' . self::e($href) . '" class="rx-link" style="color:#2450c0;text-decoration:none;">' . self::e($text) . '</a>';
    }

    /**
     * The main call to action: the gradient button, centred (full width on a
     * phone). '' when there is no safe address for it.
     */
    public static function button(?string $href, string $label): string
    {
        if ($href === null) {
            return '';
        }

        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">'
            . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="rx-full" style="border-collapse:separate;"><tr>'
            . '<td align="center" bgcolor="' . self::BRAND_A . '" style="' . self::GRADIENT . 'border-radius:12px;mso-padding-alt:15px 32px;">'
            . '<a href="' . self::e($href) . '" target="_blank" class="rx-wide" style="display:inline-block;padding:15px 32px;font-family:' . self::FONT . ';'
            . 'font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">'
            . '<font color="#ffffff">' . self::e($label) . '&nbsp;&rarr;</font></a>'
            . '</td></tr></table>'
            . '</td></tr></table>' . self::spacer(18);
    }

    /**
     * A row of equal small buttons, e.g. Call · WhatsApp · E-mail. A button
     * without a safe address is left out.
     *
     * @param list<array{0: ?string, 1: string, 2: 'brand'|'violet'|'green'|'amber'|'grey'}> $buttons href, label, tone
     */
    public static function quickButtons(array $buttons): string
    {
        $buttons = array_values(array_filter($buttons, static fn (array $button): bool => $button[0] !== null));
        $count = count($buttons);
        if ($count === 0) {
            return '';
        }

        $cells = '';
        foreach ($buttons as $index => [$href, $label, $tone]) {
            [$background, $color] = self::TONES[$tone] ?? self::TONES['brand'];
            $gapRight = $index === $count - 1 ? '0' : '4px';
            $gapLeft = $index === 0 ? '0' : '4px';
            $cells .= '<td width="' . intdiv(100, $count) . '%" valign="top" style="padding:0 ' . $gapRight . ' 0 ' . $gapLeft . ';">'
                . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>'
                . '<td align="center" bgcolor="' . $background . '" style="background-color:' . $background . ';border-radius:10px;mso-padding-alt:13px 6px;">'
                . '<a href="' . self::e((string) $href) . '" target="_blank" style="display:block;padding:13px 6px;font-family:' . self::FONT . ';font-size:14px;line-height:18px;'
                . 'font-weight:700;color:' . $color . ';text-decoration:none;border-radius:10px;">' . self::e($label) . '</a>'
                . '</td></tr></table></td>';
        }

        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' . $cells . '</tr></table>';
    }

    /** A highlighted note (`$html` escaped already). */
    public static function callout(string $html, string $tone = 'brand'): string
    {
        [$background, $color] = self::TONES[$tone] ?? self::TONES['brand'];

        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>'
            . '<td bgcolor="' . $background . '" style="background-color:' . $background . ';border-left:4px solid ' . $color . ';border-radius:0 12px 12px 0;padding:14px 18px;'
            . 'font-family:' . self::FONT . ';font-size:14px;line-height:21px;color:' . $color . ';">' . $html . '</td>'
            . '</tr></table>' . self::spacer(20);
    }

    /** Someone's own words, escaped, with their line breaks, in a quote box. */
    public static function quote(string $text): string
    {
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>'
            . '<td bgcolor="' . self::SOFT . '" class="rx-quote" style="background-color:' . self::SOFT . ';border-left:4px solid ' . self::BRAND_B . ';border-radius:0 12px 12px 0;padding:14px 18px;'
            . 'font-family:' . self::FONT . ';font-size:15px;line-height:23px;color:' . self::INK . ';word-break:break-word;">' . self::multiline($text) . '</td>'
            . '</tr></table>' . self::spacer(20);
    }

    /**
     * Numbered steps, each a title and an optional detail line.
     *
     * @param list<array{0: string, 1: string}> $steps title and detail (text)
     */
    public static function steps(array $steps): string
    {
        $rows = '';
        foreach (array_values($steps) as $index => [$title, $detail]) {
            $rows .= '<tr>'
                . '<td width="44" valign="top" style="width:44px;min-width:44px;padding:0 0 16px;">'
                . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>'
                . '<td align="center" valign="middle" width="30" height="30" bgcolor="' . self::BRAND_A . '" style="width:30px;min-width:30px;height:30px;' . self::GRADIENT . 'border-radius:15px;'
                . 'font-family:' . self::FONT . ';font-size:14px;line-height:30px;font-weight:800;color:#ffffff;">' . ($index + 1) . '</td>'
                . '</tr></table></td>'
                . '<td valign="top" style="padding:4px 0 16px;font-family:' . self::FONT . ';word-break:break-word;">'
                . '<span class="rx-ink" style="display:block;font-size:15px;line-height:22px;font-weight:700;color:' . self::INK . ';">' . self::e($title) . '</span>'
                . ($detail === '' ? '' : '<span class="rx-muted" style="display:block;font-size:14px;line-height:21px;color:' . self::MUTED . ';">' . self::e($detail) . '</span>')
                . '</td>'
                . '</tr>';
        }

        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' . $rows . '</table>' . self::spacer(4);
    }

    /**
     * A licence key in a large, letter-spaced, high-contrast box. It breaks
     * only at its dashes if it ever has to, and a tap selects all of it where
     * the client allows.
     */
    public static function keyBox(string $key): string
    {
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>'
            . '<td align="center" bgcolor="#ffffff" class="rx-key" style="background-color:#ffffff;border:2px dashed ' . self::BRAND_A . ';border-radius:12px;padding:14px 6px;'
            . 'font-family:' . self::MONO . ';font-size:17px;line-height:26px;font-weight:700;letter-spacing:0.5px;color:' . self::INK . ';'
            . '-webkit-user-select:all;user-select:all;word-break:keep-all;overflow-wrap:normal;">' . self::e($key) . '</td>'
            . '</tr></table>' . self::spacer(14);
    }

    /** A thin rule between parts of a card. */
    public static function divider(): string
    {
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
            . '<td height="1" class="rx-line" style="height:1px;border-top:1px solid ' . self::LINE . ';font-size:1px;line-height:1px;">&nbsp;</td>'
            . '</tr></table>';
    }

    /** Two cells side by side, the second right-aligned, e.g. a label and a total. */
    public static function split(string $leftHtml, string $rightHtml): string
    {
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
            . '<td valign="middle" style="padding:14px 12px 0 0;">' . $leftHtml . '</td>'
            . '<td valign="middle" align="right" style="padding:14px 0 0;white-space:nowrap;">' . $rightHtml . '</td>'
            . '</tr></table>';
    }

    /** Vertical space that Outlook keeps too. */
    public static function spacer(int $pixels): string
    {
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
            . '<td height="' . $pixels . '" style="height:' . $pixels . 'px;font-size:1px;line-height:' . $pixels . 'px;">&nbsp;</td>'
            . '</tr></table>';
    }

    /**
     * `mailto:` for one address SesMailer would send to, or `null`. Characters
     * a mailto URI reserves (`%`, `?`, `&`, `#` …) are percent-encoded.
     */
    public static function mailto(string $address, string $subject = ''): ?string
    {
        if (!SesMailer::isAddress($address)) {
            return null;
        }

        $encoded = preg_replace_callback('/[^A-Za-z0-9.@_+\-]/', static fn (array $match): string => rawurlencode($match[0]), $address) ?? '';

        return 'mailto:' . $encoded . ($subject === '' ? '' : '?subject=' . rawurlencode($subject));
    }

    /**
     * The digits of an international number such as `+91 9876543210`, or
     * `null` when it is not "+" and digits (spaces allowed between them).
     */
    public static function phoneDigits(string $phone): ?string
    {
        if (preg_match('/^\+[0-9][0-9 ]*$/D', $phone) !== 1) {
            return null;
        }
        $digits = str_replace(' ', '', substr($phone, 1));

        return strlen($digits) >= 5 && strlen($digits) <= 15 ? $digits : null;
    }

    /** `tel:+919876543210`, or `null`. */
    public static function tel(string $phone): ?string
    {
        $digits = self::phoneDigits($phone);

        return $digits === null ? null : 'tel:+' . $digits;
    }

    /** A WhatsApp chat link, `https://wa.me/919876543210`, optionally with a first message; or `null`. */
    public static function whatsapp(string $phone, string $message = ''): ?string
    {
        $digits = self::phoneDigits($phone);

        return $digits === null ? null : 'https://wa.me/' . $digits . ($message === '' ? '' : '?text=' . rawurlencode($message));
    }

    /**
     * A page of our own site: `$site` (an https:// address with a plain host
     * name and path) followed by `$path` (which the code writes, e.g.
     * `/download/`); `null` when `$site` is anything else.
     */
    public static function siteUrl(string $site, string $path = '/'): ?string
    {
        $base = rtrim($site, '/');
        if (preg_match('#^https://[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~\-/]*)?$#D', $base) !== 1
            || preg_match('#^/[A-Za-z0-9._~\-/?=&]*$#D', $path) !== 1) {
            return null;
        }

        return $base . $path;
    }
}

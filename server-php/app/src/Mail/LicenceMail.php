<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

use RecoverX\Licensing\Messages;

/**
 * The e-mail that brings customers their licence key: the key, what it
 * covers, and how to activate it — in the words the app itself uses
 * (Licence → Activate a licence → Activate). Plain text, plus an HTML version
 * (EmailHtml) that shows each key large and easy to copy on a phone.
 */
final class LicenceMail
{
    /**
     * @param list<array<string, mixed>> $licences one or more licences for the same customer
     * @return array{subject: string, text: string, html: string}
     */
    public static function compose(array $licences, string $siteUrl): array
    {
        if ($licences === []) {
            throw new \InvalidArgumentException('No licences to e-mail.');
        }

        $site = rtrim($siteUrl, '/');
        $several = count($licences) > 1;
        $name = $licences[0]['registeredTo'] ?? null;
        $name = is_string($name) && $name !== '' ? $name : null;

        $lines = [
            'Hello' . ($name === null ? '' : " {$name}") . ',',
            '',
            'Thank you for choosing RecoverX. ' . ($several ? 'Here are your licence keys:' : 'Here is your licence key:'),
            '',
        ];

        $cards = '';
        foreach (array_values($licences) as $index => $licence) {
            [$edition, $seats, $validity] = self::terms($licence);
            $lines[] = '    ' . $licence['key'];
            $lines[] = "    RecoverX {$edition} · {$seats} · {$validity}";
            $lines[] = '';

            $cards .= EmailHtml::box(
                EmailHtml::sectionTitle($several ? 'Licence key ' . ($index + 1) . ' of ' . count($licences) : 'Your licence key')
                . EmailHtml::keyBox((string) $licence['key'])
                . EmailHtml::pill("RecoverX {$edition}")
                . EmailHtml::pill(ucfirst($seats), 'violet')
                . EmailHtml::pill(ucfirst($validity), 'green'),
            );
        }

        array_push(
            $lines,
            'To activate:',
            "1. Download and install RecoverX from {$site}/download/",
            '2. Open RecoverX and choose Licence.',
            '3. Under "Activate a licence", paste the key and choose Activate.',
            '',
            'Keep this e-mail: you need the key again to move RecoverX to a new computer',
            '(choose "Remove from this computer" on the old one first).',
            '',
            'Questions? Just reply to this e-mail.',
            '',
            'RecoverX',
            $site,
        );

        $body = EmailHtml::text('Hello' . ($name === null ? '' : ' ' . EmailHtml::e($name)) . ',', 17, 700, 'ink', '0 0 8px')
            . EmailHtml::text('Thank you for choosing RecoverX. ' . ($several
                ? 'Here are your licence keys — copy each one into the app to activate it.'
                : 'Here is your licence key — copy it into the app to activate RecoverX.'))
            . $cards
            . EmailHtml::button(EmailHtml::siteUrl($site, '/download/'), 'Download RecoverX')
            . EmailHtml::sectionTitle('Activate in three steps')
            . EmailHtml::steps([
                ['Download and install RecoverX', "From {$site}/download/"],
                ['Open RecoverX and choose Licence', ''],
                ['Paste the key and choose Activate', 'Under “Activate a licence”.'],
            ])
            . EmailHtml::callout('<strong>Keep this e-mail.</strong> You need the key again to move RecoverX to a new computer '
                . '— choose “Remove from this computer” on the old one first.')
            . EmailHtml::text('Questions? Just reply to this e-mail — we are happy to help.', 14, 400, 'muted', '0', 'center');

        $edition = self::terms($licences[0])[0];

        return [
            'subject' => $several ? 'Your RecoverX licence keys' : 'Your RecoverX licence key',
            'text' => implode("\n", $lines) . "\n",
            'html' => EmailHtml::document(
                title: $several ? 'Your RecoverX licence keys' : 'Your RecoverX licence key',
                preheader: $several ? 'Your RecoverX licence keys and how to activate them.' : "Your RecoverX {$edition} licence key and how to activate it.",
                eyebrow: 'Licence',
                heading: $several ? 'Your licence keys are ready' : 'Your licence key is ready',
                subheading: 'Thank you for choosing RecoverX.',
                badgeHtml: '',
                bodyHtml: $body,
                footnote: 'Sent to you because a RecoverX licence was issued to this e-mail address.',
            ),
        ];
    }

    /**
     * What a licence covers, in words: `Professional`, `1 computer`, `valid until 12 November 2027`.
     *
     * @param array<string, mixed> $licence
     * @return array{0: string, 1: string, 2: string}
     */
    private static function terms(array $licence): array
    {
        $seats = $licence['maxActivations'];

        return [
            ucfirst((string) $licence['edition']),
            $seats === null ? 'unlimited computers' : ($seats === 1 ? '1 computer' : "up to {$seats} computers"),
            $licence['expiresAt'] === null ? 'never expires' : 'valid until ' . Messages::formatCustomerDate((int) $licence['expiresAt']),
        ];
    }
}

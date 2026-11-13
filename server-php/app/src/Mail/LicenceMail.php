<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

use RecoverX\Licensing\Messages;

/**
 * The e-mail that brings customers their licence key: the key, what it
 * covers, and how to activate it — in the words the app itself uses
 * (Licence → Activate a licence → Activate).
 */
final class LicenceMail
{
    /**
     * @param list<array<string, mixed>> $licences one or more licences for the same customer
     * @return array{subject: string, text: string}
     */
    public static function compose(array $licences, string $siteUrl): array
    {
        if ($licences === []) {
            throw new \InvalidArgumentException('No licences to e-mail.');
        }

        $site = rtrim($siteUrl, '/');
        $several = count($licences) > 1;
        $name = $licences[0]['registeredTo'] ?? null;

        $lines = [
            'Hello' . (is_string($name) && $name !== '' ? " {$name}" : '') . ',',
            '',
            'Thank you for choosing RecoverX. ' . ($several ? 'Here are your licence keys:' : 'Here is your licence key:'),
            '',
        ];

        foreach ($licences as $licence) {
            $seats = $licence['maxActivations'];
            $lines[] = '    ' . $licence['key'];
            $lines[] = '    RecoverX ' . ucfirst((string) $licence['edition'])
                . ' · ' . ($seats === null ? 'unlimited computers' : ($seats === 1 ? '1 computer' : "up to {$seats} computers"))
                . ' · ' . ($licence['expiresAt'] === null ? 'never expires' : 'valid until ' . Messages::formatCustomerDate((int) $licence['expiresAt']));
            $lines[] = '';
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

        return [
            'subject' => $several ? 'Your RecoverX licence keys' : 'Your RecoverX licence key',
            'text' => implode("\n", $lines) . "\n",
        ];
    }
}

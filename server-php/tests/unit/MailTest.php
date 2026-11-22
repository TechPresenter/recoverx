<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\Config;
use RecoverX\Licensing\ConfigError;
use RecoverX\Licensing\Mail\EmailHtml;
use RecoverX\Licensing\Mail\InstanceRoleCredentials;
use RecoverX\Licensing\Mail\LicenceMail;
use RecoverX\Licensing\Mail\MailError;
use RecoverX\Licensing\Mail\SesMailer;
use RecoverX\Licensing\Mail\SigV4;

/* Licence e-mail through Amazon SES: signing, the request, errors, settings and the message. */

const FAKE_CREDENTIALS = ['accessKeyId' => 'AKIDEXAMPLE', 'secretAccessKey' => 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', 'sessionToken' => null];

/** A fake HTTP function that records requests and answers from a script. */
final class FakeHttp
{
    /** @var list<array{method: string, url: string, headers: array<string, string>, body: string}> */
    public array $requests = [];

    /** @param list<array{status: int, body: string}|MailError> $answers */
    public function __construct(private array $answers)
    {
    }

    /** @param array<string, string> $headers */
    public function __invoke(string $method, string $url, array $headers, string $body, float $timeout): array
    {
        $this->requests[] = ['method' => $method, 'url' => $url, 'headers' => $headers, 'body' => $body];
        $answer = array_shift($this->answers) ?? throw new \LogicException("Unexpected request to {$url}");
        if ($answer instanceof MailError) {
            throw $answer;
        }

        return $answer;
    }
}

function mailer(FakeHttp $http, ?string $replyTo = 'info@appsgain.in', array $credentials = FAKE_CREDENTIALS): SesMailer
{
    return new SesMailer('ap-south-1', 'licences@snapkio.com', 'RecoverX', $replyTo, static fn (): array => $credentials, $http, new FakeClock());
}

/** @return array<string, mixed> */
function licenceRecord(array $overrides = []): array
{
    return $overrides + [
        'key' => 'RECX-ABCDE-FGHJK-12345-MNPQR',
        'edition' => 'professional',
        'registeredTo' => 'Jane Doe',
        'email' => 'jane@example.com',
        'maxActivations' => 1,
        'expiresAt' => Kit::NOW + 365 * Kit::DAY,
        'createdAt' => Kit::NOW,
        'revokedAt' => null,
    ];
}

test('signs exactly like the AWS Signature Version 4 test suite (get-vanilla)', function (): void {
    $headers = SigV4::sign('GET', '/', '', ['Host' => 'example.amazonaws.com'], '', 'us-east-1', 'service', FAKE_CREDENTIALS, gmmktime(12, 36, 0, 8, 30, 2015));

    Assert::same('20150830T123600Z', $headers['X-Amz-Date']);
    Assert::same(
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, '
            . 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
        $headers['Authorization'],
    );
});

test('signs the session token of temporary credentials', function (): void {
    $headers = SigV4::sign('POST', '/v2/email/outbound-emails', '', ['Host' => 'email.ap-south-1.amazonaws.com', 'Content-Type' => 'application/json'],
        '{}', 'ap-south-1', 'ses', ['sessionToken' => 'TOKEN'] + FAKE_CREDENTIALS, intdiv(Kit::NOW, 1000));

    Assert::same('TOKEN', $headers['X-Amz-Security-Token']);
    Assert::matches('#^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261112/ap-south-1/ses/aws4_request, '
        . 'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$#', $headers['Authorization']);
});

test('sends one plain-text message through SES v2 and returns its id', function (): void {
    $http = new FakeHttp([['status' => 200, 'body' => '{"MessageId":"0109-abc"}']]);

    Assert::same('0109-abc', mailer($http)->send('jane@example.com', 'Your RecoverX licence key', "Hello\n"));

    $request = $http->requests[0];
    Assert::same('POST', $request['method']);
    Assert::same('https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails', $request['url']);
    Assert::same('email.ap-south-1.amazonaws.com', $request['headers']['Host']);
    Assert::matches('#^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261112/ap-south-1/ses/aws4_request, #', $request['headers']['Authorization']);
    Assert::same([
        'FromEmailAddress' => 'RecoverX <licences@snapkio.com>',
        'Destination' => ['ToAddresses' => ['jane@example.com']],
        'Content' => ['Simple' => [
            'Subject' => ['Data' => 'Your RecoverX licence key', 'Charset' => 'UTF-8'],
            'Body' => ['Text' => ['Data' => "Hello\n", 'Charset' => 'UTF-8']],
        ]],
        'ReplyToAddresses' => ['info@appsgain.in'],
    ], json_decode($request['body'], true));
});

test('sends an HTML alternative next to the text only when given one', function (): void {
    $http = new FakeHttp([['status' => 200, 'body' => '{"MessageId":"m-1"}'], ['status' => 200, 'body' => '{"MessageId":"m-2"}'], ['status' => 200, 'body' => '{"MessageId":"m-3"}']]);
    $html = "<!DOCTYPE html>\n<p>Hello ₹</p>\n";

    Assert::same('m-1', mailer($http)->send('jane@example.com', 'S', "Hello ₹\n", null, $html));
    Assert::same([
        'Text' => ['Data' => "Hello ₹\n", 'Charset' => 'UTF-8'],
        'Html' => ['Data' => $html, 'Charset' => 'UTF-8'],
    ], json_decode($http->requests[0]['body'], true)['Content']['Simple']['Body']);

    mailer($http)->send('jane@example.com', 'S', 'T');
    mailer($http)->send('jane@example.com', 'S', 'T', null, '');
    foreach ([1, 2] as $index) {
        Assert::same(['Text'], array_keys(json_decode($http->requests[$index]['body'], true)['Content']['Simple']['Body']), "request {$index} is text only");
    }
});

test('leaves out Reply-To when none is set', function (): void {
    $http = new FakeHttp([['status' => 200, 'body' => '{"MessageId":"m"}']]);
    mailer($http, null)->send('jane@example.com', 'S', 'T');

    Assert::true(!array_key_exists('ReplyToAddresses', json_decode($http->requests[0]['body'], true)), 'no ReplyToAddresses');
});

test('refuses a recipient that is not exactly one address, without calling SES', function (): void {
    $http = new FakeHttp([]);
    foreach (['', 'jane', "jane@example.com\r\nBcc: x@example.com", 'a@example.com, b@example.com', 'Jane <jane@example.com>'] as $to) {
        Assert::throws(MailError::class, static fn () => mailer($http)->send($to, 'S', 'T'), '/not an e-mail address/');
    }
    Assert::same(0, count($http->requests));
});

test('explains what SES refused, with a hint for the sandbox', function (): void {
    $http = new FakeHttp([['status' => 400, 'body' => '{"message":"Email address is not verified. The following identities failed the check in region AP-SOUTH-1: jane@example.com"}']]);
    Assert::throws(MailError::class, static fn () => mailer($http)->send('jane@example.com', 'S', 'T'), '/^Amazon SES did not send the e-mail: Email address is not verified\..*sandbox/');

    $http = new FakeHttp([['status' => 403, 'body' => '{"message":"User is not authorized to perform ses:SendEmail"}']]);
    Assert::throws(MailError::class, static fn () => mailer($http)->send('jane@example.com', 'S', 'T'), '/not authorized.*IAM role/');

    $http = new FakeHttp([['status' => 502, 'body' => '<html>Bad gateway</html>']]);
    Assert::throws(MailError::class, static fn () => mailer($http)->send('jane@example.com', 'S', 'T'), '/: HTTP 502$/');

    $http = new FakeHttp([new MailError('Could not connect to email.ap-south-1.amazonaws.com.')]);
    Assert::throws(MailError::class, static fn () => mailer($http)->send('jane@example.com', 'S', 'T'), '/could not be reached.*Nothing was sent/');
});

test('reads the IAM role credentials with IMDSv2', function (): void {
    $http = new FakeHttp([
        ['status' => 200, 'body' => 'IMDS-TOKEN'],
        ['status' => 200, 'body' => "example-role\n"],
        ['status' => 200, 'body' => '{"Code":"Success","Type":"AWS-HMAC","AccessKeyId":"ASIAEXAMPLE","SecretAccessKey":"secret","Token":"session","Expiration":"2026-11-13T13:15:36Z"}'],
    ]);

    Assert::same(['accessKeyId' => 'ASIAEXAMPLE', 'secretAccessKey' => 'secret', 'sessionToken' => 'session'], (new InstanceRoleCredentials($http))->get());
    Assert::same('PUT', $http->requests[0]['method']);
    Assert::same('http://169.254.169.254/latest/api/token', $http->requests[0]['url']);
    Assert::same('IMDS-TOKEN', $http->requests[1]['headers']['X-aws-ec2-metadata-token']);
    Assert::same('http://169.254.169.254/latest/meta-data/iam/security-credentials/example-role', $http->requests[2]['url']);
});

test('says plainly when the server has no IAM role or is not on EC2', function (): void {
    $http = new FakeHttp([['status' => 200, 'body' => 'T'], ['status' => 404, 'body' => 'Not Found']]);
    Assert::throws(MailError::class, static fn () => (new InstanceRoleCredentials($http))->get(), '/no IAM role/');

    $http = new FakeHttp([new MailError('Could not connect to 169.254.169.254.')]);
    Assert::throws(MailError::class, static fn () => (new InstanceRoleCredentials($http))->get(), '/metadata service did not answer/');

    $http = new FakeHttp([['status' => 200, 'body' => 'T'], ['status' => 200, 'body' => 'role'], ['status' => 200, 'body' => '{"Code":"Failure"}']]);
    Assert::throws(MailError::class, static fn () => (new InstanceRoleCredentials($http))->get(), '/could not be read/');
});

test('accepts the mail settings and keeps e-mail off by default', function (): void {
    $defaults = Config::validate([]);
    Assert::same('', $defaults['mail_from']);
    Assert::same('RecoverX', $defaults['mail_from_name']);

    $settings = Config::validate(['mail_from' => 'licences@snapkio.com', 'mail_reply_to' => 'info@appsgain.in', 'ses_region' => 'ap-south-1']);
    Assert::same('licences@snapkio.com', $settings['mail_from']);
    Assert::same('ap-south-1', $settings['ses_region']);
});

test('refuses mail settings that could not work or could inject headers', function (): void {
    Assert::throws(ConfigError::class, static fn () => Config::validate(['mail_from' => 'licences@snapkio.com']), '/ses_region must be set/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['mail_from' => "a@b.com\r\nBcc: c@d.com", 'ses_region' => 'ap-south-1']), '/mail_from must be one e-mail address/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['mail_reply_to' => 'Info <info@appsgain.in>']), '/mail_reply_to must be one e-mail address/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['mail_from_name' => 'RecoverX <x@y.z>']), '/mail_from_name must be/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['ses_region' => 'mumbai']), '/ses_region must be an AWS region/');
    Assert::throws(ConfigError::class, static fn () => Config::validate(['mail_from' => true]), '/mail_from must be text/');
});

test('writes the licence e-mail in the app’s own words', function (): void {
    $mail = LicenceMail::compose([licenceRecord()], 'https://recoverx.snapkio.com/');

    Assert::same('Your RecoverX licence key', $mail['subject']);
    Assert::matches('/^Hello Jane Doe,\n/', $mail['text']);
    Assert::matches('/\n    RECX-ABCDE-FGHJK-12345-MNPQR\n    RecoverX Professional · 1 computer · valid until 12 November 2027\n/', $mail['text']);
    Assert::matches('#1\. Download and install RecoverX from https://recoverx\.snapkio\.com/download/\n#', $mail['text']);
    Assert::matches('/paste the key and choose Activate/', $mail['text']);
    Assert::matches('/reply to this e-mail/', $mail['text']);
});

test('lists several keys in one e-mail, with unlimited and perpetual terms', function (): void {
    $mail = LicenceMail::compose([
        licenceRecord(['registeredTo' => null]),
        licenceRecord(['key' => 'RECX-AAAAA-BBBBB-CCCCC-DDDDD', 'edition' => 'technician', 'maxActivations' => null, 'expiresAt' => null]),
    ], 'https://recoverx.snapkio.com');

    Assert::same('Your RecoverX licence keys', $mail['subject']);
    Assert::matches('/^Hello,\n/', $mail['text']);
    Assert::matches('/Here are your licence keys:/', $mail['text']);
    Assert::matches('/RecoverX Technician · unlimited computers · never expires/', $mail['text']);

    $html = $mail['html'];
    foreach (['RECX-ABCDE-FGHJK-12345-MNPQR', 'RECX-AAAAA-BBBBB-CCCCC-DDDDD', 'Licence key 1 of 2', 'Licence key 2 of 2', 'Your licence keys are ready',
        'Unlimited computers', 'Never expires', '>Hello,</p>'] as $expected) {
        Assert::true(str_contains($html, $expected), "HTML contains {$expected}");
    }
});

test('the licence e-mail’s HTML shows the key large, the terms and the download button, and escapes the name', function (): void {
    $mail = LicenceMail::compose([licenceRecord(['registeredTo' => '<script>alert(1)</script> & "Co"'])], 'https://recoverx.snapkio.com/');
    $html = $mail['html'];

    Assert::matches('/^<!DOCTYPE html>\n<html lang="en"/', $html);
    Assert::true(str_contains($html, '<meta name="color-scheme" content="light dark">'), 'declares light and dark');
    Assert::matches('#<td align="center" bgcolor="\#ffffff" class="rx-key" style="[^"]*font-size:21px;[^"]*">RECX-ABCDE-FGHJK-12345-MNPQR</td>#', $html);
    foreach (['RecoverX Professional', '1 computer', 'Valid until 12 November 2027', 'href="https://recoverx.snapkio.com/download/"', 'Download RecoverX',
        'Open RecoverX and choose Licence', 'Paste the key and choose Activate', 'Keep this e-mail.', 'Remove from this computer', 'Just reply to this e-mail',
        'Hello &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;,', 'RecoverX</strong> by Appsgain Technologies', 'href="mailto:info@appsgain.in"'] as $expected) {
        Assert::true(str_contains($html, $expected), "HTML contains {$expected}");
    }
    Assert::notContains('<script', $html, 'the name is escaped');
    Assert::notContains('<img', $html, 'no images to block or to track with');
    Assert::matches('/^Hello <script>alert\(1\)<\/script> & "Co",\n/', $mail['text']);
});

test('builds e-mail links only from checked pieces', function (): void {
    Assert::same('tel:+919876543210', EmailHtml::tel('+91 9876543210'));
    Assert::same('https://wa.me/919876543210', EmailHtml::whatsapp('+91 9876543210'));
    Assert::same('https://wa.me/15551234567?text=Hi%20%26%20bye', EmailHtml::whatsapp('+1 5551234567', 'Hi & bye'));
    foreach (['9876543210', '+91 98765-43210', '+91 9876543210;x', 'javascript:alert(1)', '+1 23', '+12345678901234567', "+91 98765\n43210", ''] as $bad) {
        Assert::same(null, EmailHtml::tel($bad), json_encode($bad));
        Assert::same(null, EmailHtml::whatsapp($bad), json_encode($bad));
    }

    Assert::same('mailto:jane@example.com', EmailHtml::mailto('jane@example.com'));
    Assert::same('mailto:a%26b%3Fc@example.com?subject=Your%20RecoverX%20order%20RX-1', EmailHtml::mailto('a&b?c@example.com', 'Your RecoverX order RX-1'));
    foreach (['Jane <jane@example.com>', 'jane', "jane@example.com\r\nBcc: x@example.com", 'javascript:alert(1)//@example.com'] as $bad) {
        Assert::same(null, EmailHtml::mailto($bad), json_encode($bad));
    }

    Assert::same('https://recoverx.snapkio.com/download/', EmailHtml::siteUrl('https://recoverx.snapkio.com/', '/download/'));
    Assert::same('https://licensing.test:8443/rx/admin/?page=order&id=7', EmailHtml::siteUrl('https://licensing.test:8443/rx', '/admin/?page=order&id=7'));
    foreach (['http://recoverx.snapkio.com', 'javascript:alert(1)//', 'https://evil.test/"onmouseover="x', 'https://evil.test/<b>', '//recoverx.snapkio.com', ''] as $bad) {
        Assert::same(null, EmailHtml::siteUrl($bad, '/download/'), json_encode($bad));
    }
    Assert::same(null, EmailHtml::siteUrl('https://recoverx.snapkio.com', 'download/"x'), 'the path is checked too');

    Assert::same('', EmailHtml::button(null, 'Open'), 'no button without a safe address');
    Assert::same('Jane &amp; Co', EmailHtml::link(null, 'Jane & Co'));
});

test('escapes every value it is given, and keeps the line breaks of quoted text', function (): void {
    Assert::same('&lt;b&gt;&quot;x&quot; &amp; &apos;y&apos;&lt;/b&gt;', EmailHtml::e('<b>"x" & \'y\'</b>'));
    Assert::same("one<br>\ntwo &lt;i&gt;", EmailHtml::multiline("one\r\ntwo <i>"));
    Assert::same("\u{FFFD}", EmailHtml::e("\xFF"), 'broken UTF-8 is replaced, not passed through');

    $html = EmailHtml::document(
        title: '<t>', preheader: '<p>', eyebrow: '<e>', heading: '<h>', subheading: '<s>',
        badgeHtml: EmailHtml::pill('<pill>'), bodyHtml: EmailHtml::rows([['<label>', EmailHtml::e('<value>')], ['Empty', '']]) . EmailHtml::quote("<q>\nline"),
        footnote: '<f>',
    );
    foreach (['<t>', '<p>', '<e>', '<h>', '<s>', '<pill>', '<label>', '<value>', '<q>', '<f>'] as $raw) {
        Assert::notContains($raw, $html, "{$raw} is escaped");
        Assert::true(str_contains($html, EmailHtml::e($raw)), "{$raw} is there, escaped");
    }
    Assert::notContains('>Empty<', $html, 'an empty row is left out');
    Assert::true(str_contains($html, '&lt;q&gt;<br>' . "\n" . 'line'), 'line breaks kept');
    Assert::true(str_contains($html, 'bgcolor="#3b6fe0"') && str_contains($html, 'linear-gradient(135deg,#3b6fe0 0%,#7c4de8 100%)'), 'solid colour under the gradient');
    Assert::true(str_contains($html, '@media (prefers-color-scheme: dark)') && str_contains($html, '@media only screen and (max-width:600px)'), 'phone and dark-mode extras');
});

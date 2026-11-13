<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Mail;

/**
 * Temporary AWS credentials of the EC2 server's IAM role, from the instance
 * metadata service (IMDSv2: a session token first, then the credentials).
 *
 * Nothing is stored: AWS rotates these credentials by itself, and fetching
 * them takes three local requests of a millisecond each, once per e-mail
 * request. No access key ever sits in the configuration, and the role can
 * only send mail from the licence address (see deploy/aws-ec2/README.md).
 */
final class InstanceRoleCredentials
{
    private const BASE = 'http://169.254.169.254/latest';

    /** @var callable(string, string, array<string, string>, string, float): array{status: int, body: string} */
    private $http;

    /** @param null|callable(string, string, array<string, string>, string, float): array{status: int, body: string} $http */
    public function __construct(?callable $http = null)
    {
        $this->http = $http ?? Http::request(...);
    }

    /** @return array{accessKeyId: string, secretAccessKey: string, sessionToken: ?string} */
    public function get(): array
    {
        $token = $this->call('PUT', '/api/token', ['X-aws-ec2-metadata-token-ttl-seconds' => '60'], 'a session token');
        $headers = ['X-aws-ec2-metadata-token' => trim($token)];

        $roles = $this->call('GET', '/meta-data/iam/security-credentials/', $headers, 'the IAM role');
        $role = trim(explode("\n", trim($roles))[0]);
        if (preg_match('/^[\w+=,.@-]{1,128}$/D', $role) !== 1) {
            throw new MailError('This server has no IAM role, so it cannot sign in to Amazon SES. Attach the role (deploy/aws-ec2/README.md → E-mail).');
        }

        $document = json_decode($this->call('GET', '/meta-data/iam/security-credentials/' . $role, $headers, 'the role credentials'), true);
        if (
            !is_array($document)
            || ($document['Code'] ?? null) !== 'Success'
            || !is_string($document['AccessKeyId'] ?? null)
            || !is_string($document['SecretAccessKey'] ?? null)
        ) {
            throw new MailError("The credentials of the IAM role {$role} could not be read from the instance metadata service.");
        }

        $sessionToken = $document['Token'] ?? null;

        return [
            'accessKeyId' => $document['AccessKeyId'],
            'secretAccessKey' => $document['SecretAccessKey'],
            'sessionToken' => is_string($sessionToken) && $sessionToken !== '' ? $sessionToken : null,
        ];
    }

    /** @param array<string, string> $headers */
    private function call(string $method, string $path, array $headers, string $what): string
    {
        try {
            $response = ($this->http)($method, self::BASE . $path, $headers, '', 2.0);
        } catch (MailError $error) {
            throw new MailError(
                'The EC2 instance metadata service did not answer, so there are no AWS credentials to send e-mail with. '
                . 'Sending through Amazon SES works on the EC2 server, with its IAM role attached.',
                0,
                $error,
            );
        }

        if ($response['status'] === 404 && $what === 'the IAM role') {
            throw new MailError('This server has no IAM role, so it cannot sign in to Amazon SES. Attach the role (deploy/aws-ec2/README.md → E-mail).');
        }

        if ($response['status'] !== 200) {
            throw new MailError("The EC2 instance metadata service refused {$what} (HTTP {$response['status']}).");
        }

        return $response['body'];
    }
}

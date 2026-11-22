<?php

declare(strict_types=1);

namespace RecoverX\Licensing;

/**
 * The licensing rules.
 *
 * A port of src/server/authority.ts, the reference implementation and the
 * source of truth for behaviour: who gets a token, when a seat is taken or
 * given back, when a move is refused, and what is written to the audit trail.
 * The JSON API and the admin panel are thin shells around this class, so an
 * online activation, an offline one issued from the panel and one requested
 * by a payment webhook all follow exactly the same rules.
 *
 * Records are associative arrays whose keys and key order match the reference
 * server's JSON, so the admin API's responses are the same documents.
 */
final class Authority
{
    /** The product identifier the desktop client sends. */
    public const PRODUCT_ID = 'recoverx';

    /**
     * Twenty-four characters of upper-cased base64url, grouped by four with
     * hyphens (src/main/licensing/machine-id.ts). Base64url itself contains
     * `-` and `_`, so a hyphen is not always a separator.
     */
    public const MACHINE_ID_PATTERN = '/^[A-Z0-9_-]{24,40}$/D';

    /** Most licences one request may mint. A bulk order larger than this is a script. */
    public const MAX_BATCH = 1000;

    /** Largest finite seat count accepted. */
    public const MAX_SEATS = 1_000_000;

    /** Machines each paid edition may be active on (`null` is unlimited): `ENTITLEMENTS`. */
    public const DEFAULT_SEATS = [
        'professional' => 1,
        'business' => 3,
        'technician' => null,
        'enterprise' => null,
    ];

    /**
     * How long the records of a sale are kept after its licence has ended:
     * 8 years, as books of account must be (section 128 of the Companies Act,
     * 2013, which the privacy policy cites) — 8 × 365 days and the most leap
     * days 8 years can hold.
     */
    public const RECORDS_KEPT_DAYS = 8 * 365 + 2;

    /** Recent events returned with a licence. */
    private const SHOWN_EVENTS = 50;

    /** Attempts at drawing a key that is not already taken. */
    private const KEY_ATTEMPTS = 8;

    /** @var callable(): int */
    private $clock;

    /** @var null|callable(int): mixed */
    private $randomIndex;

    private readonly int $selfReleaseLimit;

    private readonly int $selfReleaseWindowDays;

    /**
     * @param null|callable(): int $clock epoch milliseconds; defaults to the real time
     * @param null|callable(int): mixed $randomIndex uniform integer in [0, max); defaults to random_int
     */
    public function __construct(
        private readonly Store $store,
        private readonly ?TokenSigner $signer,
        ?callable $clock = null,
        ?callable $randomIndex = null,
        int $selfReleaseLimit = 4,
        int $selfReleaseWindowDays = 365,
    ) {
        if ($selfReleaseLimit < 0) {
            throw new \RangeException("The self-service release limit must be a whole number of 0 or more, not {$selfReleaseLimit}");
        }
        if ($selfReleaseWindowDays < 1) {
            throw new \RangeException("The self-service release window must be a whole number of days, at least 1, not {$selfReleaseWindowDays}");
        }

        $this->clock = $clock ?? self::systemClock(...);
        $this->randomIndex = $randomIndex;
        $this->selfReleaseLimit = $selfReleaseLimit;
        $this->selfReleaseWindowDays = $selfReleaseWindowDays;
    }

    /** Epoch milliseconds, as JavaScript's `Date.now()`. */
    public static function systemClock(): int
    {
        return (int) floor(microtime(true) * 1000);
    }

    public function now(): int
    {
        return ($this->clock)();
    }

    public function store(): Store
    {
        return $this->store;
    }

    /** @return array{limit: int, windowDays: int} */
    public function selfReleasePolicy(): array
    {
        return ['limit' => $this->selfReleaseLimit, 'windowDays' => $this->selfReleaseWindowDays];
    }

    // --- input schemas ------------------------------------------------------------

    /**
     * Validate a create request (`CreateLicensesSchema`): a decoded JSON object.
     * Unknown fields are refused, so a webhook that sends `registered_to`
     * fails loudly instead of minting a licence with no name.
     *
     * @return array{0: list<array{0: string, 1: string}>, 1: array<string, mixed>}
     */
    public static function parseCreate(mixed $input): array
    {
        $v = new Validator($input);
        $parsed = [
            'edition' => $v->enum('edition', TokenSigner::EDITIONS),
            'count' => $v->int('count', 1, self::MAX_BATCH, Validator::NULLISH),
            'seatsGiven' => $v->has('seats'),
            'seats' => $v->int('seats', 1, self::MAX_SEATS, Validator::NULLISH),
            'expires' => $v->optionalText('expires', 64),
            'days' => $v->int('days', 1, Expiry::MAX_TERM_DAYS, Validator::NULLISH),
            'registeredTo' => $v->optionalText('registeredTo', 200),
            'email' => $v->email('email', 254),
            'orderRef' => $v->optionalText('orderRef', 200),
            'notes' => $v->optionalText('notes', 2000),
        ];

        return [$v->finish(), $parsed];
    }

    /**
     * Validate an extension request (`ExtendLicenseSchema`).
     *
     * @return array{0: list<array{0: string, 1: string}>, 1: array<string, mixed>}
     */
    public static function parseExtend(mixed $input): array
    {
        $v = new Validator($input);
        $parsed = [
            'expires' => $v->optionalText('expires', 64),
            'days' => $v->int('days', 1, Expiry::MAX_TERM_DAYS, Validator::NULLISH),
            'perpetual' => $v->bool('perpetual', Validator::OPTIONAL),
        ];

        return [$v->finish(), $parsed];
    }

    // --- minting ------------------------------------------------------------------

    /**
     * Mint licences. Idempotent per order reference: a retried "payment
     * succeeded" webhook gets the licences already minted for that order, and
     * nothing new is created.
     *
     * @param array{actor: string, ip?: ?string} $context
     * @return array{created: bool, licenses: list<array<string, mixed>>}
     */
    public function createLicenses(mixed $input, array $context): array
    {
        [$issues, $request] = self::parseCreate($input);
        if ($issues !== []) {
            throw LicenseError::invalidArgument(Validator::format($issues));
        }

        $edition = $request['edition'];
        if ($edition === 'free') {
            throw LicenseError::invalidArgument(
                'The Free edition needs no licence key. Choose professional, business, technician or enterprise.',
            );
        }

        $now = $this->now();
        $expiresAt = Expiry::resolveNew($request['expires'], $request['days'], $now);
        // Absent means "the edition's default"; null means "unlimited".
        $maxActivations = $request['seatsGiven'] ? $request['seats'] : self::DEFAULT_SEATS[$edition];
        $count = $request['count'] ?? 1;
        $orderRef = $request['orderRef'];

        return $this->store->transaction(function () use ($request, $edition, $now, $expiresAt, $maxActivations, $count, $orderRef, $context): array {
            if ($orderRef !== null) {
                $existing = $this->store->findByOrderRef($orderRef);
                if ($existing !== []) {
                    return ['created' => false, 'licenses' => $existing];
                }
            }

            $licenses = [];
            for ($index = 0; $index < $count; $index += 1) {
                $record = [
                    'key' => $this->drawUnusedKey(),
                    'edition' => $edition,
                    'registeredTo' => $request['registeredTo'],
                    'email' => $request['email'],
                    'maxActivations' => $maxActivations,
                    'expiresAt' => $expiresAt,
                    'createdAt' => $now,
                    'revokedAt' => null,
                    'revokeReason' => null,
                    'orderRef' => $orderRef,
                    'notes' => $request['notes'],
                ];

                $this->store->insertLicense($record);
                $this->audit('license-created', $record['key'], null, $context, $now, [
                    'edition' => $edition,
                    'seats' => $maxActivations,
                    'expiresAt' => $expiresAt,
                    'orderRef' => $orderRef,
                ]);
                $licenses[] = $record;
            }

            return ['created' => true, 'licenses' => $licenses];
        });
    }

    /**
     * A key no licence holds yet. Collisions are astronomically unlikely (95
     * random bits) but a primary-key violation would abort a whole batch, so
     * they are handled rather than assumed away.
     */
    private function drawUnusedKey(): string
    {
        for ($attempt = 0; $attempt < self::KEY_ATTEMPTS; $attempt += 1) {
            $key = LicenseKey::generate($this->randomIndex);

            // A key the client would refuse must never be sold.
            if (LicenseKey::validate($key)['key'] !== $key) {
                throw new \LogicException('The key generator produced a key the client would not accept');
            }

            if ($this->store->getLicense($key) === null) {
                return $key;
            }
        }

        throw new \RuntimeException(
            'Could not draw an unused licence key in ' . self::KEY_ATTEMPTS . ' attempts; the random source is broken',
        );
    }

    // --- activation -----------------------------------------------------------------

    /**
     * Exchange a licence key for a signed activation token. Re-activating a
     * machine that already holds a seat re-issues a token without taking
     * another seat — after a reinstall, or to pick up a renewal.
     *
     * @param array{actor: string, ip?: ?string} $context
     * @return array{token: string, claims: array<string, mixed>, license: array<string, mixed>, reused: bool, activeSeats: int}
     */
    public function activate(string $key, string $machineId, string $product, array $context): array
    {
        if ($product !== self::PRODUCT_ID) {
            throw new LicenseError('wrong-product', Messages::WRONG_PRODUCT);
        }

        if (preg_match(self::MACHINE_ID_PATTERN, $machineId) !== 1) {
            throw new LicenseError('invalid-machine', Messages::INVALID_MACHINE);
        }

        return $this->allocate($key, $machineId, $context, 'online');
    }

    /**
     * Issue a token for a machine that cannot reach this server, under exactly
     * the online seat rules. The machine identifier is typed or pasted by a
     * person, so case and stray white space are forgiven.
     *
     * @param array{actor: string, ip?: ?string} $context
     * @return array{token: string, claims: array<string, mixed>, license: array<string, mixed>, reused: bool, activeSeats: int}
     */
    public function issueOffline(string $keyInput, string $machineInput, array $context): array
    {
        $machineId = Js::upper(Js::trim($machineInput));

        if (preg_match(self::MACHINE_ID_PATTERN, $machineId) !== 1) {
            throw new LicenseError(
                'invalid-machine',
                '"' . Js::trim($machineInput) . '" is not a RecoverX machine identifier. Ask the customer to copy it from the offline activation screen.',
            );
        }

        return $this->allocate($keyInput, $machineId, $context, 'offline');
    }

    /** @param array{actor: string, ip?: ?string} $context */
    private function allocate(string $keyInput, string $machineId, array $context, string $mode): array
    {
        $signer = $this->requireSigner();
        $key = self::canonicalKey($keyInput);
        $now = $this->now();

        try {
            return $this->store->transaction(function () use ($signer, $key, $machineId, $context, $mode, $now): array {
                $license = $this->store->getLicense($key);
                if ($license === null) {
                    throw new LicenseError('unknown-key', Messages::UNKNOWN_KEY);
                }

                self::assertUsable($license, $now);

                $existing = $this->store->getActivation($key, $machineId);
                $reused = $existing !== null && $existing['releasedAt'] === null;

                if ($reused) {
                    $this->store->touchSeat($key, $machineId, $now);
                } else {
                    $held = $this->store->countActiveSeats($key);

                    if ($license['maxActivations'] !== null && $held >= $license['maxActivations']) {
                        throw new LicenseError(
                            'seats-exhausted',
                            Messages::seatsExhausted($held),
                            "{$held}/{$license['maxActivations']} seats held",
                        );
                    }

                    $this->store->claimSeat($key, $machineId, $now);
                }

                // Built from the licence row as it stands now, inside this
                // transaction — never from the machine's previous token. That
                // is what makes re-activation the renewal path: after an
                // extension the same computer gets the new end date (and the
                // current edition and owner) without taking another seat.
                $claims = [
                    'v' => 1,
                    'edition' => $license['edition'],
                    'key' => $key,
                    'machine' => $machineId,
                    'issuedAt' => $now,
                    'expiresAt' => $license['expiresAt'],
                    'registeredTo' => $license['registeredTo'],
                ];

                $token = $signer->issue($claims);
                $activeSeats = $this->store->countActiveSeats($key);

                $type = $mode === 'offline' ? 'offline-issued' : ($reused ? 'reactivated' : 'activated');
                $this->audit($type, $key, $machineId, $context, $now, ['seats' => $activeSeats]);

                return [
                    'token' => $token,
                    'claims' => $claims,
                    'license' => $license,
                    'reused' => $reused,
                    'activeSeats' => $activeSeats,
                ];
            });
        } catch (\Throwable $error) {
            $this->auditRefusal($error, $key, $machineId, $context, $now);
            throw $error;
        }
    }

    /**
     * Release the seat named in an activation token — the customer moving
     * their licence off a computer themselves.
     *
     * The signature is checked but not the expiry, so a lapsed licence can
     * still give its seat back. Releasing a seat that is already free answers
     * `released: false` — before the allowance is looked at, so a retried
     * release can never turn into a refusal and is never counted. A release
     * past the self-service allowance is refused with `self-release-limit`
     * (409) and the seat stays held; the refusal is recorded and committed.
     * The count and the release share one `BEGIN IMMEDIATE` transaction.
     *
     * @param array{actor: string, ip?: ?string} $context
     * @return array{released: bool, key: string, machineId: string}
     */
    public function deactivate(string $token, array $context): array
    {
        $signer = $this->requireSigner();
        $check = $signer->verifySignature($token);

        if (!$check['ok']) {
            throw $check['failure'] === 'bad-signature'
                ? new LicenseError('forged-token', Messages::TOKEN_FORGED)
                : new LicenseError('invalid-token', Messages::TOKEN_UNREADABLE);
        }

        $claimedKey = (string) $check['claims']['key'];
        $key = LicenseKey::canonical($claimedKey) ?? $claimedKey;
        $machineId = (string) $check['claims']['machine'];
        $subject = ['key' => $key, 'machineId' => $machineId];
        $now = $this->now();

        $outcome = $this->store->transaction(function () use ($key, $machineId, $subject, $context, $now): array {
            $license = $this->store->getLicense($key);
            if ($license === null) {
                throw new LicenseError('unknown-key', Messages::TOKEN_LICENCE_MISSING, null, $subject);
            }

            $activation = $this->store->getActivation($key, $machineId);
            $held = $activation !== null && $activation['releasedAt'] === null;
            if (!$held) {
                $this->audit('deactivation-noop', $key, $machineId, $context, $now);

                return ['released' => false];
            }

            $allowance = $this->selfReleaseStanding($license, $now);
            if ($allowance['limit'] !== null && $allowance['recent'] >= $allowance['limit']) {
                // Committed rather than rolled back: the refusal is the event
                // support will be asked about.
                $this->audit('deactivation-refused', $key, $machineId, $context, $now, [
                    'reason' => 'self-release-limit',
                    'releases' => $allowance['recent'],
                    'limit' => $allowance['limit'],
                    'windowDays' => $allowance['windowDays'],
                ]);

                return [
                    'refused' => new LicenseError(
                        'self-release-limit',
                        $allowance['limit'] === 0
                            ? Messages::SELF_RELEASE_DISABLED
                            : Messages::selfReleaseLimit($allowance['recent'], $allowance['windowDays']),
                        "{$allowance['recent']}/{$allowance['limit']} self-service releases in {$allowance['windowDays']} days",
                        $subject,
                    ),
                ];
            }

            $released = $this->store->releaseSeat($key, $machineId, $now);
            $this->audit($released ? 'deactivated' : 'deactivation-noop', $key, $machineId, $context, $now);

            return ['released' => $released];
        });

        if (isset($outcome['refused'])) {
            throw $outcome['refused'];
        }

        return ['released' => $outcome['released'], 'key' => $key, 'machineId' => $machineId];
    }

    /**
     * How many self-service releases a licence has made in the current
     * window, and how many it may make.
     *
     * A licence with unlimited seats (Technician and Enterprise by default, or
     * one minted with unlimited seats) is never limited, whatever the limit —
     * `0` included: the cap bounds how far one seat can be stretched, and an
     * unlimited licence has no seat to stretch. Its releases are still counted
     * and shown, so support can see the pattern.
     *
     * @param array<string, mixed> $license
     * @return array{recent: int, limit: ?int, windowDays: int}
     */
    private function selfReleaseStanding(array $license, int $now): array
    {
        $recent = $this->store->countEventsAfter(
            $license['key'],
            'deactivated',
            Expiry::addDays($now, -$this->selfReleaseWindowDays),
        );

        return [
            'recent' => $recent,
            'limit' => $license['maxActivations'] === null ? null : $this->selfReleaseLimit,
            'windowDays' => $this->selfReleaseWindowDays,
        ];
    }

    // --- administration ---------------------------------------------------------------

    /**
     * Stop a licence from activating. Machines that already hold a token keep
     * working until it expires (tokens are verified offline); revoking twice
     * keeps the original date and reason.
     *
     * @param array{actor: string, ip?: ?string} $context
     * @return array<string, mixed>
     */
    public function revoke(string $keyInput, ?string $reason, array $context): array
    {
        $now = $this->now();

        return $this->store->transaction(function () use ($keyInput, $reason, $context, $now): array {
            $license = $this->requireLicense($keyInput);
            if ($license['revokedAt'] !== null) {
                return $license;
            }

            $trimmed = $reason === null ? '' : Js::trim($reason);
            $stored = $trimmed === '' ? null : self::sliceUtf16($trimmed, 500);

            $this->store->setRevocation($license['key'], $now, $stored);
            $this->audit('revoked', $license['key'], null, $context, $now, ['reason' => $stored]);

            return array_merge($license, ['revokedAt' => $now, 'revokeReason' => $stored]);
        });
    }

    /**
     * Undo a revocation, e.g. after a payment dispute is resolved in the
     * customer's favour.
     *
     * @param array{actor: string, ip?: ?string} $context
     * @return array<string, mixed>
     */
    public function restore(string $keyInput, array $context): array
    {
        $now = $this->now();

        return $this->store->transaction(function () use ($keyInput, $context, $now): array {
            $license = $this->requireLicense($keyInput);
            if ($license['revokedAt'] === null) {
                return $license;
            }

            $this->store->setRevocation($license['key'], null, null);
            $this->audit('restored', $license['key'], null, $context, $now, [
                'revokedAt' => $license['revokedAt'],
                'reason' => $license['revokeReason'],
            ]);

            return array_merge($license, ['revokedAt' => null, 'revokeReason' => null]);
        });
    }

    /**
     * Change when a licence ends. Machines pick up the new date the next time
     * they activate, because the expiry travels inside the token.
     *
     * @param array{actor: string, ip?: ?string} $context
     * @return array<string, mixed>
     */
    public function extend(string $keyInput, mixed $change, array $context): array
    {
        [$issues, $parsed] = self::parseExtend($change);
        if ($issues !== []) {
            throw LicenseError::invalidArgument(Validator::format($issues));
        }

        $now = $this->now();

        return $this->store->transaction(function () use ($keyInput, $parsed, $context, $now): array {
            $license = $this->requireLicense($keyInput);
            $expiresAt = Expiry::resolveExtension(
                $parsed['expires'],
                $parsed['days'],
                $parsed['perpetual'] === true,
                $license['expiresAt'],
                $now,
            );

            $this->store->setExpiry($license['key'], $expiresAt);
            $this->audit('extended', $license['key'], null, $context, $now, [
                'from' => $license['expiresAt'],
                'to' => $expiresAt,
            ]);

            return array_merge($license, ['expiresAt' => $expiresAt]);
        });
    }

    /**
     * Free one machine's seat — for a customer whose computer died, or who has
     * used up the self-service allowance. Neither limited by nor counted
     * against that allowance: this is the support route its refusal points to.
     *
     * @param array{actor: string, ip?: ?string} $context
     */
    public function release(string $keyInput, string $machineInput, array $context): bool
    {
        $now = $this->now();
        $machineId = Js::upper(Js::trim($machineInput));

        return $this->store->transaction(function () use ($keyInput, $machineId, $context, $now): bool {
            $license = $this->requireLicense($keyInput);
            $released = $this->store->releaseSeat($license['key'], $machineId, $now);

            if (!$released && $this->store->getActivation($license['key'], $machineId) === null) {
                throw new LicenseError(
                    'not-found',
                    "Licence {$license['key']} has never been activated on machine {$machineId}.",
                );
            }

            if ($released) {
                $this->audit('seat-released', $license['key'], $machineId, $context, $now);
            }

            return $released;
        });
    }

    /**
     * Free every seat a licence holds; returns how many were held. Like
     * `release`, outside the self-service allowance and never counted.
     *
     * @param array{actor: string, ip?: ?string} $context
     */
    public function resetSeats(string $keyInput, array $context): int
    {
        $now = $this->now();

        return $this->store->transaction(function () use ($keyInput, $context, $now): int {
            $license = $this->requireLicense($keyInput);
            $released = $this->store->releaseAllSeats($license['key'], $now);

            $this->audit('seats-reset', $license['key'], null, $context, $now, ['released' => $released]);

            return $released;
        });
    }

    // --- personal details -------------------------------------------------------
    //
    // What the privacy policy promises a customer — to correct their details,
    // to have them deleted — done from the admin panel. Neither is recorded in
    // the licence's history, whose event types are the reference server's; the
    // panel writes each to the request log instead.

    /**
     * Validate a change of personal details: who a licence is registered to,
     * their e-mail, the vendor's notes. Absent, `null` or empty clears one.
     *
     * @return array{0: list<array{0: string, 1: string}>, 1: array{registeredTo: ?string, email: ?string, notes: ?string}}
     */
    public static function parseDetails(mixed $input): array
    {
        $v = new Validator($input);
        $parsed = [
            'registeredTo' => $v->optionalText('registeredTo', 200),
            'email' => $v->email('email', 254),
            'notes' => $v->optionalText('notes', 2000),
        ];

        return [$v->finish(), $parsed];
    }

    /**
     * Replace a licence's personal details with corrected ones. Computers show
     * the new name from their next activation, as after any other change.
     *
     * @return array<string, mixed> the licence as it now stands
     */
    public function updateDetails(string $keyInput, mixed $input): array
    {
        [$issues, $details] = self::parseDetails($input);
        if ($issues !== []) {
            throw LicenseError::invalidArgument(Validator::format($issues));
        }

        return $this->store->transaction(function () use ($keyInput, $details): array {
            $key = $this->requireLicense($keyInput)['key'];
            $this->store->setDetails($key, $details['registeredTo'], $details['email'], $details['notes']);

            return $this->requireLicense($key);
        });
    }

    /**
     * Erase what a licence holds about a person: the name, e-mail and notes,
     * and the addresses in its history.
     *
     * The key, edition, dates, computers and what happened when all stay, so
     * the licence keeps working and support can still read its history. So
     * does the order reference, while the law needs the sale to be traceable
     * (`RECORDS_KEPT_DAYS` after the licence ended); erased after that, it
     * goes too, and nothing personal is left.
     *
     * @return array{license: array<string, mixed>, addresses: int, orderRefErased: bool, orders: int}
     */
    public function erasePersonalDetails(string $keyInput): array
    {
        $now = $this->now();

        return $this->store->transaction(function () use ($keyInput, $now): array {
            $license = $this->requireLicense($keyInput);
            $key = $license['key'];

            $this->store->setDetails($key, null, null, null);
            $addresses = $this->store->eraseEventAddresses($key);
            // The website order behind the licence holds the same person's details.
            $orders = $license['orderRef'] === null ? 0 : $this->store->deleteOrdersByRef($license['orderRef']);

            $endedAt = self::endedAt($license);
            $orderRefErased = $license['orderRef'] !== null && $endedAt !== null
                && $now >= Expiry::addDays($endedAt, self::RECORDS_KEPT_DAYS);
            if ($orderRefErased) {
                $this->store->clearOrderRef($key);
            }

            return ['license' => $this->requireLicense($key), 'addresses' => $addresses, 'orderRefErased' => $orderRefErased, 'orders' => $orders];
        });
    }

    /**
     * When a licence stops, or stopped, being usable — revoked, or at the end
     * of its term — or `null` for one that is neither, which never stops.
     *
     * @param array<string, mixed> $license
     */
    private static function endedAt(array $license): ?int
    {
        $ends = array_filter([$license['revokedAt'], $license['expiresAt']], static fn (mixed $at): bool => is_int($at));

        return $ends === [] ? null : min($ends);
    }

    /**
     * @param array{edition?: ?string, search?: ?string, orderRef?: ?string, standing?: ?string, limit?: ?int, offset?: ?int} $options
     * @return list<array<string, mixed>>
     */
    public function list(array $options = []): array
    {
        return $this->store->listLicenses([
            'edition' => $options['edition'] ?? null,
            'search' => $options['search'] ?? null,
            'orderRef' => $options['orderRef'] ?? null,
            'standing' => $options['standing'] ?? null,
            'now' => $this->now(),
            'limit' => min(max($options['limit'] ?? 50, 1), 1000),
            'offset' => max($options['offset'] ?? 0, 0),
        ]);
    }

    /** @return array{license: array<string, mixed>, standing: string, activeSeats: int, selfReleases: array{recent: int, limit: ?int, windowDays: int}, activations: list<array<string, mixed>>, events: list<array<string, mixed>>} */
    public function show(string $keyInput): array
    {
        $license = $this->requireLicense($keyInput);
        $activations = $this->store->listActivations($license['key']);
        $now = $this->now();

        return [
            'license' => $license,
            'standing' => self::standingOf($license, $now),
            'activeSeats' => count(array_filter($activations, static fn (array $a): bool => $a['releasedAt'] === null)),
            'selfReleases' => $this->selfReleaseStanding($license, $now),
            'activations' => $activations,
            'events' => $this->store->listEvents($license['key'], self::SHOWN_EVENTS),
        ];
    }

    /**
     * Note in a licence's history that its key was e-mailed to the customer.
     * The address itself is not repeated in the history: it is on the
     * licence, where erasing personal details finds it.
     *
     * @param array{actor: string, ip?: ?string} $context
     */
    public function recordKeyEmailed(string $keyInput, string $messageId, array $context): void
    {
        $license = $this->requireLicense($keyInput);
        $this->audit('key-emailed', $license['key'], null, $context, $this->now(), ['messageId' => $messageId]);
    }

    // --- helpers ------------------------------------------------------------------------

    /** Validate and canonicalise a customer-supplied key, or refuse it in their terms. */
    public static function canonicalKey(string $input): string
    {
        $validation = LicenseKey::validate($input);
        if (!$validation['ok'] || $validation['key'] === null) {
            throw new LicenseError('invalid-key', Messages::describeKeyProblem($validation['problem']));
        }

        return $validation['key'];
    }

    /** @param array<string, mixed> $license */
    public static function standingOf(array $license, int $now): string
    {
        if ($license['revokedAt'] !== null) {
            return 'revoked';
        }

        if ($license['expiresAt'] !== null && $license['expiresAt'] <= $now) {
            return 'expired';
        }

        return 'active';
    }

    /** A licence key safe to write to a log line. */
    public static function logSafeKey(string $input): string
    {
        $key = LicenseKey::canonical($input);

        return $key === null ? '(malformed)' : LicenseKey::mask($key);
    }

    private function requireSigner(): TokenSigner
    {
        if ($this->signer === null) {
            throw new \RuntimeException('No signing key is configured. Run /setup/ first.');
        }

        return $this->signer;
    }

    /**
     * Find a licence for an administrative operation, with operator-facing
     * errors.
     *
     * @return array<string, mixed>
     */
    private function requireLicense(string $keyInput): array
    {
        $validation = LicenseKey::validate($keyInput);
        if (!$validation['ok'] || $validation['key'] === null) {
            throw LicenseError::invalidArgument(
                '"' . Js::trim($keyInput) . '" is not a well-formed licence key: ' . Messages::describeKeyProblem($validation['problem']),
            );
        }

        $license = $this->store->getLicense($validation['key']);
        if ($license === null) {
            throw new LicenseError('not-found', "No licence with key {$validation['key']} exists.");
        }

        return $license;
    }

    /** @param array<string, mixed> $license */
    private static function assertUsable(array $license, int $now): void
    {
        switch (self::standingOf($license, $now)) {
            case 'revoked':
                throw new LicenseError('revoked', Messages::REVOKED);
            case 'expired':
                throw new LicenseError('expired', Messages::expired(Messages::formatCustomerDate($license['expiresAt'] ?? $now)));
        }
    }

    /**
     * @param array{actor: string, ip?: ?string} $context
     * @param array<string, mixed> $detail
     */
    private function audit(string $type, ?string $key, ?string $machineId, array $context, int $now, array $detail = []): void
    {
        $this->store->recordEvent([
            'at' => $now,
            'type' => $type,
            'key' => $key,
            'machineId' => $machineId,
            'ip' => $context['ip'] ?? null,
            'detail' => json_encode(['actor' => $context['actor']] + $detail, TokenSigner::JSON_FLAGS | JSON_THROW_ON_ERROR),
        ]);
    }

    /**
     * Record why a known licence was refused, after the transaction rolled
     * back so the record is not lost with it.
     *
     * Unknown and malformed keys are not recorded (anyone with a loop could
     * fill the database; the request log has them). Nor is a lapsed term
     * refused to a computer that still holds one of its seats: that is the
     * application asking whether the licence has been renewed, at start-up
     * and on "Check for renewal", and one row per launch would bury the
     * history support reads.
     *
     * @param array{actor: string, ip?: ?string} $context
     */
    private function auditRefusal(\Throwable $error, string $key, string $machineId, array $context, int $now): void
    {
        if (!$error instanceof LicenseError) {
            return;
        }

        if ($error->refusal === 'unknown-key' || $error->refusal === 'invalid-key') {
            return;
        }

        try {
            if ($error->refusal === 'expired' && $this->holdsSeat($key, $machineId)) {
                return;
            }

            $this->audit('activation-refused', $key, $machineId, $context, $now, ['reason' => $error->refusal]);
        } catch (\Throwable) {
            // The refusal is what the caller needs; a failed audit write must
            // not replace it with a database error.
        }
    }

    private function holdsSeat(string $key, string $machineId): bool
    {
        $activation = $this->store->getActivation($key, $machineId);

        return $activation !== null && $activation['releasedAt'] === null;
    }

    /** `text.slice(0, $units)` in UTF-16 code units, never splitting a character. */
    private static function sliceUtf16(string $text, int $units): string
    {
        if (Js::length($text) <= $units) {
            return $text;
        }

        $result = '';
        $used = 0;
        foreach (Js::characters($text) as $character) {
            $width = strlen($character) === 4 ? 2 : 1;
            if ($used + $width > $units) {
                break;
            }
            $result .= $character;
            $used += $width;
        }

        return $result;
    }
}

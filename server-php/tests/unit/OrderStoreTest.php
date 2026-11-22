<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\Store;

/* The orders table: what the website's order form stores and the admin panel lists, follows up and deletes. */

/** An order as OrderForm::parse returns it. */
function anOrder(array $overrides = []): array
{
    return $overrides + [
        'edition' => 'professional',
        'quantity' => 1,
        'name' => 'Asha Rao',
        'email' => 'asha@example.com',
        'phoneCountry' => 'IN',
        'phone' => '+91 9876543210',
        'registerTo' => '',
        'gstin' => '',
        'message' => '',
    ];
}

/** @return list<string> the references of a listing, in its order */
function refsOf(array $orders): array
{
    return array_map(static fn (array $order): string => $order['ref'], $orders);
}

/** A store whose order references come from a script, to make them collide. */
final class ScriptedRefStore extends Store
{
    /** @var list<string> */
    public array $refs = [];

    protected function newOrderRef(): string
    {
        return array_shift($this->refs) ?? 'RX-FFFFFFFF';
    }
}

test('stores an order under a fresh reference and reads it back', function (): void {
    $store = Kit::fixture()['store'];
    $saved = $store->insertOrder(anOrder(['registerTo' => 'Rao & Sons', 'gstin' => '22AAAAA0000A1Z5', 'message' => "Line one\nLine two"]), '203.0.113.7', Kit::NOW);
    Assert::matches('/^RX-[0-9A-F]{8}$/D', $saved['ref']);
    Assert::same(1, $saved['id']);

    Assert::same([
        'id' => 1,
        'ref' => $saved['ref'],
        'createdAt' => Kit::NOW,
        'updatedAt' => Kit::NOW,
        'status' => 'new',
        'edition' => 'professional',
        'quantity' => 1,
        'name' => 'Asha Rao',
        'email' => 'asha@example.com',
        'phone' => '+91 9876543210',
        'phoneCountry' => 'IN',
        'registerTo' => 'Rao & Sons',
        'gstin' => '22AAAAA0000A1Z5',
        'message' => "Line one\nLine two",
        'ip' => '203.0.113.7',
        'notes' => null,
        'mailedAt' => null,
    ], $store->getOrder(1));
    Assert::same(null, $store->getOrder(2));

    $store->markOrderMailed(1, Kit::NOW + 5);
    Assert::same(Kit::NOW + 5, $store->getOrder(1)['mailedAt']);

    // A private table: the schema version the Node server checks is unchanged.
    Assert::same(Store::SCHEMA_VERSION, (int) $store->pdo->query('PRAGMA user_version')->fetchColumn());
});

test('draws the reference again when the one it drew is taken', function (): void {
    $store = ScriptedRefStore::open(Kit::tempDir() . '/licences.db');
    $store->refs = ['RX-0000000A', 'RX-0000000A', 'RX-0000000B'];
    Assert::same(['id' => 1, 'ref' => 'RX-0000000A'], $store->insertOrder(anOrder(), null, Kit::NOW));
    Assert::same(['id' => 2, 'ref' => 'RX-0000000B'], $store->insertOrder(anOrder(), null, Kit::NOW));

    // A reference that keeps colliding is a fault, not bad luck: it gives up.
    $store->refs = array_fill(0, 10, 'RX-0000000A');
    Assert::throws(\PDOException::class, static fn () => $store->insertOrder(anOrder(), null, Kit::NOW), '/UNIQUE/');
    Assert::same(5, 10 - count($store->refs), 'five draws');
    Assert::same(2, (int) $store->pdo->query('SELECT COUNT(*) FROM orders')->fetchColumn());
});

test('lists orders newest first, by status and by search, a page at a time', function (): void {
    $store = Kit::fixture()['store'];
    $a = $store->insertOrder(anOrder(['name' => 'Asha Rao']), null, Kit::NOW)['ref'];
    $b = $store->insertOrder(anOrder(['name' => 'Ben 100% Sure', 'email' => 'ben@example.com', 'phone' => '+1 5551234567', 'phoneCountry' => 'US']), null, Kit::NOW + 1)['ref'];
    $c = $store->insertOrder(anOrder(['name' => 'Chitra', 'email' => 'c_k@example.com', 'registerTo' => 'Chitra Studio', 'gstin' => '29ABCDE1234F1Z5']), null, Kit::NOW + 2)['ref'];
    $d = $store->insertOrder(anOrder(['name' => 'Dev', 'email' => 'cxk@example.com']), null, Kit::NOW + 2)['ref'];

    $list = static fn (array $filter): array => refsOf($store->listOrders($filter + ['limit' => 50, 'offset' => 0]));

    Assert::same([$d, $c, $b, $a], $list([]), 'newest first; the same instant by id');
    Assert::same([$d, $c], $list(['limit' => 2]));
    Assert::same([$b, $a], $list(['limit' => 2, 'offset' => 2]));

    Assert::same([$b], $list(['search' => 'ben 100']), 'name, case-insensitively');
    Assert::same([$b], $list(['search' => '100%']), 'a % is a percent sign, not a wildcard');
    Assert::same([], $list(['search' => '0%S']));
    Assert::same([$c], $list(['search' => 'c_k']), 'an _ is an underscore, not a wildcard');
    Assert::same([], $list(['search' => 'c\\k']));
    Assert::same([$c], $list(['search' => 'chitra studio']), 'register to');
    Assert::same([$c], $list(['search' => '29ABCDE']), 'GSTIN');
    Assert::same([$a], $list(['search' => substr($a, 3)]), 'reference');
    Assert::same([$b], $list(['search' => '+1 555']), 'mobile as stored');
    Assert::same([$b], $list(['search' => '(555) 123-4567']), 'mobile as typed, whatever its spacing');
    Assert::same([$d, $c, $a], $list(['search' => '98765 43210']));

    $store->updateOrder(2, 'paid', null, Kit::NOW + 10);
    Assert::same([$b], $list(['status' => 'paid']));
    Assert::same([$d, $c, $a], $list(['status' => 'new']));
    Assert::same([$a], $list(['status' => 'new', 'search' => 'asha']));
    Assert::same([], $list(['status' => 'cancelled']));
});

test('counts orders by status, every status listed', function (): void {
    $store = Kit::fixture()['store'];
    Assert::same(['new' => 0, 'contacted' => 0, 'paid' => 0, 'licensed' => 0, 'cancelled' => 0], $store->countOrdersByStatus());
    Assert::same(['new', 'contacted', 'paid', 'licensed', 'cancelled'], array_keys(Store::ORDER_STATUSES));
    Assert::same('Licence sent', Store::ORDER_STATUSES['licensed']);

    for ($i = 0; $i < 4; $i++) {
        $store->insertOrder(anOrder(), null, Kit::NOW);
    }
    $store->updateOrder(1, 'contacted', null, Kit::NOW);
    $store->updateOrder(2, 'cancelled', null, Kit::NOW);
    Assert::same(['new' => 2, 'contacted' => 1, 'paid' => 0, 'licensed' => 0, 'cancelled' => 1], $store->countOrdersByStatus());
});

test('updates the status and notes, and marks an open order licensed by its reference', function (): void {
    $store = Kit::fixture()['store'];
    $ref = $store->insertOrder(anOrder(), null, Kit::NOW)['ref'];

    Assert::same(true, $store->updateOrder(1, 'contacted', "Called on Monday.\nPays by UPI.", Kit::NOW + 60_000));
    $order = $store->getOrder(1);
    Assert::same(['contacted', "Called on Monday.\nPays by UPI.", Kit::NOW + 60_000, Kit::NOW], [$order['status'], $order['notes'], $order['updatedAt'], $order['createdAt']]);
    Assert::same(false, $store->updateOrder(99, 'paid', null, Kit::NOW), 'no such order');
    Assert::throws(\InvalidArgumentException::class, static fn () => $store->updateOrder(1, 'shipped', null, Kit::NOW));

    Assert::same(true, $store->markOrderLicensed($ref, Kit::NOW + 120_000));
    Assert::same(['licensed', Kit::NOW + 120_000], [$store->getOrder(1)['status'], $store->getOrder(1)['updatedAt']]);
    Assert::same(false, $store->markOrderLicensed($ref, Kit::NOW + 180_000), 'already licensed');
    Assert::same(false, $store->markOrderLicensed('RX-00000000', Kit::NOW), 'no such reference');

    foreach (['new' => true, 'paid' => true, 'cancelled' => false, 'licensed' => false] as $status => $moves) {
        $store->updateOrder(1, $status, null, Kit::NOW);
        Assert::same($moves, $store->markOrderLicensed($ref, Kit::NOW + 1), $status);
        Assert::same($moves ? 'licensed' : $status, $store->getOrder(1)['status'], $status);
    }
});

test('deletes one order, or every order unchanged since a cutoff', function (): void {
    $store = Kit::fixture()['store'];
    $store->insertOrder(anOrder(), null, Kit::NOW - 800 * Kit::DAY);
    $store->insertOrder(anOrder(), null, Kit::NOW - 800 * Kit::DAY);
    $store->insertOrder(anOrder(), null, Kit::NOW - 730 * Kit::DAY);
    $store->insertOrder(anOrder(), null, Kit::NOW);
    // Changed recently, so kept although received long ago.
    $store->updateOrder(2, 'paid', null, Kit::NOW - Kit::DAY);

    Assert::same(true, $store->deleteOrder(4));
    Assert::same(false, $store->deleteOrder(4));
    Assert::same(null, $store->getOrder(4));

    Assert::same(1, $store->deleteOrdersBefore(Kit::NOW - 730 * Kit::DAY));
    Assert::same([2, 3], array_map('intval', $store->pdo->query('SELECT id FROM orders ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN)));
    Assert::same(0, $store->deleteOrdersBefore(Kit::NOW - 730 * Kit::DAY));
});

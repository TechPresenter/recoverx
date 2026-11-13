<?php

declare(strict_types=1);

namespace RecoverX\Licensing\Tests;

use RecoverX\Licensing\Authority;
use RecoverX\Licensing\Js;
use RecoverX\Licensing\Validator;

/*
 * Validation explains itself the way zod does on the reference server, so an
 * operator reading a 400 from either server sees the same words.
 */

function createIssues(string $json): string
{
    [$issues] = Authority::parseCreate(json_decode($json, false));

    return Validator::format($issues);
}

test('explains create-request problems in the reference server’s words', function (): void {
    Assert::same('edition: Invalid option: expected one of "free"|"professional"|"business"|"technician"|"enterprise"', createIssues('{"edition":"x"}'));
    Assert::same('count: Too small: expected number to be >=1', createIssues('{"edition":"professional","count":0}'));
    Assert::same('count: Too big: expected number to be <=1000', createIssues('{"edition":"professional","count":1001}'));
    Assert::same('count: Invalid input: expected int, received number', createIssues('{"edition":"professional","count":1.5}'));
    Assert::same('count: Invalid input: expected number, received string', createIssues('{"edition":"professional","count":"2"}'));
    Assert::same('email: Invalid email address', createIssues('{"edition":"professional","email":"nope"}'));
    Assert::same('<root>: Unrecognized keys: "registered_to", "foo"', createIssues('{"edition":"professional","registered_to":"a","foo":1}'));
    Assert::same('<root>: Unrecognized key: "registered_to"', createIssues('{"edition":"professional","registered_to":"a"}'));
    Assert::same('seats: Too small: expected number to be >=1', createIssues('{"edition":"professional","seats":0}'));
    Assert::same('expires: Invalid input: expected string, received number', createIssues('{"edition":"professional","expires":5}'));
    Assert::same('<root>: Invalid input: expected object, received array', createIssues('[]'));
    Assert::same('<root>: Invalid input: expected object, received null', createIssues('null'));
    Assert::same('', createIssues('{"edition":"business","count":2,"seats":null,"days":365,"registeredTo":" Contoso ","email":"it@contoso.example","orderRef":"","notes":null}'));
});

test('treats null, absent and blank optional text alike, and trims it', function (): void {
    [, $parsed] = Authority::parseCreate(json_decode('{"edition":"business","registeredTo":"  Contoso  ","orderRef":"   ","notes":null,"seats":null}', false));

    Assert::same('Contoso', $parsed['registeredTo']);
    Assert::same(null, $parsed['orderRef']);
    Assert::same(null, $parsed['notes']);
    Assert::same(true, $parsed['seatsGiven']);
    Assert::same(null, $parsed['seats']);
});

test('counts string lengths in UTF-16 units, after trimming', function (): void {
    [$issues] = Authority::parseCreate(json_decode('{"edition":"business","registeredTo":"' . str_repeat('😀', 100) . '"}', false));
    Assert::same('', Validator::format($issues), '100 emoji are 200 units, the limit');

    [$issues] = Authority::parseCreate(json_decode('{"edition":"business","registeredTo":"' . str_repeat('😀', 100) . 'a"}', false));
    Assert::same('registeredTo: Too big: expected string to have <=200 characters', Validator::format($issues));
});

test('coerces query parameters the way Number() does', function (): void {
    $v = Validator::forQuery(['limit' => 'zero', 'offset' => '', 'colour' => 'red']);
    $v->coercedInt('limit', 1, 1000);
    $v->coercedInt('offset', 0, null);
    Assert::same('limit: Invalid input: expected number, received NaN; <root>: Unrecognized key: "colour"', Validator::format($v->finish()));

    $v = Validator::forQuery(['limit' => '0x10']);
    Assert::same(16, $v->coercedInt('limit', 1, 1000));

    Assert::same(0.0, Js::number(' '));
    Assert::same(100.0, Js::number('1e2'));
    Assert::same(null, Js::number('12px'));
    Assert::same(INF, Js::number('Infinity'));
});

test('JavaScript string helpers match their built-ins', function (): void {
    Assert::same('abc', Js::trim("\u{FEFF}\u{00A0} abc \u{3000}\n"));
    Assert::same("\u{0085}abc", Js::trim("\u{0085}abc"), 'NEL is not JavaScript white space');
    Assert::same(2, Js::length('😀'));
    Assert::same(1, Js::length('é'));
    Assert::same('number', Js::typeName(1.5));
    Assert::same('NaN', Js::typeName(NAN));
});

test('formats at most eight issues', function (): void {
    $issues = array_map(static fn (int $i): array => ["f{$i}", 'bad'], range(1, 10));
    Assert::same(8, substr_count(Validator::format($issues), 'bad'));
});

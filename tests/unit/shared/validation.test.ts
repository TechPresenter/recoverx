import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ALLOWED_EXTERNAL_HOSTS, APP_ID, APP_NAME, LICENSE_EDITIONS } from '@shared/constants/app'
import { APP_ROUTE_ORDER, AppRoute, isAppRoutePath } from '@shared/constants/routes'
import { ErrorCode } from '@shared/utils/errors'
import {
  assertNever,
  clamp,
  isDefined,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
  typedEntries,
  typedKeys,
} from '@shared/utils/guards'
import { formatZodIssues, parseJson, parseValue, stringifyJson } from '@shared/utils/json'

const PointSchema = z.object({ x: z.number(), y: z.number() })

describe('parseJson', () => {
  it('decodes and validates in one step', () => {
    const result = parseJson('{"x":1,"y":2}', PointSchema)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ x: 1, y: 2 })
  })

  it('rejects malformed JSON without throwing', () => {
    // A truncated settings row, or a log line torn by rotation.
    const result = parseJson('{"x":1,', PointSchema)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.Validation)
      expect(result.error.message).toContain('not valid JSON')
    }
  })

  it('rejects well-formed JSON of the wrong shape', () => {
    const result = parseJson('{"x":"one","y":2}', PointSchema)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.details).toContain('x')
  })

  it('truncates an oversized value in the error detail', () => {
    const result = parseJson('!'.repeat(500), PointSchema)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.details?.length).toBeLessThan(200)
      expect(result.error.details).toContain('…')
    }
  })

  it('round-trips with stringifyJson', () => {
    const result = parseJson(stringifyJson({ x: 3, y: 4 }), PointSchema)

    expect(result.ok).toBe(true)
  })
})

describe('parseValue', () => {
  it('validates an already-decoded value', () => {
    expect(parseValue({ x: 1, y: 2 }, PointSchema).ok).toBe(true)
  })

  it('reports a validation failure as a Result', () => {
    const result = parseValue({ x: 1 }, PointSchema)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.Validation)
  })
})

describe('formatZodIssues', () => {
  it('collapses issues into one compact, log-safe line', () => {
    const formatted = formatZodIssues([
      { path: ['settings', 'theme'], message: 'Invalid option' },
      { path: [], message: 'Root problem' },
    ])

    expect(formatted).toBe('settings.theme: Invalid option; <root>: Root problem')
  })

  it('caps the number of issues so a log line stays bounded', () => {
    const issues = Array.from({ length: 30 }, (_, index) => ({
      path: [`field${index}`],
      message: 'bad',
    }))

    expect(formatZodIssues(issues).split(';')).toHaveLength(8)
  })
})

describe('type guards', () => {
  it('isDefined filters out null and undefined', () => {
    expect([1, null, 2, undefined, 3].filter(isDefined)).toEqual([1, 2, 3])
  })

  it('isNonEmptyString rejects blank strings', () => {
    expect(isNonEmptyString('a')).toBe(true)
    expect(isNonEmptyString('')).toBe(false)
    expect(isNonEmptyString('   ')).toBe(false)
    expect(isNonEmptyString(1)).toBe(false)
  })

  it('isFiniteNumber rejects NaN and infinities', () => {
    expect(isFiniteNumber(0)).toBe(true)
    expect(isFiniteNumber(Number.NaN)).toBe(false)
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isFiniteNumber('1')).toBe(false)
  })

  it('isPlainObject excludes arrays, null and class instances', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
  })

  it('clamp bounds a value and maps NaN to the minimum', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(Number.NaN, 3, 10)).toBe(3)
  })

  it('assertNever throws when an unhandled union member reaches it', () => {
    expect(() => assertNever('surprise' as never, 'level')).toThrow(/Unhandled level/)
  })

  it('typedKeys and typedEntries preserve key types', () => {
    const value = { a: 1, b: 2 }

    expect(typedKeys(value)).toEqual(['a', 'b'])
    expect(typedEntries(value)).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })
})

describe('application constants', () => {
  it('uses a reverse-DNS application id', () => {
    expect(APP_ID).toMatch(/^[a-z]+(\.[a-z]+)+$/)
    expect(APP_NAME.length).toBeGreaterThan(0)
  })

  it('allowlists only bare hostnames, never URLs or wildcards', () => {
    // A scheme or path here would silently never match a parsed hostname.
    for (const host of ALLOWED_EXTERNAL_HOSTS) {
      expect(host).not.toContain('/')
      expect(host).not.toContain('*')
      expect(host).toBe(host.toLowerCase())
    }
  })

  it('declares the commercial editions', () => {
    expect(LICENSE_EDITIONS).toContain('free')
    expect(LICENSE_EDITIONS).toContain('professional')
    expect(new Set(LICENSE_EDITIONS).size).toBe(LICENSE_EDITIONS.length)
  })
})

describe('routes', () => {
  it('lists every declared route exactly once', () => {
    expect([...APP_ROUTE_ORDER].sort()).toEqual(Object.values(AppRoute).sort())
    expect(new Set(APP_ROUTE_ORDER).size).toBe(APP_ROUTE_ORDER.length)
  })

  it('recognises declared paths and rejects anything else', () => {
    expect(isAppRoutePath('/settings')).toBe(true)
    expect(isAppRoutePath('/')).toBe(true)
    expect(isAppRoutePath('/scan')).toBe(true)
    // A route that has not shipped yet must still be rejected.
    expect(isAppRoutePath('/recovery')).toBe(false)
    expect(isAppRoutePath('settings')).toBe(false)
  })
})

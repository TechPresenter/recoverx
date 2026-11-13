import { describe, expect, it } from 'vitest'
import {
  AppError,
  ErrorCode,
  describeUnknown,
  isAppError,
  isSerializedError,
  toSerializedError,
} from '@shared/utils/errors'
import { err, errFrom, isErr, isOk, mapResult, ok, unwrapOr } from '@shared/utils/result'

describe('AppError', () => {
  it('carries a machine-readable code and a user-facing message', () => {
    const error = new AppError(ErrorCode.PermissionDenied, 'That folder cannot be written to')

    expect(error.code).toBe(ErrorCode.PermissionDenied)
    expect(error.message).toBe('That folder cannot be written to')
    expect(error.name).toBe('AppError')
    expect(error).toBeInstanceOf(Error)
  })

  it('infers retryability from the code', () => {
    // Transient conditions are worth another attempt; a validation failure is not.
    expect(new AppError(ErrorCode.Io, 'read failed').retryable).toBe(true)
    expect(new AppError(ErrorCode.Timeout, 'timed out').retryable).toBe(true)
    expect(new AppError(ErrorCode.Database, 'locked').retryable).toBe(true)
    expect(new AppError(ErrorCode.Validation, 'bad input').retryable).toBe(false)
    expect(new AppError(ErrorCode.PermissionDenied, 'denied').retryable).toBe(false)
  })

  it('lets an explicit retryable flag override the inference', () => {
    expect(new AppError(ErrorCode.Io, 'gone', { retryable: false }).retryable).toBe(false)
    expect(new AppError(ErrorCode.Validation, 'x', { retryable: true }).retryable).toBe(true)
  })

  it('preserves the cause for logging', () => {
    const cause = new Error('ENOENT')
    const error = new AppError(ErrorCode.NotFound, 'missing', { cause })

    expect(error.cause).toBe(cause)
  })

  it('serialises to plain data that survives structured cloning', () => {
    const serialized = new AppError(ErrorCode.Database, 'corrupt', {
      details: 'quick_check failed',
    }).toSerialized()

    expect(serialized).toEqual({
      code: ErrorCode.Database,
      message: 'corrupt',
      details: 'quick_check failed',
      retryable: true,
    })
    expect(() => structuredClone(serialized)).not.toThrow()
  })
})

describe('toSerializedError', () => {
  it('passes an AppError through with its code intact', () => {
    const result = toSerializedError(new AppError(ErrorCode.Cancelled, 'user cancelled'))

    expect(result.code).toBe(ErrorCode.Cancelled)
    expect(result.message).toBe('user cancelled')
  })

  it('classifies a plain Error as unknown and keeps its message', () => {
    const result = toSerializedError(new TypeError('x is not a function'))

    expect(result.code).toBe(ErrorCode.Unknown)
    expect(result.message).toBe('x is not a function')
    expect(result.details).toBe('TypeError')
  })

  it('never leaks a stack trace across the boundary', () => {
    // A stack contains absolute filesystem paths, which would end up in
    // user-submitted screenshots.
    const result = toSerializedError(new Error('boom'))

    expect(JSON.stringify(result)).not.toContain('.ts:')
    expect('stack' in result).toBe(false)
  })

  it('accepts a bare string', () => {
    expect(toSerializedError('something broke').message).toBe('something broke')
  })

  it('falls back for values that carry no message at all', () => {
    expect(toSerializedError(null).message).toBe('Unexpected error')
    expect(toSerializedError(undefined).message).toBe('Unexpected error')
    expect(toSerializedError('').message).toBe('Unexpected error')
    expect(toSerializedError({}, 'custom fallback').message).toBe('custom fallback')
  })

  it('is idempotent over an already-serialised error', () => {
    const once = toSerializedError(new AppError(ErrorCode.Io, 'disk'))

    expect(toSerializedError(once)).toEqual(once)
  })
})

describe('error guards', () => {
  it('identifies AppError instances', () => {
    expect(isAppError(new AppError(ErrorCode.Unknown, 'x'))).toBe(true)
    expect(isAppError(new Error('x'))).toBe(false)
    expect(isAppError('x')).toBe(false)
  })

  it('identifies the plain serialised shape', () => {
    expect(isSerializedError({ code: 'IO', message: 'x' })).toBe(true)
    expect(isSerializedError({ code: 'IO' })).toBe(false)
    expect(isSerializedError(null)).toBe(false)
    expect(isSerializedError('IO')).toBe(false)
  })
})

describe('describeUnknown', () => {
  it('extracts a printable message from any thrown value', () => {
    expect(describeUnknown(new Error('failed'))).toBe('failed')
    expect(describeUnknown('failed')).toBe('failed')
    expect(describeUnknown(42)).toBe('42')
    expect(describeUnknown(true)).toBe('true')
    expect(describeUnknown({ a: 1 })).toBe('unknown error')
    expect(describeUnknown(null)).toBe('unknown error')
  })
})

describe('Result', () => {
  it('builds and narrows the success branch', () => {
    const result = ok(42)

    expect(isOk(result)).toBe(true)
    expect(isErr(result)).toBe(false)
    if (result.ok) expect(result.data).toBe(42)
  })

  it('builds and narrows the failure branch', () => {
    const result = err<number>({
      code: ErrorCode.NotFound,
      message: 'gone',
      details: undefined,
      retryable: false,
    })

    expect(isErr(result)).toBe(true)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.NotFound)
  })

  it('wraps a thrown value', () => {
    const result = errFrom<string>(new AppError(ErrorCode.Timeout, 'too slow'))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.Timeout)
  })

  it('unwraps with a fallback', () => {
    expect(unwrapOr(ok(7), 0)).toBe(7)
    expect(unwrapOr(errFrom<number>('nope'), 0)).toBe(0)
  })

  it('maps a success and passes a failure through untouched', () => {
    expect(
      unwrapOr(
        mapResult(ok(2), (n) => n * 3),
        0,
      ),
    ).toBe(6)

    const failure = errFrom<number>('nope')
    expect(mapResult(failure, (n) => n * 3)).toBe(failure)
  })
})

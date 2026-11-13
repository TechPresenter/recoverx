import type { IpcChannelName, IpcEventName } from '@shared/ipc/channels'
import type { IpcEventPayload, IpcRequest, IpcResponse } from '@shared/ipc/contracts'
import type { IpcUnsubscribe } from '@shared/ipc/bridge'
import { ErrorCode, type SerializedError } from '@shared/utils/errors'
import type { Result } from '@shared/utils/result'

/**
 * Renderer-side access to the main process.
 *
 * A thin layer over `window.recoverx` that exists for two reasons: it fails
 * loudly and once if the preload bridge is missing, and it gives feature code a
 * single import to mock in component tests.
 */

const BRIDGE_MISSING_ERROR: SerializedError = {
  code: ErrorCode.Unknown,
  message: 'The application bridge is unavailable. Please restart RecoverX.',
  details: 'window.recoverx was not installed by the preload script',
  retryable: false,
}

function getBridge(): Window['recoverx'] | null {
  return typeof window !== 'undefined' && 'recoverx' in window ? window.recoverx : null
}

/**
 * Send a request to the main process.
 *
 * Always resolves. Every failure — including a missing bridge — arrives as
 * `{ ok: false, error }`, so callers have exactly one code path to handle.
 */
export async function invoke<C extends IpcChannelName>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<Result<IpcResponse<C>>> {
  const bridge = getBridge()

  if (bridge === null) {
    return { ok: false, error: BRIDGE_MISSING_ERROR }
  }

  return bridge.invoke(channel, payload)
}

/**
 * Send a request and throw on failure.
 *
 * For call sites inside an error boundary or a store action that already has a
 * failure path — it converts the `Result` into an exception so `try/catch` reads
 * naturally, rather than forcing an `if (!result.ok)` into every action.
 */
export async function invokeOrThrow<C extends IpcChannelName>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  const result = await invoke(channel, payload)

  if (!result.ok) {
    throw new IpcError(result.error)
  }

  return result.data
}

/** Subscribe to a main-process event. Returns an unsubscribe function. */
export function subscribe<E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEventPayload<E>) => void,
): IpcUnsubscribe {
  const bridge = getBridge()
  if (bridge === null) return () => undefined

  return bridge.subscribe(event, listener)
}

/** `true` when the preload bridge was installed correctly. */
export function isBridgeAvailable(): boolean {
  return getBridge() !== null
}

/** An `Error` carrying a `SerializedError`, for use with `invokeOrThrow`. */
export class IpcError extends Error {
  readonly serialized: SerializedError

  constructor(serialized: SerializedError) {
    super(serialized.message)
    this.name = 'IpcError'
    this.serialized = serialized
  }
}

/** Extract a displayable `SerializedError` from any caught value. */
export function toDisplayError(value: unknown): SerializedError {
  if (value instanceof IpcError) return value.serialized

  if (value instanceof Error) {
    return { code: ErrorCode.Unknown, message: value.message, details: undefined, retryable: false }
  }

  return {
    code: ErrorCode.Unknown,
    message: 'Something went wrong',
    details: undefined,
    retryable: false,
  }
}

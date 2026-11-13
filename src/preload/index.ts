import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  timeoutForChannel,
  IPC_UNBOUNDED_CHANNELS,
  isIpcChannelName,
  isIpcEventName,
  type IpcChannelName,
  type IpcEventName,
} from '@shared/ipc/channels'
import type { IpcUnsubscribe, RecoverXBridge } from '@shared/ipc/bridge'
import type { IpcEventPayload, IpcRequest, IpcResponse } from '@shared/ipc/contracts'
import { ErrorCode, type SerializedError } from '@shared/utils/errors'
import type { Result } from '@shared/utils/result'

/**
 * The context bridge.
 *
 * This is the entire attack surface between a sandboxed renderer and a process
 * running with an Administrator token, so it is deliberately tiny: two
 * functions, no object graph, no `ipcRenderer` leakage, no Node built-ins.
 *
 * The bundle is also kept minimal on purpose — no Zod, no shared utilities with
 * runtime weight — because a preload script is parsed synchronously before every
 * window paints, and it sits directly on the cold-start budget.
 */

/**
 * Send a request and await its result.
 *
 * Failures are values, not exceptions: the main process answers with
 * `{ ok: false, error }` and this function adds two more failure modes of its
 * own — an unknown channel and a timeout — in the same shape, so the renderer
 * has exactly one way to handle everything that can go wrong.
 */
async function invoke<C extends IpcChannelName>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<Result<IpcResponse<C>>> {
  if (!isIpcChannelName(channel)) {
    return failure(ErrorCode.Validation, `Unknown IPC channel: ${String(channel)}`)
  }

  const call = ipcRenderer.invoke(channel, payload) as Promise<Result<IpcResponse<C>>>

  if (IPC_UNBOUNDED_CHANNELS.has(channel)) {
    return awaitCall(call)
  }

  return awaitCall(withTimeout(call, channel))
}

/**
 * Subscribe to a main-process notification.
 * Returns an unsubscribe function suitable for a React effect cleanup.
 */
function subscribe<E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEventPayload<E>) => void,
): IpcUnsubscribe {
  if (!isIpcEventName(event)) {
    // Returning a no-op rather than throwing keeps a typo in a subscription from
    // taking down the component tree that registered it.
    return () => undefined
  }

  const handler = (_event: IpcRendererEvent, payload: unknown): void => {
    try {
      listener(payload as IpcEventPayload<E>)
    } catch {
      // A throwing subscriber must not break delivery to the others.
    }
  }

  ipcRenderer.on(event, handler)

  return () => {
    ipcRenderer.removeListener(event, handler)
  }
}

const bridge: RecoverXBridge = Object.freeze({ invoke, subscribe })

// `exposeInMainWorld` deep-clones the object into the isolated world, so the
// renderer receives a copy it cannot use to reach back into preload scope.
contextBridge.exposeInMainWorld('recoverx', bridge)

// --- internals -------------------------------------------------------------

function failure<T>(code: SerializedError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message, details: undefined, retryable: false } }
}

/**
 * Convert a broken bridge into a `Result`.
 *
 * `ipcRenderer.invoke` rejects only when the transport itself fails — no handler
 * registered, or the main process died. Both are real conditions during an
 * update or a crash, and neither should reach the UI as an unhandled rejection.
 */
async function awaitCall<T>(call: Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure(ErrorCode.Unknown, `The application did not respond: ${message}`)
  }
}

function withTimeout<T>(call: Promise<Result<T>>, channel: IpcChannelName): Promise<Result<T>> {
  // Channels that share the process with a running scan get a longer ceiling:
  // waiting behind the scanner is slow, not broken.
  const limit = timeoutForChannel(channel)

  return new Promise<Result<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(failure(ErrorCode.Timeout, `The operation timed out after ${limit / 1000} seconds`))
    }, limit)

    call.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(`${channel}: ${String(error)}`))
      },
    )
  })
}

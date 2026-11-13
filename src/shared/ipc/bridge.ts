import type { Result } from '../utils/result'
import type { IpcChannelName, IpcEventName } from './channels'
import type { IpcEventPayload, IpcRequest, IpcResponse } from './contracts'

/**
 * The shape of the object exposed on `window.recoverx` by the preload script.
 *
 * This is the *entire* surface the renderer can reach. There is no Node
 * integration, no remote module and no direct `ipcRenderer` access: everything
 * funnels through these two functions, both of which are constrained by the
 * channel contracts. Adding a capability to the renderer therefore requires
 * adding a channel — which requires a schema, a handler and a review.
 */

/** Detaches an event listener. Returned by `subscribe` for use in effect cleanup. */
export type IpcUnsubscribe = () => void

export interface RecoverXBridge {
  /**
   * Send a request to the main process and await its result.
   *
   * Never rejects for application-level failures: those come back as
   * `{ ok: false, error }`. It only rejects if the bridge itself is broken,
   * which is unrecoverable and is reported by the global error boundary.
   */
  readonly invoke: <C extends IpcChannelName>(
    channel: C,
    payload: IpcRequest<C>,
  ) => Promise<Result<IpcResponse<C>>>

  /**
   * Subscribe to a main-process notification.
   *
   * Event names are checked against the declared set in the preload, so a
   * listener can only ever be attached to a channel that exists. Payload shape
   * is not re-validated there: the sender is the main process, which already
   * validated it, and keeping Zod out of the preload bundle matters because that
   * script is parsed before every window paints.
   */
  readonly subscribe: <E extends IpcEventName>(
    event: E,
    listener: (payload: IpcEventPayload<E>) => void,
  ) => IpcUnsubscribe
}

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNEL_NAMES, type IpcChannelName } from '@shared/ipc/channels'
import { type IpcRequest, type IpcResponse, getContract } from '@shared/ipc/contracts'
import { AppError, ErrorCode, toSerializedError } from '@shared/utils/errors'
import { formatZodIssues } from '@shared/utils/json'
import { type Result, err, ok } from '@shared/utils/result'
import type { AppContext } from '../app/context'
import type { Logger } from '../logging/logger'

/**
 * Typed, validated dispatch for every `ipcMain.handle` channel.
 *
 * Each registration gets the same four guarantees, applied uniformly so no
 * individual handler can forget one:
 *
 *   1. The sender is one of our own windows.
 *   2. The request payload matches the channel's schema.
 *   3. Thrown errors become `{ ok: false, error }` — the renderer never sees a
 *      rejected promise, and a stack trace never crosses the boundary.
 *   4. Every failure is logged with its channel and duration.
 *
 * Doing this in one place is what allows the handlers themselves to be small,
 * synchronous-looking functions that simply return their result.
 */

export interface IpcInvocationContext {
  readonly app: AppContext
  readonly event: IpcMainInvokeEvent
}

export type IpcHandler<C extends IpcChannelName> = (
  payload: IpcRequest<C>,
  context: IpcInvocationContext,
) => IpcResponse<C> | Promise<IpcResponse<C>>

/** Calls slower than this are logged so a regression is visible in the field. */
const SLOW_CALL_THRESHOLD_MS = 750

export class IpcRegistry {
  private readonly context: AppContext
  private readonly logger: Logger
  private readonly registered = new Set<IpcChannelName>()

  constructor(context: AppContext) {
    this.context = context
    this.logger = context.logger.child('ipc')
  }

  /**
   * Bind a handler to a channel.
   * Registering the same channel twice is a programming error and throws.
   */
  register<C extends IpcChannelName>(channel: C, handler: IpcHandler<C>): void {
    if (this.registered.has(channel)) {
      throw new AppError(ErrorCode.Conflict, `IPC channel "${channel}" is already registered`)
    }
    this.registered.add(channel)

    const contract = getContract(channel)

    ipcMain.handle(channel, async (event, rawPayload: unknown): Promise<Result<unknown>> => {
      const startedAt = Date.now()

      if (!this.isTrustedSender(event)) {
        this.logger.error('Rejected IPC call from an untrusted sender', { channel })
        return err(
          new AppError(ErrorCode.SecurityViolation, 'Request rejected', {
            retryable: false,
          }).toSerialized(),
        )
      }

      const parsedRequest = contract.request.safeParse(rawPayload)
      if (!parsedRequest.success) {
        const details = formatZodIssues(parsedRequest.error.issues)
        this.logger.warn('Rejected malformed IPC payload', { channel, details })
        return err(
          new AppError(ErrorCode.Validation, 'The request payload was not valid', {
            details,
            retryable: false,
          }).toSerialized(),
        )
      }

      try {
        // The contract map guarantees this alignment by construction, but the
        // correlation between `C` and its schema is beyond what the compiler can
        // track through a generic index. This is the single cast that buys
        // full type safety at every call site.
        const payload = parsedRequest.data as IpcRequest<C>
        const result = await handler(payload, { app: this.context, event })

        this.validateResponseInDevelopment(channel, result)
        this.recordDuration(channel, startedAt)

        return ok(result)
      } catch (error) {
        const serialized = toSerializedError(error, 'The operation could not be completed')

        this.logger.error('IPC handler failed', {
          channel,
          code: serialized.code,
          message: serialized.message,
          details: serialized.details,
          durationMs: Date.now() - startedAt,
        })

        return err(serialized)
      }
    })
  }

  /**
   * Assert that every declared channel has a handler.
   *
   * Called at the end of boot. A channel with a contract but no handler would
   * otherwise fail only when a user reached the feature that uses it — this
   * turns that into a startup failure during development.
   */
  assertComplete(): void {
    const missing = IPC_CHANNEL_NAMES.filter((channel) => !this.registered.has(channel))

    if (missing.length > 0) {
      throw new AppError(
        ErrorCode.Unknown,
        `IPC channels declared without a handler: ${missing.join(', ')}`,
      )
    }

    this.logger.debug('IPC surface registered', { channels: this.registered.size })
  }

  /** Remove every handler. Called during shutdown. */
  dispose(): void {
    for (const channel of this.registered) {
      ipcMain.removeHandler(channel)
    }
    this.registered.clear()
  }

  // --- internals -----------------------------------------------------------

  /**
   * Confirm the call originated in a window this process created.
   *
   * Without this a compromised or injected frame could invoke privileged
   * channels directly. Elevated block-device access makes that a meaningful
   * escalation rather than a theoretical one.
   */
  private isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window !== null && !window.isDestroyed()
  }

  /**
   * Verify a handler's return value against the response schema.
   *
   * Development only, deliberately. This catches contract drift while the code
   * is being written, but validating a 2000-entry log page on every production
   * query would add latency to the hot path for a class of bug that cannot
   * survive review.
   */
  private validateResponseInDevelopment(channel: IpcChannelName, value: unknown): void {
    if (!this.context.config.isDevelopment) return

    const parsed = getContract(channel).response.safeParse(value)
    if (parsed.success) return

    this.logger.error('IPC handler returned a value that violates its contract', {
      channel,
      details: formatZodIssues(parsed.error.issues),
    })
  }

  private recordDuration(channel: IpcChannelName, startedAt: number): void {
    const durationMs = Date.now() - startedAt
    if (durationMs < SLOW_CALL_THRESHOLD_MS) return

    this.logger.warn('Slow IPC call', { channel, durationMs })
  }
}

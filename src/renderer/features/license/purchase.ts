import { z } from 'zod'
import { PURCHASE_URL } from '@shared/constants/app'
import { IpcChannel } from '@shared/ipc/channels'
import { ErrorCode, type SerializedError } from '@shared/utils/errors'
import { parseJson } from '@shared/utils/json'
import { invoke } from '@/lib/ipc-client'
import { toast } from '@/stores/ui.store'

/**
 * The way from the Free edition to a paid one.
 *
 * Shared by the two places a user meets the limit: the Licence screen, where
 * they go looking, and the recovery dialog, where the limit finds them.
 */

/** Hostname of the purchase page, for telling the user where a click will take them. */
export const PURCHASE_SITE = new URL(PURCHASE_URL).host

/**
 * Open the purchase page in the user's browser.
 *
 * Routed through the same IPC channel as every other external link, so the
 * main process checks it against the host allowlist before the OS sees it.
 * A refusal is surfaced rather than swallowed: a buy button that silently does
 * nothing reads as a product that does not want to be bought.
 */
export async function openPurchasePage(): Promise<void> {
  const response = await invoke(IpcChannel.AppOpenExternal, { url: PURCHASE_URL })

  if (!response.ok) toast.error(response.error.message, response.error.details)
}

/**
 * Recognising the Free-edition refusal.
 *
 * The main process refuses an oversized recovery with an `Unsupported` error
 * whose details carry the figures behind the decision as JSON (see
 * `LicenseService.assertRecoveryAllowed`). Shown raw, that is a toast full of
 * braces; read here, it becomes the two things the user needs — how much is
 * left, and how to stop being limited.
 *
 * Recognised by its shape rather than its message, so a reworded sentence in
 * the main process cannot quietly turn the refusal back into a raw toast.
 */
const FreeLimitRefusalSchema = z.object({
  limitBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  remainingBytes: z.number().nonnegative(),
  requestedBytes: z.number().nonnegative(),
})

export type FreeLimitRefusal = z.infer<typeof FreeLimitRefusalSchema>

/** The figures behind a Free-edition refusal, or `null` for any other error. */
export function readFreeLimitRefusal(error: SerializedError): FreeLimitRefusal | null {
  if (error.code !== ErrorCode.Unsupported || error.details === undefined) return null

  const parsed = parseJson(error.details, FreeLimitRefusalSchema)
  return parsed.ok ? parsed.data : null
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('clipboard')

/**
 * Copy text to the clipboard, with a short-lived "copied" acknowledgement.
 *
 * The `app://` scheme is registered as secure, so the async Clipboard API is
 * available in the packaged build as well as in development.
 */
export function useCopyToClipboard(resetAfterMs = 1800): {
  copy: (text: string) => Promise<boolean>
  copied: boolean
} {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clearing on unmount prevents a state update against a component that has
  // already gone — the user can navigate away inside the acknowledgement window.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text)

        setCopied(true)
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          setCopied(false)
        }, resetAfterMs)

        return true
      } catch (error) {
        log.warn('Clipboard write failed', { error: String(error) })
        return false
      }
    },
    [resetAfterMs],
  )

  return { copy, copied }
}

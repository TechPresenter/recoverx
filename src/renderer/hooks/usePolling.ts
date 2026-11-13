import { useEffect, useRef } from 'react'

/**
 * Run a callback on an interval, pausing while the window is hidden.
 *
 * The Dashboard polls system counters every two seconds. Continuing to do that
 * while the window is minimised burns CPU on a machine whose owner is often
 * already running a disk scan, so the timer stops with visibility and fires once
 * immediately on return, keeping the first frame after restore current.
 */
export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  // The callback is held in a ref so a new inline closure on every render does
  // not restart the interval — which would reset the phase on each poll.
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return

    let timer: ReturnType<typeof setInterval> | null = null

    const run = (): void => {
      void callbackRef.current()
    }

    const start = (): void => {
      if (timer !== null) return
      run()
      timer = setInterval(run, intervalMs)
    }

    const stop = (): void => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') start()
      else stop()
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [intervalMs, enabled])
}

import { useEffect, useRef, useState } from 'react'

/**
 * Run an async query, never more than one at a time.
 *
 * The problem this solves is specific and was reproducible during a deep scan.
 * Results refresh whenever the scan reports new files, which happens several
 * times a second. Firing a fresh query on each of those without waiting for the
 * previous one produces a queue that grows faster than the main process can
 * drain it — the scanner is holding the event loop doing synchronous carving
 * and synchronous SQLite writes, so each request waits behind that work as well
 * as behind its predecessors. Requests then time out while sitting in a queue,
 * having never been slow themselves.
 *
 * The fix is to coalesce. One query runs at a time; anything that arrives while
 * it is running sets a flag, and exactly one further run happens when it
 * finishes. Bursts collapse into "run, then run once more with the latest
 * input", which is all the user can perceive anyway — the intermediate results
 * would have been overwritten before they were painted.
 *
 * @param run    The query. Receives an abort signal for the stale case.
 * @param deps   Re-run when these change, subject to the coalescing above.
 */
export function useLiveQuery<T>(
  run: (signal: AbortSignal) => Promise<T | null>,
  deps: readonly unknown[],
): { readonly data: T | null; readonly loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)

  /** The query currently in flight, if any. */
  const running = useRef(false)
  /** Set when a re-run was requested while one was already in flight. */
  const pending = useRef(false)
  /** Latest callback, so a coalesced re-run uses current inputs, not stale ones. */
  const latest = useRef(run)
  latest.current = run

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()

    const execute = async (): Promise<void> => {
      if (running.current) {
        // Something is already in flight. Ask it to run once more on the way
        // out rather than starting a second query behind it.
        pending.current = true
        return
      }

      running.current = true

      try {
        do {
          pending.current = false
          const result = await latest.current(controller.signal)

          // A result that arrived after the inputs changed is not wrong, it is
          // simply about a question nobody is asking any more.
          if (disposed || controller.signal.aborted) return
          if (result !== null) setData(result)
        } while (pending.current && !disposed)
      } finally {
        running.current = false
        if (!disposed) setLoading(false)
      }
    }

    void execute()

    return () => {
      disposed = true
      controller.abort()
    }
    // The caller owns the dependency list; `run` is read through a ref so a new
    // closure on every render does not by itself trigger a query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading }
}

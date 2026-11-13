import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

/**
 * Fixed-height row virtualisation.
 *
 * The Logs screen routinely holds tens of thousands of records, and the scan
 * result grid will hold millions. Mounting a DOM node per row is the single
 * fastest way to make this application feel slow, so only the visible window
 * plus a small overscan is rendered.
 *
 * Written by hand rather than pulled from a library: the requirement is uniform
 * row heights inside a single scroll container, which is about sixty lines of
 * arithmetic — and it keeps a dependency out of the first-paint bundle.
 */

export interface VirtualRange {
  /** Index of the first row to render. */
  readonly startIndex: number
  /** Index one past the last row to render. */
  readonly endIndex: number
  /** Spacer height above the rendered rows, in pixels. */
  readonly paddingTop: number
  /** Spacer height below the rendered rows, in pixels. */
  readonly paddingBottom: number
  /** Full scrollable height, in pixels. */
  readonly totalHeight: number
}

export interface VirtualRowsOptions {
  readonly count: number
  readonly rowHeight: number
  /** Extra rows rendered outside the viewport to hide scroll latency. */
  readonly overscan?: number
}

export function useVirtualRows(
  containerRef: RefObject<HTMLElement | null>,
  { count, rowHeight, overscan = 8 }: VirtualRowsOptions,
): VirtualRange {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  // Layout effect, not effect: the height must be known before the browser
  // paints, otherwise the first frame renders zero rows and visibly flickers.
  useLayoutEffect(() => {
    const element = containerRef.current
    if (element === null) return

    setViewportHeight(element.clientHeight)

    // ResizeObserver rather than a window resize listener, because the pane can
    // change height when the sidebar collapses without the window resizing.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      setViewportHeight(entry.contentRect.height)
    })

    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [containerRef])

  const onScroll = useCallback(() => {
    const element = containerRef.current
    if (element === null) return
    setScrollTop(element.scrollTop)
  }, [containerRef])

  useEffect(() => {
    const element = containerRef.current
    if (element === null) return

    // Passive: this listener never calls preventDefault, and saying so lets the
    // compositor scroll without waiting for JavaScript.
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
    }
  }, [containerRef, onScroll])

  // Clamp back into range when the row count shrinks under the current scroll
  // position — filtering a log down to three matches must not leave the list
  // scrolled past its own end.
  useEffect(() => {
    const element = containerRef.current
    if (element === null) return

    const maxScrollTop = Math.max(0, count * rowHeight - element.clientHeight)
    if (element.scrollTop > maxScrollTop) {
      element.scrollTop = maxScrollTop
      setScrollTop(maxScrollTop)
    }
  }, [containerRef, count, rowHeight])

  const totalHeight = count * rowHeight

  if (viewportHeight === 0 || count === 0) {
    // Before measurement, render a small first page so the list is never blank
    // for a frame.
    const initial = Math.min(count, overscan * 2)
    return {
      startIndex: 0,
      endIndex: initial,
      paddingTop: 0,
      paddingBottom: Math.max(0, totalHeight - initial * rowHeight),
      totalHeight,
    }
  }

  const firstVisible = Math.floor(scrollTop / rowHeight)
  const visibleCount = Math.ceil(viewportHeight / rowHeight)

  const startIndex = Math.max(0, firstVisible - overscan)
  const endIndex = Math.min(count, firstVisible + visibleCount + overscan)

  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * rowHeight,
    paddingBottom: Math.max(0, totalHeight - endIndex * rowHeight),
    totalHeight,
  }
}

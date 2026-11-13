import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * jsdom environment setup.
 *
 * jsdom implements the DOM but not the platform APIs a desktop UI relies on.
 * Each polyfill below stands in for something the renderer genuinely uses, so a
 * component under test behaves the way it does in Electron rather than throwing
 * on a missing global.
 */

afterEach(() => {
  cleanup()
})

// Used by `useVirtualRows` to react to a pane resizing without the window
// resizing — jsdom has no layout engine and therefore no ResizeObserver.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // No layout in jsdom, so nothing is ever reported.
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

globalThis.ResizeObserver = ResizeObserverStub

// `useSystemDarkMode` queries this on mount. jsdom returns undefined without a
// stub, which would throw before the first render completed.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

// jsdom does not implement scrolling; the virtualiser reads these.
Object.defineProperty(HTMLElement.prototype, 'scrollTo', { writable: true, value: vi.fn() })

// The preload bridge does not exist in jsdom. Individual tests replace this
// with `vi.mock('@/lib/ipc-client')` where they need controlled responses; this
// default keeps modules that merely import it from failing at load time.
Object.defineProperty(window, 'recoverx', {
  writable: true,
  configurable: true,
  value: {
    invoke: vi.fn(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN', message: 'not stubbed', retryable: false },
      }),
    ),
    subscribe: vi.fn(() => () => undefined),
  },
})

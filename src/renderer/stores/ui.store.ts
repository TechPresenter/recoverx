import { create } from 'zustand'
import type { WindowState } from '@shared/types/system'

/**
 * Transient interface state: toasts, sidebar layout and the live window state
 * used by the custom title bar.
 *
 * Nothing here is persisted. Anything that should survive a restart belongs in
 * the settings store, which is backed by SQLite.
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  readonly id: string
  readonly tone: ToastTone
  readonly title: string
  readonly description?: string | undefined
  /** Auto-dismiss delay. `0` keeps the toast until dismissed. */
  readonly durationMs: number
}

export interface ToastInput {
  readonly tone?: ToastTone
  readonly title: string
  readonly description?: string | undefined
  readonly durationMs?: number
}

/** Errors stay on screen until dismissed; confirmations get out of the way. */
const DEFAULT_DURATIONS: Record<ToastTone, number> = {
  success: 3200,
  info: 4000,
  warning: 6000,
  error: 0,
}

/** Bound the stack so a failure loop cannot fill the screen. */
const MAX_TOASTS = 4

export interface ConfirmOptions {
  readonly title: string
  readonly description?: string | undefined
  readonly confirmLabel: string
  readonly cancelLabel: string
  /** Styles the confirm action as destructive. */
  readonly destructive?: boolean
}

export interface ConfirmRequest extends ConfirmOptions {
  /** Settles the promise returned by `requestConfirm`. */
  readonly settle: (confirmed: boolean) => void
}

interface UiState {
  toasts: readonly Toast[]
  sidebarCollapsed: boolean
  windowState: WindowState
  confirmRequest: ConfirmRequest | null

  pushToast: (toast: ToastInput) => string
  dismissToast: (id: string) => void
  clearToasts: () => void
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setWindowState: (state: WindowState) => void
  /**
   * Ask the user to confirm an action.
   *
   * Replaces `window.confirm`, which blocks the entire renderer process, cannot
   * be themed or translated, and renders as a browser dialog that looks
   * out of place in a frameless desktop window.
   */
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>
  resolveConfirm: (confirmed: boolean) => void
}

let toastSequence = 0

export const useUiStore = create<UiState>()((set, get) => ({
  toasts: [],
  sidebarCollapsed: false,
  windowState: { isMaximized: false, isMinimized: false, isFullScreen: false, isFocused: true },
  confirmRequest: null,

  pushToast: (input) => {
    toastSequence += 1
    const id = `toast-${toastSequence}`
    const tone = input.tone ?? 'info'

    const toast: Toast = {
      id,
      tone,
      title: input.title,
      description: input.description,
      durationMs: input.durationMs ?? DEFAULT_DURATIONS[tone],
    }

    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }))
    return id
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },

  clearToasts: () => {
    set({ toasts: [] })
  },

  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
  },

  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed })
  },

  setWindowState: (windowState) => {
    set({ windowState })
  },

  requestConfirm: (options) =>
    new Promise<boolean>((resolve) => {
      // A second request while one is open cancels the first, so its awaiting
      // caller settles instead of hanging forever on a dialog that was replaced.
      get().confirmRequest?.settle(false)

      set({
        confirmRequest: {
          ...options,
          settle: (confirmed) => {
            resolve(confirmed)
          },
        },
      })
    }),

  resolveConfirm: (confirmed) => {
    const pending = get().confirmRequest
    if (pending === null) return

    set({ confirmRequest: null })
    pending.settle(confirmed)
  },
}))

/**
 * Imperative toast helper for non-component code (store actions, event
 * handlers) that has no access to hooks.
 */
export const toast = {
  success: (title: string, description?: string): string =>
    useUiStore.getState().pushToast({ tone: 'success', title, description }),
  error: (title: string, description?: string): string =>
    useUiStore.getState().pushToast({ tone: 'error', title, description }),
  warning: (title: string, description?: string): string =>
    useUiStore.getState().pushToast({ tone: 'warning', title, description }),
  info: (title: string, description?: string): string =>
    useUiStore.getState().pushToast({ tone: 'info', title, description }),
}

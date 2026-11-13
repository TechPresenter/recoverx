import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUiStore, type Toast, type ToastTone } from '@/stores/ui.store'

const TONE_ICONS: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const TONE_STYLES: Record<ToastTone, string> = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
}

/**
 * Transient notification stack.
 *
 * Rendered once at the application root and driven entirely from the UI store,
 * so any code — including non-React store actions — can raise a notification
 * without a context or a prop chain.
 */
export function Toaster() {
  const toasts = useUiStore((state) => state.toasts)

  if (toasts.length === 0) return null

  return (
    <div
      // `aria-live="polite"` announces new toasts without interrupting whatever
      // the user is currently reading.
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[min(23rem,calc(100vw-2.5rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useUiStore((state) => state.dismissToast)
  const Icon = TONE_ICONS[toast.tone]

  useEffect(() => {
    // A duration of zero means the toast is sticky — used for errors, which the
    // user must be able to read and act on at their own pace.
    if (toast.durationMs <= 0) return

    const timer = setTimeout(() => {
      dismiss(toast.id)
    }, toast.durationMs)

    return () => {
      clearTimeout(timer)
    }
  }, [toast.id, toast.durationMs, dismiss])

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className="animate-slide-up pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-overlay"
    >
      <Icon size={18} aria-hidden className={cn('mt-0.5 shrink-0', TONE_STYLES[toast.tone])} />

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink">{toast.title}</p>
        {toast.description !== undefined && (
          <p className="mt-0.5 text-[12.5px] leading-relaxed break-words text-ink-muted">
            {toast.description}
          </p>
        )}
      </div>

      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => {
          dismiss(toast.id)
        }}
        className="-m-1 shrink-0 rounded p-1 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  )
}

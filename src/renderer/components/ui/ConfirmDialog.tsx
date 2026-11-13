import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './Button'
import { useUiStore } from '@/stores/ui.store'

/**
 * Modal confirmation.
 *
 * Rendered once at the application root and driven from the UI store, so any
 * code can `await requestConfirm(...)` without threading a callback through the
 * component tree.
 *
 * Accessibility handled here rather than pulled from a dialog library: the
 * requirement is a single, always-modal, always-centred dialog, and the three
 * behaviours that matter — focus on open, Escape to cancel, focus contained —
 * are a few lines each.
 */
export function ConfirmDialog() {
  const request = useUiStore((state) => state.confirmRequest)
  const resolve = useUiStore((state) => state.resolveConfirm)

  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (request === null) return

    // Remember where focus came from so it can be restored on close — without
    // this, dismissing the dialog drops the user back to the top of the page.
    previouslyFocused.current = document.activeElement as HTMLElement | null
    confirmButtonRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        resolve(false)
        return
      }

      if (event.key !== 'Tab') return

      // Focus trap. Everything behind the dialog is inert while it is open, so
      // Tab must cycle within it rather than escaping into the page beneath.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable === undefined || focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused.current?.focus()
    }
  }, [request, resolve])

  if (request === null) return null

  return (
    <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center p-6">
      {/*
        The backdrop is a real <button> rather than a div with a click handler:
        click-to-dismiss on a non-interactive element is unreachable by keyboard.
        It is hidden from assistive technology and removed from the tab order
        because it duplicates the Escape key, which the effect above handles.
      */}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => {
          resolve(false)
        }}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[2px]"
      />

      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={request.description === undefined ? undefined : 'confirm-dialog-body'}
        className="animate-scale-in relative z-10 w-full max-w-md rounded-card border border-line bg-surface p-5 shadow-overlay"
      >
        <div className="flex items-start gap-3.5">
          {request.destructive === true && (
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-danger-soft text-danger">
              <AlertTriangle size={20} aria-hidden />
            </span>
          )}

          <div className="min-w-0">
            <h2 id="confirm-dialog-title" className="text-[15px] font-semibold text-ink">
              {request.title}
            </h2>
            {request.description !== undefined && (
              <p
                id="confirm-dialog-body"
                className="mt-1.5 text-[13px] leading-relaxed text-ink-muted"
              >
                {request.description}
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              resolve(false)
            }}
          >
            {request.cancelLabel}
          </Button>
          <Button
            ref={confirmButtonRef}
            variant={request.destructive === true ? 'danger' : 'primary'}
            onClick={() => {
              resolve(true)
            }}
          >
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

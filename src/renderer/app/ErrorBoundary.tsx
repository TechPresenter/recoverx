import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertOctagon } from 'lucide-react'
import { createLogger } from '@/lib/logger'

const log = createLogger('error-boundary')

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Last line of defence for renderer exceptions.
 *
 * Without it, a throw during render unmounts the entire React tree and leaves
 * the user staring at an empty window with no explanation and nothing recorded.
 * This catches the throw, forwards it to the main process log — where it lands
 * in the same rotating file as everything else — and offers a recovery path.
 *
 * A class component because `componentDidCatch` has no hook equivalent.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    log.error('Unhandled error in the React tree', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    })
  }

  override render(): ReactNode {
    const { error } = this.state

    if (error === null) return this.props.children

    return (
      <div className="flex h-full items-center justify-center bg-app p-8">
        <div className="w-full max-w-md rounded-card border border-line bg-surface p-6 text-center shadow-raised">
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-danger-soft text-danger">
            <AlertOctagon size={24} aria-hidden />
          </span>

          <h1 className="mt-4 text-base font-semibold text-ink">
            RecoverX hit an unexpected problem
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            The screen you were on could not be displayed. The error has been written to the
            diagnostics log.
          </p>

          <p className="selectable mt-3 rounded-lg bg-surface-2 px-3 py-2 text-left font-mono text-[12px] break-words text-ink-muted">
            {error.message}
          </p>

          <button
            type="button"
            onClick={() => {
              // A full reload rebuilds the renderer from a clean state. The main
              // process, and therefore any running scan, is unaffected.
              window.location.reload()
            }}
            className="mt-5 inline-flex h-9 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
          >
            Reload the application
          </button>
        </div>
      </div>
    )
  }
}

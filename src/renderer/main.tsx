import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initializeI18n } from './i18n'
import { createLogger } from './lib/logger'
import './styles/global.css'

/**
 * Renderer entry point.
 *
 * The pre-paint work here is deliberately minimal and synchronous — everything
 * on this path is on the cold-start budget. Settings arrive asynchronously and
 * are handled inside `<App>`; the only thing that cannot wait is the colour
 * scheme, because applying it after the first paint would flash.
 */

applyInitialColorScheme()
initializeI18n('en')
installGlobalErrorReporting()

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Root container is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * Apply the OS colour scheme before React mounts.
 *
 * The default theme setting is "system", so for most users this is already the
 * final answer and nothing changes when settings load a moment later. Users who
 * pinned light or dark get one correction inside the same frame budget — still
 * before the window is shown, because Electron holds it back until first paint.
 */
function applyInitialColorScheme(): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', prefersDark)
}

/**
 * Forward uncaught renderer failures into the main process log.
 *
 * The React error boundary only sees errors thrown during render. Failures in
 * event handlers, timers and unawaited promises bypass it entirely, and without
 * this they would leave no trace in a support bundle.
 */
function installGlobalErrorReporting(): void {
  const log = createLogger('window')

  window.addEventListener('error', (event) => {
    log.error('Uncaught error in the renderer', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    log.error('Unhandled promise rejection in the renderer', {
      reason: event.reason instanceof Error ? event.reason.message : String(event.reason),
      stack: event.reason instanceof Error ? event.reason.stack : undefined,
    })
  })
}

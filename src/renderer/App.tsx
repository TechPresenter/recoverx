import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { IpcEvent } from '@shared/ipc/channels'
import { isBridgeAvailable, subscribe } from '@/lib/ipc-client'
import { setLanguage } from '@/i18n'
import { Spinner } from '@/components/ui/Spinner'
import { useAppearance } from '@/hooks/useAppearance'
import { useSettingsStore } from '@/stores/settings.store'
import { ErrorBoundary } from './app/ErrorBoundary'
import { router } from './app/router'

/**
 * Application root.
 *
 * Routes are not mounted until settings have loaded. That ordering is what
 * removes the theme flash: the correct `dark` class and accent are applied to
 * `<html>` before any screen renders, so no component ever paints in the wrong
 * palette and then corrects itself.
 */
export function App() {
  const status = useSettingsStore((state) => state.status)
  const settings = useSettingsStore((state) => state.settings)
  const error = useSettingsStore((state) => state.error)
  const load = useSettingsStore((state) => state.load)
  const applyExternal = useSettingsStore((state) => state.applyExternal)

  useAppearance(settings)

  useEffect(() => {
    void load()
  }, [load])

  // The main process is authoritative: a change made anywhere — including a
  // future tray menu or a second window — is broadcast back to every renderer.
  useEffect(() => subscribe(IpcEvent.SettingsChanged, applyExternal), [applyExternal])

  const language = settings?.language
  useEffect(() => {
    if (language === undefined) return
    void setLanguage(language)
  }, [language])

  if (!isBridgeAvailable()) {
    return (
      <StartupFailure
        title="The application bridge is unavailable"
        body="RecoverX could not connect its interface to the background process. Restarting usually resolves this."
      />
    )
  }

  if (status === 'error') {
    return (
      <StartupFailure
        title="RecoverX could not load your settings"
        body={error?.message ?? 'The settings database could not be read.'}
      />
    )
  }

  if (status !== 'ready' || settings === null) {
    return <StartupSplash />
  }

  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  )
}

/**
 * Shown for the few milliseconds between first paint and settings arriving.
 *
 * Intentionally silent — no text, no logo animation. At this duration a
 * message would flash and be unreadable, which reads as a glitch rather than
 * as feedback.
 */
function StartupSplash() {
  return (
    <div className="grid h-full place-items-center bg-app text-ink-subtle">
      <Spinner size={24} label="Starting RecoverX" />
    </div>
  )
}

function StartupFailure({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid h-full place-items-center bg-app p-8">
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-6 text-center shadow-raised">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-warning-soft text-warning">
          <AlertTriangle size={24} aria-hidden />
        </span>
        <h1 className="mt-4 text-base font-semibold text-ink">{title}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{body}</p>
        <button
          type="button"
          onClick={() => {
            window.location.reload()
          }}
          className="mt-5 inline-flex h-9 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
        >
          Try again
        </button>
      </div>
    </div>
  )
}

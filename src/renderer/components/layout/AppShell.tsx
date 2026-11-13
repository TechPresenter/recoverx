import { Suspense, useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import { invoke } from '@/lib/ipc-client'
import { Button } from '@/components/ui/Button'
import { AppFooter } from '@/components/layout/AppFooter'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Spinner } from '@/components/ui/Spinner'
import { Toaster } from '@/components/ui/Toaster'
import { useSettingsStore } from '@/stores/settings.store'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'

/**
 * Application frame: title bar, sidebar and the routed content pane.
 *
 * The scroll container lives here rather than on `<body>`, which is locked, so
 * the chrome stays fixed while content scrolls beneath it.
 */
export function AppShell() {
  const isElevated = useElevationStatus()

  return (
    <div className="app-canvas flex h-full flex-col overflow-hidden bg-app">
      <TitleBar isElevated={isElevated} />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl flex-1 px-7 py-6">
            <Suspense fallback={<RouteFallback />}>
              <Outlet />
            </Suspense>
          </div>

          <div className="mx-auto w-full max-w-6xl">
            <AppFooter />
          </div>
        </main>
      </div>

      <RestartBanner />
      <Toaster />
      <ConfirmDialog />
    </div>
  )
}

/**
 * Probe the process's elevation state once per session.
 *
 * It cannot change while the application is running — a token is fixed at
 * process creation — so this is deliberately not polled.
 */
function useElevationStatus(): boolean | null {
  const [isElevated, setIsElevated] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false

    void invoke(IpcChannel.SystemGetSnapshot, undefined).then((result) => {
      if (!cancelled && result.ok) setIsElevated(result.data.isElevated)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return isElevated
}

/** Shown while a lazily-loaded route chunk is fetched. */
function RouteFallback() {
  return (
    <div className="flex items-center justify-center py-24 text-ink-subtle">
      <Spinner size={22} label="Loading" />
    </div>
  )
}

/**
 * Prompt to restart after changing a setting that Chromium reads only at
 * launch.
 *
 * Offering the restart inline is what keeps `hardwareAcceleration` from being a
 * setting that appears not to work.
 */
function RestartBanner() {
  const { t } = useTranslation()
  const pendingKeys = useSettingsStore((state) => state.pendingRestartKeys)
  const dismiss = useSettingsStore((state) => state.dismissRestartNotice)

  if (pendingKeys.length === 0) return null

  return (
    <div
      role="status"
      className="animate-slide-up fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-line bg-surface px-4 py-3 shadow-overlay"
    >
      <div>
        <p className="text-[13px] font-medium text-ink">{t('common.restartRequired')}</p>
        <p className="text-[12.5px] text-ink-muted">{t('common.restartRequiredHint')}</p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {t('common.later')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          iconLeft={<RotateCcw size={14} />}
          onClick={() => {
            void invoke(IpcChannel.AppRelaunch, undefined)
          }}
        >
          {t('common.restartNow')}
        </Button>
      </div>
    </div>
  )
}

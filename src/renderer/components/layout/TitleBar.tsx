import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Minus, ShieldAlert, ShieldCheck, Square, X } from 'lucide-react'
import { IpcChannel, IpcEvent } from '@shared/ipc/channels'
import { cn } from '@/lib/cn'
import { invoke, subscribe } from '@/lib/ipc-client'
import { useUiStore } from '@/stores/ui.store'

export interface TitleBarProps {
  /** `null` while the elevation probe is still running. */
  isElevated: boolean | null
}

/**
 * Custom window chrome.
 *
 * The frame is drawn here rather than by the OS so the title bar can carry
 * product state — and, from the Disk Detection module onward, live scan progress
 * that must stay visible on every screen.
 *
 * The trade-off is that minimise, maximise and close become application
 * responsibilities. They are marked `app-no-drag` so a click activates the
 * button instead of starting a window drag.
 */
export function TitleBar({ isElevated }: TitleBarProps) {
  const { t } = useTranslation()
  const windowState = useUiStore((state) => state.windowState)
  const setWindowState = useUiStore((state) => state.setWindowState)

  // The window can be maximised by dragging it to a screen edge, or restored
  // by the OS, without any click reaching this component — so the authoritative
  // state comes from the main process rather than from local toggling.
  useEffect(() => {
    let cancelled = false

    void invoke(IpcChannel.WindowGetState, undefined).then((result) => {
      if (!cancelled && result.ok) setWindowState(result.data)
    })

    const unsubscribe = subscribe(IpcEvent.WindowStateChanged, (state) => {
      setWindowState(state)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [setWindowState])

  return (
    <header
      className="app-drag glass relative z-30 flex h-[var(--rx-titlebar-height)] shrink-0 items-center justify-between border-b border-line pl-4"
      style={{ borderBottomColor: 'var(--rx-glass-line)' }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <AppMark />
        <span className="truncate text-[13px] font-semibold tracking-tight text-ink">
          {t('common.appName')}
        </span>
      </div>

      <div className="app-no-drag flex items-center gap-1 pr-1">
        <ElevationIndicator isElevated={isElevated} />

        <div className="ml-1 flex items-center">
          <WindowButton
            label={t('titleBar.minimize')}
            onClick={() => {
              void invoke(IpcChannel.WindowMinimize, undefined)
            }}
          >
            <Minus size={15} />
          </WindowButton>

          <WindowButton
            label={windowState.isMaximized ? t('titleBar.restore') : t('titleBar.maximize')}
            onClick={() => {
              void invoke(IpcChannel.WindowToggleMaximize, undefined).then((result) => {
                if (result.ok) setWindowState(result.data)
              })
            }}
          >
            {windowState.isMaximized ? <Copy size={13} /> : <Square size={12.5} />}
          </WindowButton>

          <WindowButton
            label={t('titleBar.close')}
            danger
            onClick={() => {
              void invoke(IpcChannel.WindowClose, undefined)
            }}
          >
            <X size={16} />
          </WindowButton>
        </div>
      </div>
    </header>
  )
}

function AppMark() {
  return (
    <span
      aria-hidden
      className="grid size-6 place-items-center rounded-md bg-accent text-accent-contrast"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 3 4 6.6v5.1c0 4.7 3.2 9.1 8 10.3 4.8-1.2 8-5.6 8-10.3V6.6L12 3Z"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
        <path
          d="m8.7 12.1 2.4 2.4 4.2-4.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/**
 * Shows whether the process holds an Administrator token.
 *
 * Surfaced in the chrome, on every screen, because without elevation raw disk
 * scanning silently finds nothing — and a user who does not know that will
 * conclude the product does not work.
 */
function ElevationIndicator({ isElevated }: { isElevated: boolean | null }) {
  const { t } = useTranslation()

  if (isElevated === null) return null

  const Icon = isElevated ? ShieldCheck : ShieldAlert

  return (
    <span
      title={isElevated ? t('titleBar.elevatedHint') : t('titleBar.notElevatedHint')}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium',
        isElevated
          ? 'border-transparent bg-success-soft text-success'
          : 'border-transparent bg-warning-soft text-warning',
      )}
    >
      <Icon size={13} aria-hidden />
      {isElevated ? t('titleBar.elevated') : t('titleBar.notElevated')}
    </span>
  )
}

interface WindowButtonProps {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}

function WindowButton({ label, onClick, danger = false, children }: WindowButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid h-[var(--rx-titlebar-height)] w-12 place-items-center text-ink-muted transition-colors',
        danger ? 'hover:bg-danger hover:text-white' : 'hover:bg-surface-3 hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, CircleCheckBig, RefreshCw, RotateCw } from 'lucide-react'
import { IpcChannel, IpcEvent } from '@shared/ipc/channels'
import type { UpdateState, UpdateStatus } from '@shared/types/diagnostics'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useFormatters } from '@/hooks/useFormatters'
import { invoke, subscribe } from '@/lib/ipc-client'
import { toast } from '@/stores/ui.store'

/**
 * Updates.
 *
 * Checking happens on request, and once shortly after start-up while the user
 * allows it (the main process does that, and this panel simply shows its
 * answer); downloading and installing are separate, explicit steps. This application is often the only thing between a user and
 * lost data, and a four-hour recovery must never lose to a background download
 * or an automatic restart. The main process refuses to install while work is
 * running — the buttons here simply make that visible before it is refused.
 */
export function UpdatePanel() {
  const { t } = useTranslation()
  const format = useFormatters()

  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const response = await invoke(IpcChannel.UpdateGetState, undefined)
      if (response.ok) setState(response.data)
    })()
  }, [])

  useEffect(() => subscribe(IpcEvent.UpdateChanged, setState), [])

  const run = useCallback(
    async (
      channel:
        | typeof IpcChannel.UpdateCheck
        | typeof IpcChannel.UpdateDownload
        | typeof IpcChannel.UpdateInstall,
    ): Promise<void> => {
      setBusy(true)
      const response = await invoke(channel, undefined)
      setBusy(false)

      if (!response.ok) {
        toast.error(response.error.message, response.error.details)
        return
      }

      if (channel !== IpcChannel.UpdateInstall && response.data !== undefined) {
        setState(response.data)
      }
    },
    [],
  )

  if (state === null) return null

  return (
    <Card>
      <CardHeader
        icon={<RotateCw size={16} aria-hidden />}
        title={t('updates.title')}
        description={describe(state, t, format)}
        actions={
          // Neither a development build nor a Store copy is updated from here,
          // and a button that can only ever do nothing is worse than none.
          state.status === 'unsupported' || state.status === 'store-managed' ? null : (
            <Button
              size="sm"
              variant="secondary"
              loading={busy && state.status === 'checking'}
              iconLeft={<RefreshCw size={14} />}
              onClick={() => {
                void run(IpcChannel.UpdateCheck)
              }}
            >
              {t('updates.check')}
            </Button>
          )
        }
      />

      {state.status === 'downloading' && (
        <div className="mt-4">
          <ProgressBar value={state.percent} ariaLabel={t('updates.downloading')} />
          <p className="mt-2 text-[12px] tabular-nums text-ink-muted">
            {format.bytes(state.transferredBytes)} / {format.bytes(state.totalBytes)} ·{' '}
            {format.bytesPerSecond(state.bytesPerSecond)}
          </p>
        </div>
      )}

      {state.releaseNotes !== null && state.status !== 'not-available' && (
        <div className="mt-4 max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-2 p-3">
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
            {state.releaseNotes}
          </p>
        </div>
      )}

      {(state.status === 'available' || state.status === 'downloaded') && (
        <div className="mt-4 flex flex-wrap gap-2">
          {state.status === 'available' ? (
            <Button
              size="sm"
              loading={busy}
              iconLeft={<ArrowDownToLine size={14} />}
              onClick={() => {
                void run(IpcChannel.UpdateDownload)
              }}
            >
              {t('updates.download')}
            </Button>
          ) : (
            <Button
              size="sm"
              loading={busy}
              iconLeft={<CircleCheckBig size={14} />}
              onClick={() => {
                void run(IpcChannel.UpdateInstall)
              }}
            >
              {t('updates.install')}
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']
type Formatters = ReturnType<typeof useFormatters>

function describe(state: UpdateState, t: Translate, format: Formatters): string {
  switch (state.status satisfies UpdateStatus) {
    case 'unsupported':
      return t('updates.unsupported')
    case 'store-managed':
      return t('updates.storeManaged')
    case 'checking':
      return t('updates.checking')
    case 'available':
      return t('updates.available', { version: state.availableVersion ?? '' })
    case 'not-available':
      return t('updates.upToDate', { version: state.currentVersion })
    case 'downloading':
      return t('updates.downloading')
    case 'downloaded':
      return t('updates.readyToInstall', { version: state.availableVersion ?? '' })
    case 'error':
      return state.errorMessage ?? t('updates.failed')
    case 'idle':
      return state.checkedAt === null
        ? t('updates.neverChecked')
        : t('updates.lastChecked', { when: format.relative(state.checkedAt) })
  }
}

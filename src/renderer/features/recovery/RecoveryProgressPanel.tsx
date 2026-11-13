import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Pause, Play, Square } from 'lucide-react'
import { IpcChannel, IpcEvent } from '@shared/ipc/channels'
import type { RecoveryJob, RecoveryProgress } from '@shared/types/recovery'
import { percentOf } from '@shared/utils/bytes'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { StatTile } from '@/components/ui/StatTile'
import { useFormatters } from '@/hooks/useFormatters'
import { invoke, subscribe } from '@/lib/ipc-client'
import { toast } from '@/stores/ui.store'

/**
 * Live recovery status.
 *
 * The outcome breakdown is shown alongside the progress rather than only at the
 * end, because "412 recovered, 3 partial, 1 failed" is the number a user is
 * actually waiting for — and seeing failures accumulate early is what lets them
 * stop and change the destination before the run finishes.
 */

export interface RecoveryProgressPanelProps {
  readonly job: RecoveryJob
  readonly onDone: () => void
}

export function RecoveryProgressPanel({ job, onDone }: RecoveryProgressPanelProps) {
  const { t } = useTranslation()
  const format = useFormatters()

  const [progress, setProgress] = useState<RecoveryProgress | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(
    () =>
      subscribe(IpcEvent.RecoveryProgress, (next) => {
        if (next.jobId === job.id) setProgress(next)
      }),
    [job.id],
  )

  useEffect(() => {
    void (async () => {
      const response = await invoke(IpcChannel.RecoveryGetProgress, { jobId: job.id })
      if (response.ok && response.data !== null) setProgress(response.data)
    })()
  }, [job.id])

  const control = async (
    channel:
      | typeof IpcChannel.RecoveryPause
      | typeof IpcChannel.RecoveryResume
      | typeof IpcChannel.RecoveryCancel,
  ): Promise<void> => {
    setBusy(true)
    const response = await invoke(channel, { jobId: job.id })
    setBusy(false)

    if (!response.ok) toast.error(response.error.message, response.error.details)
  }

  const status = progress?.status ?? job.status
  const isRunning = status === 'running'
  const isPaused = status === 'paused'
  const isFinished = !isRunning && !isPaused

  const percent = percentOf(progress?.recoveredBytes ?? 0, progress?.totalBytes ?? job.totalBytes)

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-ink">{t('recovery.progressTitle')}</h2>
            <Badge tone={statusTone(status)}>{statusLabel(status, t)}</Badge>
          </div>
          <p className="mt-1 truncate text-[12.5px] text-ink-muted" title={job.destination}>
            {job.destination}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              iconLeft={<Pause size={14} />}
              onClick={() => void control(IpcChannel.RecoveryPause)}
            >
              {t('scan.pause')}
            </Button>
          )}
          {isPaused && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              iconLeft={<Play size={14} />}
              onClick={() => void control(IpcChannel.RecoveryResume)}
            >
              {t('scan.resume')}
            </Button>
          )}
          {!isFinished && (
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              iconLeft={<Square size={14} />}
              onClick={() => void control(IpcChannel.RecoveryCancel)}
            >
              {t('scan.stop')}
            </Button>
          )}
          {isFinished && (
            <>
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<FolderOpen size={14} />}
                onClick={() => {
                  void invoke(IpcChannel.AppRevealPath, { path: job.destination })
                }}
              >
                {t('recovery.openFolder')}
              </Button>
              <Button size="sm" onClick={onDone}>
                {t('common.close')}
              </Button>
            </>
          )}
        </div>
      </div>

      <ProgressBar className="mt-4" value={percent} ariaLabel={t('recovery.progressTitle')} />

      {progress?.currentFile != null && isRunning && (
        <p className="mt-2 truncate text-[12px] text-ink-muted">
          {t('recovery.currentFile', { name: progress.currentFile })}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t('recovery.statRecovered')}
          value={format.number(progress?.processedFiles ?? 0)}
          detail={t('recovery.ofTotal', {
            total: format.number(progress?.totalFiles ?? job.totalFiles),
          })}
        />
        <StatTile
          label={t('recovery.statWritten')}
          value={format.bytes(progress?.recoveredBytes ?? 0)}
          detail={format.bytes(progress?.totalBytes ?? job.totalBytes)}
        />
        <StatTile
          label={t('recovery.statRemaining')}
          value={
            progress?.estimatedRemainingMs == null
              ? '—'
              : format.duration(progress.estimatedRemainingMs)
          }
          detail={t('scan.statElapsed', { value: format.duration(progress?.elapsedMs ?? 0) })}
        />
        <StatTile
          label={t('recovery.statSpeed')}
          value={
            (progress?.bytesPerSecond ?? 0) > 0
              ? format.bytesPerSecond(progress?.bytesPerSecond ?? 0)
              : '—'
          }
          detail={t('recovery.statSpeedHint')}
        />
      </div>
    </Card>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

function statusLabel(status: RecoveryJob['status'], t: Translate): string {
  switch (status) {
    case 'queued':
      return t('scan.statusQueued')
    case 'running':
      return t('recovery.statusRunning')
    case 'paused':
      return t('scan.statusPaused')
    case 'completed':
      return t('scan.statusCompleted')
    case 'cancelled':
      return t('scan.statusCancelled')
    case 'failed':
      return t('scan.statusFailed')
  }
}

function statusTone(status: RecoveryJob['status']): BadgeTone {
  switch (status) {
    case 'running':
      return 'accent'
    case 'paused':
      return 'warning'
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
    case 'queued':
      return 'neutral'
  }
}

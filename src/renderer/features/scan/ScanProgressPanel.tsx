import { useTranslation } from 'react-i18next'
import { CircleCheckBig, Pause, Play, Square } from 'lucide-react'
import type { ScanProgress, ScanSession } from '@shared/types/scan'
import { percentOf } from '@shared/utils/bytes'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { StatTile } from '@/components/ui/StatTile'
import { useFormatters } from '@/hooks/useFormatters'

/**
 * Live scan status.
 *
 * The four figures shown are the ones that answer a waiting user's actual
 * questions: how far along is it, how much longer, how much has it found, and
 * is it still moving. Everything else belongs in the log.
 */

export interface ScanProgressPanelProps {
  readonly session: ScanSession
  readonly progress: ScanProgress
  readonly busy: boolean
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onCancel: () => void
}

export function ScanProgressPanel({
  session,
  progress,
  busy,
  onPause,
  onResume,
  onCancel,
}: ScanProgressPanelProps) {
  const { t } = useTranslation()
  const format = useFormatters()

  const percent = percentOf(progress.processed, progress.total)
  const isRunning = progress.status === 'running'
  const isPaused = progress.status === 'paused'
  const isFinished = !isRunning && !isPaused

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-ink">
              {session.volumeLabel ?? session.deviceModel}
            </h2>
            <Badge tone={statusTone(progress.status)}>{statusLabel(progress.status, t)}</Badge>
            <Badge tone="neutral">{session.fileSystem.toUpperCase()}</Badge>
          </div>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            {t('scan.startedAt', { when: format.relative(session.startedAt) })}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              iconLeft={<Pause size={14} />}
              onClick={onPause}
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
              onClick={onResume}
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
              onClick={onCancel}
            >
              {t('scan.stop')}
            </Button>
          )}
        </div>
      </div>

      <ProgressBar
        className="mt-4"
        value={percent}
        // An indeterminate total would otherwise render as a permanent 0%.
        ariaLabel={t('scan.progressLabel')}
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t('scan.statFound')}
          value={format.number(progress.filesFound)}
          detail={format.bytes(progress.bytesFound)}
        />
        <StatTile
          label={t('scan.statProgress')}
          value={progress.total > 0 ? format.percent(percent) : '—'}
          detail={
            progress.total > 0
              ? `${format.number(progress.processed)} / ${format.number(progress.total)}`
              : t('scan.statUnknownTotal')
          }
        />
        <StatTile
          label={t('scan.statRemaining')}
          value={
            progress.estimatedRemainingMs === null
              ? '—'
              : format.duration(progress.estimatedRemainingMs)
          }
          detail={t('scan.statElapsed', { value: format.duration(progress.elapsedMs) })}
        />
        <StatTile
          label={t('scan.statRate')}
          value={progress.filesPerSecond > 0 ? `${format.number(progress.filesPerSecond)}/s` : '—'}
          detail={t('scan.statRateHint')}
        />
      </div>

      {progress.status === 'completed' && (
        <p className="mt-4 flex items-center gap-2 text-[12.5px] text-success">
          <CircleCheckBig size={15} aria-hidden />
          {t('scan.completeSummary', {
            count: progress.filesFound,
            size: format.bytes(progress.bytesFound),
          })}
        </p>
      )}

      {session.errorMessage !== null && (
        <p className="mt-4 text-[12.5px] text-danger">{session.errorMessage}</p>
      )}
    </Card>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

/**
 * Explicit mapping rather than a template-literal key.
 *
 * The translation types are derived from the English locale, so building a key
 * by interpolation defeats the check that every key exists.
 */
function statusLabel(status: ScanProgress['status'], t: Translate): string {
  switch (status) {
    case 'queued':
      return t('scan.statusQueued')
    case 'running':
      return t('scan.statusRunning')
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

function statusTone(status: ScanProgress['status']): BadgeTone {
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
      return 'neutral'
    case 'queued':
      return 'neutral'
  }
}

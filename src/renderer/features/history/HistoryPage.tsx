import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, HardDriveDownload, ScanSearch, Trash2 } from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type { RecoveryJob } from '@shared/types/recovery'
import type { ScanSession } from '@shared/types/scan'
import { percentOf } from '@shared/utils/bytes'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Skeleton } from '@/components/ui/Skeleton'
import { useFormatters } from '@/hooks/useFormatters'
import { invoke } from '@/lib/ipc-client'
import { toast, useUiStore } from '@/stores/ui.store'
import { RecoveryJobDetail } from './RecoveryJobDetail'

/**
 * History.
 *
 * Scans and recoveries share a screen because a user looking for "what happened
 * to my photos" does not think of them as separate systems — they think of one
 * attempt, which had a scan and a restore.
 */

type Tab = 'recoveries' | 'scans'

export function HistoryPage() {
  const { t } = useTranslation()

  const [tab, setTab] = useState<Tab>('recoveries')
  const [jobs, setJobs] = useState<RecoveryJob[] | null>(null)
  const [sessions, setSessions] = useState<ScanSession[] | null>(null)
  const [openJob, setOpenJob] = useState<RecoveryJob | null>(null)
  const requestConfirm = useUiStore((state) => state.requestConfirm)

  const load = useCallback(async (): Promise<void> => {
    const [jobsResponse, sessionsResponse] = await Promise.all([
      invoke(IpcChannel.RecoveryListJobs, undefined),
      invoke(IpcChannel.ScanListSessions, undefined),
    ])

    if (jobsResponse.ok) setJobs(jobsResponse.data)
    else toast.error(jobsResponse.error.message)

    if (sessionsResponse.ok) setSessions(sessionsResponse.data)
    else toast.error(sessionsResponse.error.message)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const remove = useCallback(
    async (job: RecoveryJob): Promise<void> => {
      const confirmed = await requestConfirm({
        title: t('history.deleteTitle'),
        description: t('history.deleteBody'),
        confirmLabel: t('history.deleteConfirm'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      })

      if (!confirmed) return

      const response = await invoke(IpcChannel.RecoveryDeleteJob, { jobId: job.id })

      if (!response.ok) {
        toast.error(response.error.message, response.error.details)
        return
      }

      await load()
    },
    [requestConfirm, t, load],
  )

  if (openJob !== null) {
    return (
      <RecoveryJobDetail
        job={openJob}
        onBack={() => {
          setOpenJob(null)
        }}
      />
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('history.title')} description={t('history.subtitle')} />

      <SegmentedControl
        value={tab}
        segments={[
          {
            value: 'recoveries',
            label: t('history.tabRecoveries'),
            count: jobs?.length ?? 0,
          },
          { value: 'scans', label: t('history.tabScans'), count: sessions?.length ?? 0 },
        ]}
        onValueChange={setTab}
        ariaLabel={t('history.title')}
      />

      {tab === 'recoveries' ? (
        <RecoveryList jobs={jobs} onOpen={setOpenJob} onDelete={(job) => void remove(job)} />
      ) : (
        <ScanList sessions={sessions} />
      )}
    </div>
  )
}

function RecoveryList({
  jobs,
  onOpen,
  onDelete,
}: {
  jobs: RecoveryJob[] | null
  onOpen: (job: RecoveryJob) => void
  onDelete: (job: RecoveryJob) => void
}) {
  const { t } = useTranslation()
  const format = useFormatters()

  if (jobs === null) return <ListSkeleton />

  if (jobs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<HardDriveDownload size={22} />}
          title={t('history.noRecoveries')}
          description={t('history.noRecoveriesHint')}
        />
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => {
        // Files that reached disk in a usable state, as a share of the run.
        const successRate = percentOf(job.recoveredFiles, job.totalFiles)

        return (
          <Card key={job.id} className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[14px] font-medium text-ink" title={job.destination}>
                  {job.destination}
                </span>
                <Badge tone={jobTone(job)}>{jobStatusLabel(job, t)}</Badge>
              </div>

              <p className="text-numeric mt-1 text-[12.5px] text-ink-muted">
                {t('history.recoverySummary', {
                  recovered: format.number(job.recoveredFiles),
                  total: format.number(job.totalFiles),
                  size: format.bytes(job.recoveredBytes),
                })}
              </p>

              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {job.partialFiles > 0 && (
                  <Badge dense tone="warning">
                    {t('history.badgePartial', { count: job.partialFiles })}
                  </Badge>
                )}
                {job.failedFiles > 0 && (
                  <Badge dense tone="danger">
                    {t('history.badgeFailed', { count: job.failedFiles })}
                  </Badge>
                )}
                {job.skippedFiles > 0 && (
                  <Badge dense tone="neutral">
                    {t('history.badgeSkipped', { count: job.skippedFiles })}
                  </Badge>
                )}
                {job.mismatchedFiles > 0 && (
                  <Badge dense tone="danger">
                    {t('history.badgeMismatched', { count: job.mismatchedFiles })}
                  </Badge>
                )}
              </div>

              <p className="text-numeric mt-1.5 text-[11.5px] text-ink-subtle">
                {format.relative(job.startedAt)} · {format.percent(successRate)}{' '}
                {t('history.intact')}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => onOpen(job)}>
                {t('history.viewFiles')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<FolderOpen size={14} />}
                aria-label={t('recovery.openFolder')}
                onClick={() => {
                  void invoke(IpcChannel.AppRevealPath, { path: job.destination })
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<Trash2 size={14} />}
                aria-label={t('history.deleteConfirm')}
                onClick={() => {
                  onDelete(job)
                }}
              />
            </div>
          </Card>
        )
      })}
    </div>
  )
}

function ScanList({ sessions }: { sessions: ScanSession[] | null }) {
  const { t } = useTranslation()
  const format = useFormatters()

  if (sessions === null) return <ListSkeleton />

  if (sessions.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<ScanSearch size={22} />}
          title={t('history.noScans')}
          description={t('history.noScansHint')}
        />
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {sessions.map((session) => (
        <Card key={session.id} className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[14px] font-medium text-ink">
                {session.volumeLabel ?? session.deviceModel}
              </span>
              <Badge tone="neutral">{session.fileSystem.toUpperCase()}</Badge>
              <Badge tone={sessionTone(session.status)}>{session.status}</Badge>
            </div>
            <p className="text-numeric mt-1 text-[12.5px] text-ink-muted">
              {t('history.scanSummary', {
                count: format.number(session.filesFound),
                size: format.bytes(session.bytesFound),
              })}
            </p>
            <p className="text-numeric mt-1 text-[11.5px] text-ink-subtle">
              {format.relative(session.startedAt)}
              {session.finishedAt !== null &&
                ` · ${format.duration(session.finishedAt - session.startedAt)}`}
            </p>
          </div>
        </Card>
      ))}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-24 w-full" />
      ))}
    </div>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

function jobStatusLabel(job: RecoveryJob, t: Translate): string {
  switch (job.status) {
    case 'completed':
      return t('scan.statusCompleted')
    case 'cancelled':
      return t('scan.statusCancelled')
    case 'failed':
      return t('scan.statusFailed')
    case 'paused':
      return t('scan.statusPaused')
    case 'running':
      return t('recovery.statusRunning')
    case 'queued':
      return t('scan.statusQueued')
  }
}

/**
 * A completed run with failures is not simply "complete".
 *
 * Colouring it green would tell a user everything worked when some of their
 * files did not come back.
 */
function jobTone(job: RecoveryJob): BadgeTone {
  if (job.status === 'failed') return 'danger'
  if (job.status === 'running') return 'accent'
  if (job.status === 'paused') return 'warning'
  if (job.status === 'cancelled') return 'neutral'

  if (job.failedFiles > 0 || job.mismatchedFiles > 0) return 'warning'
  return 'success'
}

function sessionTone(status: ScanSession['status']): BadgeTone {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'running':
      return 'accent'
    case 'paused':
      return 'warning'
    case 'cancelled':
    case 'queued':
      return 'neutral'
  }
}

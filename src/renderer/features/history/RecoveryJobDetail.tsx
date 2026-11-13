import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FileWarning } from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type { RecoveryItem, RecoveryItemStatus, RecoveryJob } from '@shared/types/recovery'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/layout/PageHeader'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { useFormatters } from '@/hooks/useFormatters'
import { useVirtualRows } from '@/hooks/useVirtualRows'
import { cn } from '@/lib/cn'
import { invoke } from '@/lib/ipc-client'
import { toast } from '@/stores/ui.store'

/**
 * Per-file outcomes for one recovery.
 *
 * The default view is *everything that did not come back cleanly*, because that
 * is the list a user needs to act on. A run where four thousand files succeeded
 * and three failed should open on the three.
 */

const ROW_HEIGHT = 36
const PAGE_SIZE = 500

type Tab = 'problems' | 'all'

/** Outcomes that warrant the user's attention. */
const PROBLEM_STATUSES: RecoveryItemStatus[] = ['partial', 'failed', 'skipped']

export interface RecoveryJobDetailProps {
  readonly job: RecoveryJob
  readonly onBack: () => void
}

export function RecoveryJobDetail({ job, onBack }: RecoveryJobDetailProps) {
  const { t } = useTranslation()
  const format = useFormatters()
  const scrollRef = useRef<HTMLDivElement>(null)

  const problemCount = job.partialFiles + job.failedFiles + job.skippedFiles

  // Open on the problems unless there are none to show.
  const [tab, setTab] = useState<Tab>(problemCount > 0 ? 'problems' : 'all')
  const [items, setItems] = useState<RecoveryItem[] | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setItems(null)

    const response = await invoke(IpcChannel.RecoveryListItems, {
      jobId: job.id,
      ...(tab === 'problems' ? { statuses: PROBLEM_STATUSES } : {}),
      limit: PAGE_SIZE,
      offset: 0,
    })

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      setItems([])
      return
    }

    setItems(response.data)
  }, [job.id, tab])

  useEffect(() => {
    void load()
  }, [load])

  const rows = items ?? []
  const range = useVirtualRows(scrollRef, { count: rows.length, rowHeight: ROW_HEIGHT })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('history.detailTitle')}
        description={job.destination}
        actions={
          <Button size="sm" variant="secondary" iconLeft={<ArrowLeft size={14} />} onClick={onBack}>
            {t('history.back')}
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t('history.statRecovered')}
          value={format.number(job.recoveredFiles)}
          detail={format.bytes(job.recoveredBytes)}
        />
        <StatTile label={t('history.statPartial')} value={format.number(job.partialFiles)} />
        <StatTile label={t('history.statFailed')} value={format.number(job.failedFiles)} />
        <StatTile
          label={t('history.statMismatched')}
          value={format.number(job.mismatchedFiles)}
          detail={t('history.statMismatchedHint')}
        />
      </div>

      <SegmentedControl
        value={tab}
        segments={[
          { value: 'problems', label: t('history.tabProblems'), count: problemCount },
          { value: 'all', label: t('history.tabAll'), count: job.totalFiles },
        ]}
        onValueChange={setTab}
        ariaLabel={t('history.detailTitle')}
      />

      <Card flush className="overflow-hidden">
        {items === null ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            className="py-12"
            icon={<FileWarning size={22} />}
            title={tab === 'problems' ? t('history.noProblems') : t('history.noItems')}
            {...(tab === 'problems' ? { description: t('history.noProblemsHint') } : {})}
          />
        ) : (
          <div ref={scrollRef} className="max-h-[30rem] overflow-y-auto">
            <div style={{ paddingTop: range.paddingTop, paddingBottom: range.paddingBottom }}>
              {rows.slice(range.startIndex, range.endIndex).map((item) => (
                <ItemRow key={`${item.fileId}:${item.targetPath}`} item={item} />
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function ItemRow({ item }: { item: RecoveryItem }) {
  const { t } = useTranslation()
  const format = useFormatters()

  return (
    <div
      className="flex items-center gap-3 border-b border-line/60 px-4 text-[12.5px]"
      style={{ height: ROW_HEIGHT }}
    >
      <span className="min-w-0 flex-1 truncate text-ink" title={item.targetPath}>
        {item.name}
      </span>

      <span className="text-numeric w-24 shrink-0 text-right text-ink-muted">
        {item.status === 'partial'
          ? `${format.bytes(item.bytesWritten)} / ${format.bytes(item.expectedBytes)}`
          : format.bytes(item.bytesWritten)}
      </span>

      {item.verification === 'mismatch' && (
        <Badge dense tone="danger">
          {t('preview.badgeMismatch')}
        </Badge>
      )}

      <span className="w-20 shrink-0">
        <Badge dense tone={itemTone(item.status)}>
          {itemLabel(item.status, t)}
        </Badge>
      </span>

      <span
        className={cn(
          'w-40 shrink-0 truncate text-[11.5px] text-ink-subtle',
          item.error === null && 'invisible',
        )}
        title={item.error ?? ''}
      >
        {item.error ?? ''}
      </span>
    </div>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

function itemLabel(status: RecoveryItemStatus, t: Translate): string {
  switch (status) {
    case 'recovered':
      return t('history.itemRecovered')
    case 'partial':
      return t('history.itemPartial')
    case 'skipped':
      return t('history.itemSkipped')
    case 'failed':
      return t('history.itemFailed')
  }
}

function itemTone(status: RecoveryItemStatus): BadgeTone {
  switch (status) {
    case 'recovered':
      return 'success'
    case 'partial':
      return 'warning'
    case 'skipped':
      return 'neutral'
    case 'failed':
      return 'danger'
  }
}

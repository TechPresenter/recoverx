import { Suspense, lazy, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  Cpu,
  MemoryStick,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Timer,
} from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type { AppInfo, SystemSnapshot } from '@shared/types/system'
import { formatDuration } from '@shared/utils/time'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { DefinitionRow, StatTile } from '@/components/ui/StatTile'
import { useFormatters } from '@/hooks/useFormatters'
import { usePolling } from '@/hooks/usePolling'
import { invoke } from '@/lib/ipc-client'
import { cn } from '@/lib/cn'
import type { ActivitySample } from './ActivityChart'

/**
 * Chart.js is ~320 kB — larger than the entire rest of the renderer. Loading it
 * lazily keeps it off the first-paint path: the dashboard's numbers appear
 * immediately, and the chart fills in a frame later, by which time only one
 * sample exists anyway.
 */
const ActivityChart = lazy(async () => ({
  default: (await import('./ActivityChart')).ActivityChart,
}))

/** Two minutes of history at the two-second poll interval. */
const MAX_SAMPLES = 60
const POLL_INTERVAL_MS = 2000

/**
 * Dashboard.
 *
 * The overview of RecoverX's own state and the machine it is running on. As
 * later modules land, device inventory, scan progress and disk health join this
 * screen; the resource meters below remain, because a scan's throughput is
 * bounded by exactly these numbers.
 */
export function DashboardPage() {
  const { t } = useTranslation()
  const format = useFormatters()

  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [samples, setSamples] = useState<readonly ActivitySample[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    const [snapshotResult, infoResult] = await Promise.all([
      invoke(IpcChannel.SystemGetSnapshot, undefined),
      appInfo === null ? invoke(IpcChannel.AppGetInfo, undefined) : Promise.resolve(null),
    ])

    if (snapshotResult.ok) {
      setSnapshot(snapshotResult.data)
      setSamples((previous) =>
        [
          ...previous,
          {
            cpu: snapshotResult.data.cpu.utilizationPercent,
            memory: snapshotResult.data.memory.usagePercent,
          },
        ].slice(-MAX_SAMPLES),
      )
    }

    if (infoResult?.ok === true) {
      setAppInfo(infoResult.data)
    }
  }, [appInfo])

  usePolling(refresh, POLL_INTERVAL_MS)

  const onManualRefresh = useCallback(() => {
    setRefreshing(true)
    void refresh().finally(() => {
      setRefreshing(false)
    })
  }, [refresh])

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.subtitle')}
        actions={
          <Button
            size="sm"
            variant="secondary"
            loading={refreshing}
            onClick={onManualRefresh}
            iconLeft={<RefreshCw size={14} />}
          >
            {t('common.refresh')}
          </Button>
        }
      />

      <ElevationCallout isElevated={snapshot?.isElevated ?? null} />

      <section
        aria-label={t('dashboard.systemHealth')}
        className="grid grid-cols-2 gap-4 xl:grid-cols-4"
      >
        {snapshot === null ? (
          Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[7.5rem]" />)
        ) : (
          <>
            <StatTile
              label={t('dashboard.cpuUsage')}
              icon={<Cpu size={15} />}
              value={
                snapshot.cpu.utilizationPercent === null
                  ? t('dashboard.waitingForSample')
                  : `${snapshot.cpu.utilizationPercent.toFixed(0)}%`
              }
              detail={t(
                snapshot.cpu.logicalCores === 1 ? 'dashboard.coresOne' : 'dashboard.cores',
                {
                  count: snapshot.cpu.logicalCores,
                },
              )}
              {...(snapshot.cpu.utilizationPercent === null
                ? {}
                : { meter: snapshot.cpu.utilizationPercent })}
            />

            <StatTile
              label={t('dashboard.memoryUsage')}
              icon={<MemoryStick size={15} />}
              value={`${snapshot.memory.usagePercent.toFixed(0)}%`}
              detail={t('dashboard.usedOfTotal', {
                used: format.bytes(snapshot.memory.usedBytes),
                total: format.bytes(snapshot.memory.totalBytes),
              })}
              meter={snapshot.memory.usagePercent}
            />

            <StatTile
              label={t('dashboard.processMemory')}
              icon={<Activity size={15} />}
              value={format.bytes(snapshot.process.rssBytes)}
              detail={`${format.bytes(snapshot.process.heapUsedBytes)} ${t('common.of')} ${format.bytes(snapshot.process.heapTotalBytes)}`}
            />

            <StatTile
              label={t('dashboard.appUptime')}
              icon={<Timer size={15} />}
              value={formatDuration(snapshot.process.uptimeMs)}
              detail={`${t('dashboard.systemUptime')}: ${formatDuration(snapshot.os.uptimeMs)}`}
            />
          </>
        )}
      </section>

      <Card>
        <CardHeader
          icon={<Activity size={16} />}
          title={t('dashboard.activity')}
          description={t('dashboard.activityHint')}
          actions={
            <div className="flex items-center gap-3 text-[12px] text-ink-muted">
              <LegendSwatch className="bg-accent" label={t('dashboard.seriesCpu')} />
              <LegendSwatch className="bg-info" label={t('dashboard.seriesMemory')} dashed />
            </div>
          }
        />

        <div className="mt-4">
          {samples.length === 0 ? (
            <Skeleton className="h-44 w-full" />
          ) : (
            <Suspense fallback={<Skeleton className="h-44 w-full" />}>
              <ActivityChart
                samples={samples}
                cpuLabel={t('dashboard.seriesCpu')}
                memoryLabel={t('dashboard.seriesMemory')}
              />
            </Suspense>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={t('dashboard.environment')} />

        <dl className="mt-3">
          {snapshot === null || appInfo === null ? (
            Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="my-2.5 h-4 w-full" />
            ))
          ) : (
            <>
              <DefinitionRow term={t('dashboard.operatingSystem')} selectable>
                {snapshot.os.distro}
              </DefinitionRow>
              <DefinitionRow term={t('dashboard.processor')} selectable>
                {snapshot.cpu.model}
              </DefinitionRow>
              <DefinitionRow term={t('dashboard.hostname')} selectable>
                {snapshot.os.hostname}
              </DefinitionRow>
              <DefinitionRow term={t('dashboard.appVersion')} selectable>
                {appInfo.version}
              </DefinitionRow>
              <DefinitionRow term={t('dashboard.build')}>
                {appInfo.isPackaged
                  ? t('dashboard.buildPackaged')
                  : t('dashboard.buildDevelopment')}
              </DefinitionRow>
              <DefinitionRow term={t('about.platform')} selectable>
                {`${appInfo.platform} · ${appInfo.arch}`}
              </DefinitionRow>
            </>
          )}
        </dl>
      </Card>
    </div>
  )
}

function LegendSwatch({
  className,
  label,
  dashed = false,
}: {
  className: string
  label: string
  dashed?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn('h-0.5 w-4 rounded-full', className, dashed && 'opacity-70')}
      />
      {label}
    </span>
  )
}

/**
 * Elevation state, stated prominently.
 *
 * Without an Administrator token every raw-device scan returns nothing, and the
 * failure looks like a broken product rather than a permissions problem. Saying
 * so on the first screen, before a scan is ever started, is the difference
 * between a refund request and a thirty-second fix.
 */
function ElevationCallout({ isElevated }: { isElevated: boolean | null }) {
  const { t } = useTranslation()

  if (isElevated === null) return null

  const Icon = isElevated ? ShieldCheck : ShieldAlert

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-card border p-4',
        isElevated
          ? 'border-line bg-success-soft/50 text-ink'
          : 'border-warning/30 bg-warning-soft/60 text-ink',
      )}
    >
      <Icon
        size={18}
        aria-hidden
        className={cn('mt-0.5 shrink-0', isElevated ? 'text-success' : 'text-warning')}
      />
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium">
          {isElevated ? t('dashboard.elevationOk') : t('dashboard.elevationMissing')}
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">
          {isElevated ? t('dashboard.elevationOkBody') : t('dashboard.elevationMissingBody')}
        </p>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { CircleCheckBig, HardDrive, Search, ShieldCheck, Square, XCircle } from 'lucide-react'
import { IpcChannel, IpcEvent } from '@shared/ipc/channels'
import { AppRoute } from '@shared/constants/routes'
import type { DeviceInventory, StorageDevice } from '@shared/types/disk'
import type {
  PartitionCandidate,
  PartitionConfidence,
  PartitionEvidence,
  PartitionSearchProgress,
  PartitionSearchResult,
  PartitionSearchScope,
  PartitionSearchStatus,
} from '@shared/types/partition-search'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { useFormatters } from '@/hooks/useFormatters'
import { invoke, subscribe } from '@/lib/ipc-client'
import { cn } from '@/lib/cn'
import { toast } from '@/stores/ui.store'

/**
 * Lost-partition search.
 *
 * The screen exists for one situation: a drive that Windows will not open, or
 * that shows the wrong size, because its partition table no longer describes
 * what is on it. Searching finds the volumes themselves — their data was never
 * touched — and adds them to the device so they can be scanned.
 *
 * It never offers to rewrite the table. Repairing the disk in place is the one
 * operation that can turn a recoverable drive into an unrecoverable one, and
 * copying the files off to somewhere else gets the user what they actually
 * came for without that risk.
 */
export function PartitionsPage() {
  const { t } = useTranslation()
  const format = useFormatters()
  const navigate = useNavigate()

  const [inventory, setInventory] = useState<DeviceInventory | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [scope, setScope] = useState<PartitionSearchScope>('unallocated')
  const [search, setSearch] = useState<PartitionSearchResult | null>(null)
  const [progress, setProgress] = useState<PartitionSearchProgress | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Candidates arrive with progress, but re-fetching the full result on every
   * tick would query four times a second for a list that changes rarely. The
   * count is the cheap signal that something new was found.
   */
  const lastCandidateCount = useRef(0)

  useEffect(() => {
    void (async () => {
      const response = await invoke(IpcChannel.DiskList, undefined)

      if (!response.ok) {
        toast.error(response.error.message, response.error.details)
        return
      }

      setInventory(response.data)
    })()
  }, [])

  const refreshResult = useCallback(async (searchId: string): Promise<void> => {
    const response = await invoke(IpcChannel.PartitionSearchGet, { searchId })
    if (response.ok) setSearch(response.data)
  }, [])

  useEffect(
    () =>
      subscribe(IpcEvent.PartitionSearchProgress, (next) => {
        setProgress((current) =>
          current === null || current.searchId === next.searchId ? next : current,
        )

        const finished = next.status !== 'running'
        if (next.candidatesFound !== lastCandidateCount.current || finished) {
          lastCandidateCount.current = next.candidatesFound
          void refreshResult(next.searchId)
        }
      }),
    [refreshResult],
  )

  const devices = inventory?.devices ?? []
  const selected = devices.find((device) => device.id === deviceId) ?? null
  const running = progress?.status === 'running'

  const start = useCallback(async (): Promise<void> => {
    if (deviceId === null) return

    setBusy(true)
    const response = await invoke(IpcChannel.PartitionSearchStart, { deviceId, scope })
    setBusy(false)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    lastCandidateCount.current = 0
    setSearch(response.data)
    setProgress({
      searchId: response.data.searchId,
      deviceId: response.data.deviceId,
      status: 'running',
      bytesScanned: 0,
      bytesTotal: response.data.bytesTotal,
      currentOffsetBytes: 0,
      candidatesFound: 0,
      elapsedMs: 0,
      estimatedRemainingMs: null,
      bytesPerSecond: 0,
    })
  }, [deviceId, scope])

  const stop = useCallback(async (): Promise<void> => {
    if (search === null) return

    const response = await invoke(IpcChannel.PartitionSearchCancel, { searchId: search.searchId })
    if (!response.ok) toast.error(response.error.message, response.error.details)
  }, [search])

  /**
   * Add the found volumes to the device, then hand over to the scanner.
   *
   * Adoption is what makes them ordinary scan targets; without it the scan
   * screen would have nothing to select. It changes this application's model of
   * the disk only — the disk itself is not written to.
   */
  const adopt = useCallback(async (): Promise<void> => {
    if (search === null) return

    setBusy(true)
    const response = await invoke(IpcChannel.PartitionAdopt, { searchId: search.searchId })
    setBusy(false)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    toast.success(
      t('partitions.adopted', { count: response.data.partitions.filter(isRecovered).length }),
    )
    void navigate(AppRoute.Scan)
  }, [search, navigate, t])

  const percent = useMemo(() => {
    if (progress === null || progress.bytesTotal === 0) return 0
    return Math.min(100, (progress.bytesScanned / progress.bytesTotal) * 100)
  }, [progress])

  const candidates = search?.candidates ?? []

  return (
    <div className="space-y-6">
      <PageHeader title={t('partitions.title')} description={t('partitions.subtitle')} />

      {/* Stated before anything is started, not after. A user arriving here has
          already been told by other tools to "repair" the disk, and needs to
          know why this one will not. */}
      <Card className="border-accent/40 bg-accent-soft/25">
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink">{t('partitions.safetyTitle')}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
              {t('partitions.safetyBody')}
            </p>
          </div>
        </div>
      </Card>

      {inventory === null ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Card>
          <CardHeader
            title={t('partitions.chooseDevice')}
            description={t('partitions.chooseDeviceHint')}
            icon={<HardDrive size={16} aria-hidden />}
          />

          <div className="mt-4 space-y-2">
            {devices.length === 0 ? (
              <EmptyState
                title={t('partitions.noDevices')}
                description={t('partitions.noDevicesHint')}
              />
            ) : (
              devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  selected={device.id === deviceId}
                  disabled={running}
                  onSelect={() => {
                    setDeviceId(device.id)
                  }}
                  freeLabel={format.bytes(totalUnallocated(device))}
                  sizeLabel={format.bytes(device.sizeBytes)}
                />
              ))
            )}
          </div>

          {selected !== null && (
            <div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-t border-line pt-5">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                  {t('partitions.scope')}
                </p>
                <SegmentedControl
                  className="mt-2"
                  size="sm"
                  value={scope}
                  ariaLabel={t('partitions.scope')}
                  onValueChange={setScope}
                  segments={[
                    { value: 'unallocated', label: t('partitions.scopeFree') },
                    { value: 'whole-device', label: t('partitions.scopeAll') },
                  ]}
                />
                <p className="mt-2 max-w-md text-[12px] leading-relaxed text-ink-muted">
                  {scope === 'unallocated'
                    ? t('partitions.scopeFreeHint')
                    : t('partitions.scopeAllHint')}
                </p>
              </div>

              {running ? (
                <Button
                  variant="secondary"
                  iconLeft={<Square size={14} />}
                  onClick={() => {
                    void stop()
                  }}
                >
                  {t('partitions.stop')}
                </Button>
              ) : (
                <Button
                  iconLeft={<Search size={14} />}
                  loading={busy}
                  onClick={() => {
                    void start()
                  }}
                >
                  {t('partitions.start')}
                </Button>
              )}
            </div>
          )}
        </Card>
      )}

      {progress !== null && (
        <Card>
          <CardHeader
            title={t(running ? 'partitions.searching' : 'partitions.searchFinished')}
            description={
              running
                ? t('partitions.searchingAt', {
                    offset: format.bytes(progress.currentOffsetBytes),
                  })
                : statusLabel(progress.status, t)
            }
          />

          <ProgressBar className="mt-4" value={percent} ariaLabel={t('partitions.progress')} />

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={t('partitions.searched')}
              value={format.bytes(progress.bytesScanned)}
              detail={format.bytes(progress.bytesTotal)}
            />
            <StatTile
              label={t('partitions.found')}
              value={format.number(progress.candidatesFound)}
            />
            <StatTile
              label={t('partitions.speed')}
              value={format.bytesPerSecond(progress.bytesPerSecond)}
            />
            <StatTile
              label={t('partitions.remaining')}
              value={
                progress.estimatedRemainingMs === null
                  ? '—'
                  : format.duration(progress.estimatedRemainingMs)
              }
              detail={format.duration(progress.elapsedMs)}
            />
          </div>
        </Card>
      )}

      {search !== null && (
        <Card>
          <CardHeader
            title={t('partitions.results')}
            description={t('partitions.resultsHint')}
            actions={
              candidates.length > 0 && (
                <Button
                  size="sm"
                  loading={busy}
                  iconLeft={<CircleCheckBig size={14} />}
                  onClick={() => {
                    void adopt()
                  }}
                >
                  {t('partitions.useThese')}
                </Button>
              )
            }
          />

          <div className="mt-4 space-y-2">
            {candidates.length === 0 ? (
              <EmptyState
                icon={<XCircle size={20} aria-hidden />}
                title={t(running ? 'partitions.noneYet' : 'partitions.noneFound')}
                description={running ? t('partitions.noneYetHint') : t('partitions.noneFoundHint')}
              />
            ) : (
              candidates.map((candidate) => (
                <CandidateRow key={candidate.id} candidate={candidate} format={format} />
              ))
            )}
          </div>

          {search.warnings.length > 0 && (
            <div className="mt-4 space-y-1 border-t border-line pt-4">
              {search.warnings.slice(0, 5).map((warning) => (
                <p key={warning} className="text-[12px] text-warning">
                  {warning}
                </p>
              ))}
              {search.warnings.length > 5 && (
                <p className="text-[12px] text-ink-subtle">
                  {t('partitions.moreWarnings', { count: search.warnings.length - 5 })}
                </p>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

// --- rows ------------------------------------------------------------------

interface DeviceRowProps {
  readonly device: StorageDevice
  readonly selected: boolean
  readonly disabled: boolean
  readonly onSelect: () => void
  readonly freeLabel: string
  readonly sizeLabel: string
}

function DeviceRow({ device, selected, disabled, onSelect, freeLabel, sizeLabel }: DeviceRowProps) {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
        selected ? 'border-accent bg-accent-soft/40' : 'border-line hover:border-line-strong',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <HardDrive size={17} className="shrink-0 text-ink-muted" aria-hidden />

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink">{device.model}</span>
          {device.isSystem && (
            <Badge dense tone="warning">
              {t('partitions.systemDisk')}
            </Badge>
          )}
        </span>
        <span className="mt-0.5 block text-[12px] text-ink-muted">
          {sizeLabel} · {t('partitions.freeSpace', { size: freeLabel })}
        </span>
      </span>
    </button>
  )
}

interface CandidateRowProps {
  readonly candidate: PartitionCandidate
  readonly format: ReturnType<typeof useFormatters>
}

function CandidateRow({ candidate, format }: CandidateRowProps) {
  const { t } = useTranslation()

  return (
    <div className="rounded-xl border border-line p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate text-[13.5px] font-semibold text-ink">
            {candidate.label ?? t('partitions.unnamed')}
          </span>
          <Badge dense tone="neutral">
            {candidate.fileSystem.toUpperCase()}
          </Badge>
          <Badge dense tone={confidenceTone(candidate.confidence)}>
            {confidenceLabel(candidate.confidence, t)}
          </Badge>
        </div>

        <span className="text-[13px] font-medium tabular-nums text-ink">
          {format.bytes(candidate.sizeBytes)}
        </span>
      </div>

      <p className="mt-1.5 text-[12px] text-ink-muted">
        {t('partitions.atOffset', { offset: format.bytes(candidate.offsetBytes) })}
        {candidate.clusterSizeBytes !== null &&
          ` · ${t('partitions.clusterSize', { size: format.bytes(candidate.clusterSizeBytes) })}`}
        {!candidate.supportsQuickScan && ` · ${t('partitions.deepScanOnly')}`}
      </p>

      {/* Why the app believes this is real. A user deciding whether to trust a
          found partition deserves the evidence, not just a verdict. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {candidate.evidence.map((item) => (
          <span
            key={item}
            className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-subtle"
          >
            {evidenceLabel(item, t)}
          </span>
        ))}
      </div>
    </div>
  )
}

// --- labels ----------------------------------------------------------------

type Translate = ReturnType<typeof useTranslation>['t']

function statusLabel(status: PartitionSearchStatus, t: Translate): string {
  switch (status) {
    case 'running':
      return t('partitions.status.running')
    case 'completed':
      return t('partitions.status.completed')
    case 'cancelled':
      return t('partitions.status.cancelled')
    case 'failed':
      return t('partitions.status.failed')
  }
}

function confidenceTone(confidence: PartitionConfidence): 'success' | 'accent' | 'neutral' {
  switch (confidence) {
    case 'confirmed':
      return 'success'
    case 'likely':
      return 'accent'
    case 'possible':
      return 'neutral'
  }
}

function confidenceLabel(confidence: PartitionConfidence, t: Translate): string {
  switch (confidence) {
    case 'confirmed':
      return t('partitions.confidence.confirmed')
    case 'likely':
      return t('partitions.confidence.likely')
    case 'possible':
      return t('partitions.confidence.possible')
  }
}

function evidenceLabel(evidence: PartitionEvidence, t: Translate): string {
  switch (evidence) {
    case 'boot-sector':
      return t('partitions.evidence.bootSector')
    case 'backup-boot-sector':
      return t('partitions.evidence.backupBootSector')
    case 'self-reported-size':
      return t('partitions.evidence.selfReportedSize')
    case 'estimated-size':
      return t('partitions.evidence.estimatedSize')
    case 'size-clipped':
      return t('partitions.evidence.sizeClipped')
  }
}

// --- helpers ---------------------------------------------------------------

function totalUnallocated(device: StorageDevice): number {
  return device.unallocated.reduce((sum, region) => sum + region.sizeBytes, 0)
}

function isRecovered(partition: { readonly isRecovered: boolean }): boolean {
  return partition.isRecovered
}

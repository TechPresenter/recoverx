import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  Activity,
  ChevronDown,
  HardDrive,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import { AppRoute } from '@shared/constants/routes'
import type { DeviceInventory } from '@shared/types/disk'
import type {
  AttributeStatus,
  DriveHealth,
  DriveHealthStatus,
  HealthFinding,
  HealthReport,
  HealthUnavailable,
  SmartAttribute,
} from '@shared/types/health'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { useFormatters } from '@/hooks/useFormatters'
import { invoke } from '@/lib/ipc-client'
import { cn } from '@/lib/cn'
import { toast } from '@/stores/ui.store'

/**
 * Drive health.
 *
 * For a recovery product this screen is not a status readout — it decides the
 * order of the work. A drive with unreadable sectors gets worse every time it
 * is read, so on such a drive the right first move is one sequential image and
 * then recovery from that copy. Running deep scan after deep scan against
 * failing hardware is how a recoverable disk becomes an unrecoverable one, and
 * that warning belongs here, before the user starts.
 */
export function HealthPage() {
  const { t } = useTranslation()

  const [report, setReport] = useState<HealthReport | null>(null)
  const [inventory, setInventory] = useState<DeviceInventory | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    setBusy(true)
    const response = await invoke(
      refresh ? IpcChannel.HealthRefresh : IpcChannel.HealthGet,
      undefined,
    )
    setBusy(false)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    setReport(response.data)
  }, [])

  useEffect(() => {
    void (async () => {
      const devices = await invoke(IpcChannel.DiskList, undefined)
      if (devices.ok) setInventory(devices.data)

      await load(false)
    })()
  }, [load])

  const modelFor = useCallback(
    (deviceId: string): string =>
      inventory?.devices.find((device) => device.id === deviceId)?.model ?? deviceId,
    [inventory],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('health.title')}
        description={t('health.subtitle')}
        actions={
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            iconLeft={<RefreshCw size={14} />}
            onClick={() => {
              void load(true)
            }}
          >
            {t('health.refresh')}
          </Button>
        }
      />

      {report === null ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-56 w-full" />
          ))}
        </div>
      ) : report.drives.length === 0 ? (
        <EmptyState
          icon={<HardDrive size={20} aria-hidden />}
          title={t('health.noDrives')}
          description={t('health.noDrivesHint')}
        />
      ) : (
        report.drives.map((drive) => (
          <DriveCard key={drive.deviceId} drive={drive} model={modelFor(drive.deviceId)} />
        ))
      )}

      {report !== null && report.warnings.length > 0 && (
        <Card>
          {report.warnings.map((warning) => (
            <p key={warning} className="text-[12.5px] text-ink-muted">
              {warning}
            </p>
          ))}
        </Card>
      )}
    </div>
  )
}

// --- One drive -------------------------------------------------------------

interface DriveCardProps {
  readonly drive: DriveHealth
  readonly model: string
}

function DriveCard({ drive, model }: DriveCardProps) {
  const { t } = useTranslation()
  const format = useFormatters()
  const [showAttributes, setShowAttributes] = useState(false)

  return (
    <Card>
      <CardHeader
        title={model}
        description={
          drive.unavailable === null
            ? t('health.scoreOf', { score: format.number(drive.score) })
            : unavailableLabel(drive.unavailable, t)
        }
        icon={<StatusIcon status={drive.status} />}
        actions={<Badge tone={statusTone(drive.status)}>{statusLabel(drive.status, t)}</Badge>}
      />

      {/*
       * The action, before the data. A user who reads no further than the first
       * paragraph must still learn that scanning this drive directly is the
       * wrong next step.
       */}
      {drive.imageBeforeScanning && (
        <div className="mt-4 rounded-xl border border-danger/40 bg-danger-soft/30 p-4">
          <div className="flex items-start gap-3">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-ink">{t('health.imageFirstTitle')}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                {t('health.imageFirstBody')}
              </p>
              <Link
                to={AppRoute.Devices}
                className="mt-2 inline-block text-[12.5px] font-medium text-accent hover:underline"
              >
                {t('health.imageFirstAction')}
              </Link>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t('health.temperature')}
          value={
            drive.temperatureCelsius === null
              ? '—'
              : `${format.number(drive.temperatureCelsius)} °C`
          }
        />
        <StatTile
          label={t('health.powerOnHours')}
          value={drive.powerOnHours === null ? '—' : format.number(drive.powerOnHours)}
          detail={
            drive.powerOnHours === null
              ? undefined
              : t('health.years', { years: (drive.powerOnHours / 8760).toFixed(1) })
          }
        />
        <StatTile
          label={t('health.reallocated')}
          value={drive.reallocatedSectors === null ? '—' : format.number(drive.reallocatedSectors)}
        />
        <StatTile
          label={drive.lifeRemainingPercent === null ? t('health.pending') : t('health.lifeLeft')}
          value={
            drive.lifeRemainingPercent !== null
              ? `${format.number(drive.lifeRemainingPercent)}%`
              : drive.pendingSectors === null
                ? '—'
                : format.number(drive.pendingSectors)
          }
          {...(drive.lifeRemainingPercent === null
            ? {}
            : { meter: 100 - drive.lifeRemainingPercent })}
        />
      </div>

      {drive.findings.length > 0 && (
        <div className="mt-4 space-y-2">
          {drive.findings.map((finding) => (
            <FindingRow key={finding.code} finding={finding} />
          ))}
        </div>
      )}

      {drive.findings.length === 0 && drive.status === 'good' && (
        <p className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-muted">
          <ShieldCheck size={15} className="text-success" aria-hidden />
          {t('health.noProblems')}
        </p>
      )}

      {drive.attributes.length > 0 && (
        <div className="mt-4 border-t border-line pt-4">
          <button
            type="button"
            aria-expanded={showAttributes}
            onClick={() => {
              setShowAttributes((value) => !value)
            }}
            className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-muted hover:text-ink"
          >
            <ChevronDown
              size={14}
              className={cn('transition-transform', showAttributes && 'rotate-180')}
              aria-hidden
            />
            {t('health.attributes', { count: drive.attributes.length })}
          </button>

          {showAttributes && <AttributeTable attributes={drive.attributes} />}
        </div>
      )}
    </Card>
  )
}

function FindingRow({ finding }: { readonly finding: HealthFinding }) {
  const { t } = useTranslation()
  const format = useFormatters()

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border p-2.5',
        finding.severity === 'critical'
          ? 'border-danger/30 bg-danger-soft/20'
          : finding.severity === 'warning'
            ? 'border-warning/30 bg-warning-soft/20'
            : 'border-line bg-surface-2',
      )}
    >
      <TriangleAlert
        size={15}
        aria-hidden
        className={cn(
          'mt-0.5 shrink-0',
          finding.severity === 'critical'
            ? 'text-danger'
            : finding.severity === 'warning'
              ? 'text-warning'
              : 'text-ink-subtle',
        )}
      />
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-ink">
          {findingTitle(finding.code, t)}
          {finding.value !== null && ` · ${format.number(finding.value)}`}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
          {findingBody(finding.code, t)}
        </p>
      </div>
    </div>
  )
}

function AttributeTable({ attributes }: { readonly attributes: readonly SmartAttribute[] }) {
  const { t } = useTranslation()
  const format = useFormatters()

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[540px] text-left text-[12px]">
        <thead>
          <tr className="text-ink-subtle">
            <th className="py-1.5 pr-3 font-medium">{t('health.attrId')}</th>
            <th className="py-1.5 pr-3 font-medium">{t('health.attrName')}</th>
            <th className="py-1.5 pr-3 text-right font-medium">{t('health.attrValue')}</th>
            <th className="py-1.5 pr-3 text-right font-medium">{t('health.attrWorst')}</th>
            <th className="py-1.5 pr-3 text-right font-medium">{t('health.attrThreshold')}</th>
            <th className="py-1.5 text-right font-medium">{t('health.attrRaw')}</th>
          </tr>
        </thead>
        <tbody>
          {attributes.map((attribute) => (
            <tr key={attribute.id} className="border-t border-line">
              <td className="py-1.5 pr-3 tabular-nums text-ink-subtle">{attribute.id}</td>
              <td className="py-1.5 pr-3">
                <span className={cn(attribute.isDecisive ? 'text-ink' : 'text-ink-muted')}>
                  {attribute.name}
                </span>
                {attribute.status !== 'ok' && attribute.status !== 'unknown' && (
                  <Badge
                    dense
                    className="ml-1.5"
                    tone={attribute.status === 'critical' ? 'danger' : 'warning'}
                  >
                    {attributeStatusLabel(attribute.status, t)}
                  </Badge>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-ink-muted">
                {attribute.current}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-ink-muted">
                {attribute.worst}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-ink-subtle">
                {attribute.threshold ?? '—'}
              </td>
              <td className="py-1.5 text-right tabular-nums text-ink">
                {formatRaw(attribute, format)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- Presentation ----------------------------------------------------------

type Translate = ReturnType<typeof useTranslation>['t']
type Formatters = ReturnType<typeof useFormatters>

/** A raw value is meaningless without the unit its attribute defines. */
function formatRaw(attribute: SmartAttribute, format: Formatters): string {
  switch (attribute.unit) {
    case 'celsius':
      return `${format.number(attribute.raw)} °C`
    case 'hours':
      return format.number(attribute.raw)
    case 'bytes':
      return format.bytes(attribute.raw)
    case 'percent':
      return `${format.number(attribute.raw)}%`
    case 'count':
    case 'raw':
      return format.number(attribute.raw)
  }
}

function StatusIcon({ status }: { readonly status: DriveHealthStatus }) {
  if (status === 'failing' || status === 'at-risk') {
    return <ShieldAlert size={16} aria-hidden />
  }
  if (status === 'caution') return <Activity size={16} aria-hidden />

  return <ShieldCheck size={16} aria-hidden />
}

function unavailableLabel(reason: HealthUnavailable, t: Translate): string {
  switch (reason) {
    case 'needs-elevation':
      return t('health.unavailable.needsElevation')
    case 'not-supported':
      return t('health.unavailable.notSupported')
    case 'summary-only':
      return t('health.unavailable.summaryOnly')
    case 'query-failed':
      return t('health.unavailable.queryFailed')
  }
}

function statusTone(status: DriveHealthStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'good':
      return 'success'
    case 'caution':
      return 'warning'
    case 'at-risk':
    case 'failing':
      return 'danger'
    case 'unknown':
      return 'neutral'
  }
}

function statusLabel(status: DriveHealthStatus, t: Translate): string {
  switch (status) {
    case 'good':
      return t('health.status.good')
    case 'caution':
      return t('health.status.caution')
    case 'at-risk':
      return t('health.status.atRisk')
    case 'failing':
      return t('health.status.failing')
    case 'unknown':
      return t('health.status.unknown')
  }
}

function attributeStatusLabel(status: AttributeStatus, t: Translate): string {
  switch (status) {
    case 'ok':
      return t('health.attrOk')
    case 'warning':
      return t('health.attrWarning')
    case 'critical':
      return t('health.attrCritical')
    case 'unknown':
      return t('health.attrUnknown')
  }
}

function findingTitle(code: HealthFinding['code'], t: Translate): string {
  switch (code) {
    case 'self-assessment-failed':
      return t('health.finding.selfAssessmentFailed')
    case 'reallocated-sectors':
      return t('health.finding.reallocated')
    case 'pending-sectors':
      return t('health.finding.pending')
    case 'uncorrectable-sectors':
      return t('health.finding.uncorrectable')
    case 'reported-uncorrectable':
      return t('health.finding.reported')
    case 'command-timeouts':
      return t('health.finding.timeouts')
    case 'interface-errors':
      return t('health.finding.interface')
    case 'overheating':
      return t('health.finding.overheating')
    case 'wear-exhausted':
      return t('health.finding.wear')
    case 'high-usage':
      return t('health.finding.usage')
  }
}

function findingBody(code: HealthFinding['code'], t: Translate): string {
  switch (code) {
    case 'self-assessment-failed':
      return t('health.findingBody.selfAssessmentFailed')
    case 'reallocated-sectors':
      return t('health.findingBody.reallocated')
    case 'pending-sectors':
      return t('health.findingBody.pending')
    case 'uncorrectable-sectors':
      return t('health.findingBody.uncorrectable')
    case 'reported-uncorrectable':
      return t('health.findingBody.reported')
    case 'command-timeouts':
      return t('health.findingBody.timeouts')
    case 'interface-errors':
      return t('health.findingBody.interface')
    case 'overheating':
      return t('health.findingBody.overheating')
    case 'wear-exhausted':
      return t('health.findingBody.wear')
    case 'high-usage':
      return t('health.findingBody.usage')
  }
}

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  HardDrive,
  Info,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type {
  DeviceInventory,
  DeviceKind,
  HealthStatus,
  Partition,
  StorageDevice,
} from '@shared/types/disk'
import { percentOf } from '@shared/utils/bytes'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Skeleton } from '@/components/ui/Skeleton'
import { useFormatters } from '@/hooks/useFormatters'
import { cn } from '@/lib/cn'
import { invoke } from '@/lib/ipc-client'
import { toast } from '@/stores/ui.store'
import { DEVICE_KIND_ICONS } from './device-icons'

/**
 * Device list.
 *
 * Every device is shown, including offline disks, unpartitioned media and disks
 * whose partition table would not parse. Hiding those would remove precisely
 * the devices a recovery user came here for — a drive that looks fine to
 * Windows is rarely the one they are worried about.
 */
export function DevicesPage() {
  const { t } = useTranslation()
  const [inventory, setInventory] = useState<DeviceInventory | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (force: boolean): Promise<void> => {
    setRefreshing(true)

    const response = await invoke(force ? IpcChannel.DiskRefresh : IpcChannel.DiskList, undefined)

    setRefreshing(false)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    setInventory(response.data)
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('devices.title')}
        description={t('devices.subtitle')}
        actions={
          <Button
            size="sm"
            variant="secondary"
            loading={refreshing}
            iconLeft={<RefreshCw size={14} />}
            onClick={() => {
              void load(true)
            }}
          >
            {t('devices.refresh')}
          </Button>
        }
      />

      {inventory !== null && !inventory.hasRawAccess && (
        <Callout tone="warning" icon={ShieldAlert} title={t('devices.limitedTitle')}>
          {t('devices.limitedBody')}
        </Callout>
      )}

      {inventory !== null && inventory.warnings.length > 0 && (
        <Callout tone="info" icon={Info} title={t('devices.warningsTitle')}>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {inventory.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Callout>
      )}

      {inventory === null ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-56 w-full" />
          ))}
        </div>
      ) : inventory.devices.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HardDrive size={22} />}
            title={t('devices.empty')}
            description={t('devices.emptyHint')}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {inventory.devices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))}
        </div>
      )}
    </div>
  )
}

function DeviceCard({ device }: { device: StorageDevice }) {
  const { t } = useTranslation()
  const format = useFormatters()

  const Icon = DEVICE_KIND_ICONS[device.kind]
  const usedBytes = device.partitions.reduce((total, partition) => total + partition.sizeBytes, 0)

  return (
    <Card flush className="overflow-hidden">
      <div className="flex items-start gap-4 p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <Icon size={22} aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-ink">{device.model}</h2>
            <Badge tone="neutral">{describeKind(device.kind, t)}</Badge>
            <Badge tone={healthTone(device.health)}>{describeHealth(device.health, t)}</Badge>
            {device.isSystem && <Badge tone="info">{t('devices.badgeSystem')}</Badge>}
            {device.isBoot && <Badge tone="info">{t('devices.badgeBoot')}</Badge>}
            {device.isRemovable && <Badge tone="neutral">{t('devices.badgeRemovable')}</Badge>}
            {device.isOffline && <Badge tone="warning">{t('devices.badgeOffline')}</Badge>}
          </div>

          <dl className="text-numeric mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-ink-muted">
            <Fact label={t('devices.capacity')} value={format.bytes(device.sizeBytes)} />
            <Fact
              label={t('devices.connection')}
              value={`${device.busType.toUpperCase()} · ${device.devicePath}`}
            />
            <Fact label={t('devices.sectorSize')} value={`${device.logicalSectorSize} B`} />
            <Fact label={t('devices.layout')} value={device.partitionStyle.toUpperCase()} />
            {device.serialNumber !== null && (
              <Fact label={t('devices.serial')} value={device.serialNumber} />
            )}
          </dl>

          {device.sizeBytes > 0 && (
            <ProgressBar
              className="mt-3"
              value={percentOf(usedBytes, device.sizeBytes)}
              ariaLabel={device.model}
            />
          )}
        </div>
      </div>

      {device.readError !== null && (
        <div className="flex items-start gap-2.5 border-t border-line bg-warning-soft/40 px-5 py-3 text-[12.5px]">
          <AlertTriangle size={15} aria-hidden className="mt-0.5 shrink-0 text-warning" />
          <div>
            <p className="font-medium text-ink">{t('devices.readErrorTitle')}</p>
            <p className="text-ink-muted">{device.readError}</p>
          </div>
        </div>
      )}

      {device.partitions.length === 0 ? (
        <div className="border-t border-line">
          <EmptyState
            className="py-10"
            icon={<HardDrive size={20} />}
            title={t('devices.noPartitions')}
            description={t('devices.noPartitionsHint')}
          />
        </div>
      ) : (
        <PartitionTable partitions={device.partitions} />
      )}

      {device.unallocated.length > 0 && (
        <div className="border-t border-line px-5 py-3">
          <p className="text-[12.5px] font-medium text-ink">{t('devices.unallocated')}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
            {t('devices.unallocatedHint')}
          </p>
          <ul className="text-numeric mt-2 space-y-1">
            {device.unallocated.map((region) => (
              <li
                key={region.offsetBytes}
                className="flex items-center justify-between rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-muted"
              >
                <span className="font-mono">
                  {format.bytes(region.offsetBytes)} →{' '}
                  {format.bytes(region.offsetBytes + region.sizeBytes)}
                </span>
                <span className="font-medium text-ink">{format.bytes(region.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

function PartitionTable({ partitions }: { partitions: readonly Partition[] }) {
  const { t } = useTranslation()
  const format = useFormatters()

  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full min-w-[42rem] text-left text-[12.5px]">
        <thead className="bg-surface-2 text-[11.5px] tracking-wide text-ink-subtle uppercase">
          <tr>
            <th scope="col" className="px-5 py-2 font-medium">
              {t('devices.columnPartition')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('devices.columnFileSystem')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('devices.columnSize')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('devices.columnUsed')}
            </th>
            <th scope="col" className="px-5 py-2 font-medium">
              {t('devices.columnType')}
            </th>
          </tr>
        </thead>
        <tbody>
          {partitions.map((partition) => {
            const usedPercent =
              partition.freeBytes === null || partition.sizeBytes === 0
                ? null
                : percentOf(partition.sizeBytes - partition.freeBytes, partition.sizeBytes)

            return (
              <tr key={partition.id} className="border-t border-line/70">
                <td className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">
                      {partition.driveLetter !== null
                        ? `${partition.driveLetter}:`
                        : `#${partition.index}`}
                    </span>
                    {partition.label !== null && (
                      <span className="truncate text-ink-muted">{partition.label}</span>
                    )}
                    {partition.isHidden && (
                      <Badge dense tone="neutral">
                        {t('devices.badgeHidden')}
                      </Badge>
                    )}
                    {partition.isRecovered && (
                      <Badge dense tone="accent">
                        {t('devices.badgeRecovered')}
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-ink-muted uppercase">{partition.fileSystem}</td>
                <td className="text-numeric px-3 py-2.5 text-right text-ink">
                  {format.bytes(partition.sizeBytes)}
                </td>
                <td className="px-3 py-2.5">
                  {usedPercent === null ? (
                    <span className="text-ink-subtle">—</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <ProgressBar
                        value={usedPercent}
                        thresholds
                        className="w-20"
                        ariaLabel={partition.id}
                      />
                      <span className="text-numeric text-[11.5px] text-ink-muted">
                        {usedPercent.toFixed(0)}%
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-5 py-2.5 text-ink-muted">{partition.typeName}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  )
}

function Callout({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: 'warning' | 'info'
  icon: LucideIcon
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-card border p-4 text-[13px]',
        tone === 'warning' ? 'border-warning/30 bg-warning-soft/50' : 'border-line bg-surface-2',
      )}
    >
      <Icon
        size={17}
        aria-hidden
        className={cn('mt-0.5 shrink-0', tone === 'warning' ? 'text-warning' : 'text-info')}
      />
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        <div className="mt-0.5 leading-relaxed text-ink-muted">{children}</div>
      </div>
    </div>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

function describeKind(kind: DeviceKind, t: Translate): string {
  // A switch rather than a lookup table: `t` needs a literal key to type-check,
  // and a Record<DeviceKind, TranslationKey> cannot express that without casts.
  switch (kind) {
    case 'hard-disk':
      return t('devices.kindHardDisk')
    case 'ssd':
      return t('devices.kindSsd')
    case 'nvme':
      return t('devices.kindNvme')
    case 'external-hdd':
      return t('devices.kindExternalHdd')
    case 'external-ssd':
      return t('devices.kindExternalSsd')
    case 'usb-flash':
      return t('devices.kindUsbFlash')
    case 'sd-card':
      return t('devices.kindSdCard')
    case 'micro-sd':
      return t('devices.kindMicroSd')
    case 'camera-card':
      return t('devices.kindCameraCard')
    case 'optical':
      return t('devices.kindOptical')
    case 'virtual-disk':
      return t('devices.kindVirtualDisk')
    case 'unknown':
      return t('devices.kindUnknown')
  }
}

function describeHealth(health: HealthStatus, t: Translate): string {
  switch (health) {
    case 'healthy':
      return t('devices.healthHealthy')
    case 'warning':
      return t('devices.healthWarning')
    case 'unhealthy':
      return t('devices.healthUnhealthy')
    case 'unknown':
      return t('devices.healthUnknown')
  }
}

function healthTone(health: HealthStatus): BadgeTone {
  switch (health) {
    case 'healthy':
      return 'success'
    case 'warning':
      return 'warning'
    case 'unhealthy':
      return 'danger'
    case 'unknown':
      return 'neutral'
  }
}

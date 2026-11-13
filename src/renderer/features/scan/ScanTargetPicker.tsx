import { useTranslation } from 'react-i18next'
import { AlertTriangle, Search, ShieldAlert } from 'lucide-react'
import type { DeviceInventory, Partition, StorageDevice } from '@shared/types/disk'
import type { ScanType } from '@shared/types/scan'
import type { ModeTarget } from '@shared/types/recovery-mode'
import { supportsQuickScan } from '@shared/types/disk'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Switch } from '@/components/ui/Switch'
import { useFormatters } from '@/hooks/useFormatters'
import { cn } from '@/lib/cn'
import { DEVICE_KIND_ICONS } from '@/features/devices/device-icons'

/**
 * Choose what to scan.
 *
 * Partitions are listed rather than devices alone because a quick scan reads a
 * filesystem's own records, and those live inside a partition. A volume whose
 * filesystem the metadata scanner cannot read is shown but disabled, with the
 * reason stated — silently omitting it would leave a user hunting for a drive
 * they can plainly see in the device list.
 */

export interface ScanTargetPickerProps {
  readonly inventory: DeviceInventory
  readonly selectedPartitionId: string | null
  readonly scanType: ScanType
  readonly onScanTypeChange: (value: ScanType) => void
  /** What the active mode expects the user to pick. */
  readonly target: ModeTarget
  /** `false` hides the scan-type control, for a mode that fixes it. */
  readonly allowScanTypeChoice: boolean
  readonly selectedDeviceId: string | null
  readonly onSelectDevice: (deviceId: string) => void
  readonly includeExisting: boolean
  readonly starting: boolean
  readonly onSelect: (deviceId: string, partitionId: string) => void
  readonly onIncludeExistingChange: (value: boolean) => void
  readonly onStart: () => void
}

export function ScanTargetPicker({
  inventory,
  selectedPartitionId,
  scanType,
  onScanTypeChange,
  target,
  allowScanTypeChoice,
  selectedDeviceId,
  onSelectDevice,
  includeExisting,
  starting,
  onSelect,
  onIncludeExistingChange,
  onStart,
}: ScanTargetPickerProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      {!inventory.hasRawAccess && (
        <div className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning-soft/50 p-4 text-[13px]">
          <ShieldAlert size={17} aria-hidden className="mt-0.5 shrink-0 text-warning" />
          <div>
            <p className="font-medium text-ink">{t('scan.elevationTitle')}</p>
            <p className="mt-0.5 leading-relaxed text-ink-muted">{t('scan.elevationBody')}</p>
          </div>
        </div>
      )}

      {allowScanTypeChoice && (
        <Card>
          <p className="mb-2 text-[12px] font-medium text-ink">{t('scan.scanType')}</p>
          <SegmentedControl
            value={scanType}
            segments={[
              { value: 'quick', label: t('scan.quickScan') },
              { value: 'deep', label: t('scan.deepScan') },
            ]}
            onValueChange={onScanTypeChange}
            ariaLabel={t('scan.scanType')}
          />
          <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
            {scanType === 'quick' ? t('scan.quickScanHint') : t('scan.deepScanHint')}
          </p>
        </Card>
      )}

      {inventory.devices.map((device) => (
        <DeviceTargets
          key={device.id}
          device={device}
          scanType={scanType}
          target={target}
          selectedPartitionId={selectedPartitionId}
          selectedDeviceId={selectedDeviceId}
          onSelect={onSelect}
          onSelectDevice={onSelectDevice}
        />
      ))}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          {allowScanTypeChoice ? (
            <Switch
              checked={includeExisting}
              onCheckedChange={onIncludeExistingChange}
              label={t('scan.includeExisting')}
              description={t('scan.includeExistingHint')}
            />
          ) : (
            /* The mode fixed these, so they are reported rather than offered.
               Hiding them entirely would leave the user unable to see what
               scan they are about to start. */
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                {t('modes.derived')}
              </p>
              <p className="mt-1 text-[13px] text-ink">
                {scanType === 'deep' ? t('scan.deepScan') : t('scan.quickScan')}
                {' · '}
                {includeExisting ? t('modes.includesExisting') : t('modes.deletedOnly')}
              </p>
            </div>
          )}

          <Button
            size="md"
            loading={starting}
            disabled={
              target === 'device' ? selectedDeviceId === null : selectedPartitionId === null
            }
            iconLeft={<Search size={15} />}
            onClick={onStart}
          >
            {scanType === 'deep' ? t('scan.startDeep') : t('scan.startQuick')}
          </Button>
        </div>
      </Card>
    </div>
  )
}

function DeviceTargets({
  device,
  scanType,
  target,
  selectedPartitionId,
  selectedDeviceId,
  onSelect,
  onSelectDevice,
}: {
  device: StorageDevice
  scanType: ScanType
  target: ModeTarget
  selectedPartitionId: string | null
  selectedDeviceId: string | null
  onSelect: (deviceId: string, partitionId: string) => void
  onSelectDevice: (deviceId: string) => void
}) {
  const { t } = useTranslation()
  const format = useFormatters()
  const Icon = DEVICE_KIND_ICONS[device.kind]

  return (
    <Card flush className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-ink">{device.model}</p>
          <p className="text-numeric text-[12px] text-ink-muted">
            {format.bytes(device.sizeBytes)} · {device.busType.toUpperCase()}
          </p>
        </div>
        {device.isSystem && <Badge tone="info">{t('devices.badgeSystem')}</Badge>}
      </div>

      {/*
        A device-level mode is for a drive whose partition table may be the
        broken thing, so the whole device is the only target that makes sense.
      */}
      {target === 'device' ? (
        <button
          type="button"
          aria-pressed={device.id === selectedDeviceId}
          onClick={() => {
            onSelectDevice(device.id)
          }}
          className={cn(
            'flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2',
            device.id === selectedDeviceId && 'bg-accent-soft/60',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 rounded-full border-2 transition-colors',
              device.id === selectedDeviceId ? 'border-accent bg-accent' : 'border-line',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-ink">{t('modes.wholeDevice')}</span>
            <span className="block text-[11.5px] text-ink-subtle">
              {t('modes.wholeDeviceHint')}
            </span>
          </span>
          <span className="text-numeric shrink-0 text-[12.5px] text-ink-muted">
            {format.bytes(device.sizeBytes)}
          </span>
        </button>
      ) : device.partitions.length === 0 ? (
        <p className="px-5 py-4 text-[12.5px] text-ink-muted">{t('scan.noVolumes')}</p>
      ) : (
        <ul className="divide-y divide-line/70">
          {device.partitions.map((partition) => (
            <PartitionRow
              key={partition.id}
              partition={partition}
              device={device}
              scanType={scanType}
              selected={partition.id === selectedPartitionId}
              onSelect={() => {
                onSelect(device.id, partition.id)
              }}
            />
          ))}
        </ul>
      )}
    </Card>
  )
}

function PartitionRow({
  partition,
  device,
  scanType,
  selected,
  onSelect,
}: {
  partition: Partition
  device: StorageDevice
  scanType: ScanType
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const format = useFormatters()

  // A deep scan reads sectors directly, so it does not need a file system it
  // recognises — which is exactly why it exists.
  const scannable = scanType === 'deep' || supportsQuickScan(partition.fileSystem)

  return (
    <li>
      <button
        type="button"
        disabled={!scannable}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-3 px-5 py-3 text-left transition-colors',
          scannable ? 'hover:bg-surface-2' : 'cursor-not-allowed opacity-60',
          selected && 'bg-accent-soft/60',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 rounded-full border-2 transition-colors',
            selected ? 'border-accent bg-accent' : 'border-line',
          )}
        />

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">
              {partition.driveLetter !== null ? `${partition.driveLetter}:` : `#${partition.index}`}
            </span>
            {partition.label !== null && (
              <span className="truncate text-[12.5px] text-ink-muted">{partition.label}</span>
            )}
            <Badge dense tone="neutral">
              {partition.fileSystem.toUpperCase()}
            </Badge>
            {/* The boot volume is a legal target, but never a safe destination. */}
            {device.isBoot && partition.driveLetter === 'C' && (
              <Badge dense tone="info">
                {t('devices.badgeSystem')}
              </Badge>
            )}
          </span>

          {!scannable && (
            <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-warning">
              <AlertTriangle size={12} aria-hidden />
              {t('scan.unsupportedFilesystem')}
            </span>
          )}
        </span>

        <span className="text-numeric shrink-0 text-[12.5px] text-ink-muted">
          {format.bytes(partition.sizeBytes)}
        </span>
      </button>
    </li>
  )
}

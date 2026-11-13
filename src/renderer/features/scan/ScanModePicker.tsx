import { useTranslation } from 'react-i18next'
import { FileX, HardDriveDownload, Settings2, TriangleAlert, type LucideIcon } from 'lucide-react'
import { RECOVERY_MODE_ORDER, modePreset, type RecoveryModeId } from '@shared/types/recovery-mode'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/cn'

/**
 * The entry point to a recovery.
 *
 * Asks what happened rather than what to configure. A user who has just
 * formatted the wrong drive does not know they need a signature carve of a
 * partition with existing files included — they know they formatted the wrong
 * drive, and deriving the settings from that is the point.
 */

const MODE_ICONS: Readonly<Record<RecoveryModeId, LucideIcon>> = {
  'deleted-files': FileX,
  'formatted-drive': HardDriveDownload,
  'raw-drive': TriangleAlert,
  custom: Settings2,
}

export interface ScanModePickerProps {
  readonly selected: RecoveryModeId | null
  readonly onSelect: (mode: RecoveryModeId) => void
}

export function ScanModePicker({ selected, onSelect }: ScanModePickerProps) {
  const { t } = useTranslation()

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {RECOVERY_MODE_ORDER.map((id) => {
        const Icon = MODE_ICONS[id]
        const preset = modePreset(id)
        const isSelected = id === selected

        return (
          <Card
            key={id}
            flush
            className={cn(
              'transition-colors',
              isSelected ? 'border-accent bg-accent-soft/40' : 'hover:border-line-strong',
            )}
          >
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => {
                onSelect(id)
              }}
              className="flex w-full items-start gap-3.5 p-4 text-left"
            >
              <span
                className={cn(
                  'grid size-10 shrink-0 place-items-center rounded-xl',
                  isSelected ? 'bg-accent text-white' : 'bg-surface-2 text-ink-muted',
                )}
              >
                <Icon size={19} aria-hidden />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-ink">{modeTitle(id, t)}</span>
                  <Badge dense tone={preset.scanType === 'deep' ? 'warning' : 'neutral'}>
                    {preset.scanType === 'deep' ? t('scan.deepScan') : t('scan.quickScan')}
                  </Badge>
                </span>

                <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-muted">
                  {modeDescription(id, t)}
                </span>

                {/* Stated up front, because it changes what the results can
                    contain — not buried in a tooltip after the scan. */}
                <span className="mt-1.5 block text-[11.5px] text-ink-subtle">
                  {modeCaveat(id, t)}
                </span>
              </span>
            </button>
          </Card>
        )
      })}
    </div>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

function modeTitle(id: RecoveryModeId, t: Translate): string {
  switch (id) {
    case 'deleted-files':
      return t('modes.deletedTitle')
    case 'formatted-drive':
      return t('modes.formattedTitle')
    case 'raw-drive':
      return t('modes.rawTitle')
    case 'custom':
      return t('modes.customTitle')
  }
}

function modeDescription(id: RecoveryModeId, t: Translate): string {
  switch (id) {
    case 'deleted-files':
      return t('modes.deletedBody')
    case 'formatted-drive':
      return t('modes.formattedBody')
    case 'raw-drive':
      return t('modes.rawBody')
    case 'custom':
      return t('modes.customBody')
  }
}

function modeCaveat(id: RecoveryModeId, t: Translate): string {
  switch (id) {
    case 'deleted-files':
      return t('modes.deletedCaveat')
    case 'formatted-drive':
      return t('modes.formattedCaveat')
    case 'raw-drive':
      return t('modes.rawCaveat')
    case 'custom':
      return t('modes.customCaveat')
  }
}

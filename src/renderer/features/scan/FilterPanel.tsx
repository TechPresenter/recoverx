import { useTranslation } from 'react-i18next'
import { SlidersHorizontal, X } from 'lucide-react'
import type { FileFilter, RecoveryQuality } from '@shared/types/scan'
import { parseBytes } from '@shared/utils/bytes'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'

/**
 * Advanced filters.
 *
 * Size accepts human input ("500 MB", "1.5GiB") rather than a byte count,
 * because nobody looking for a lost video thinks in bytes. Anything unparseable
 * is simply not applied — a filter that silently narrows to nothing because of
 * a typo is worse than one that ignores it.
 */

const QUALITIES: readonly RecoveryQuality[] = ['excellent', 'good', 'fair', 'poor', 'unknown']

export interface FilterPanelProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly qualities: readonly RecoveryQuality[]
  readonly onQualitiesChange: (value: readonly RecoveryQuality[]) => void
  readonly minSize: string
  readonly maxSize: string
  readonly onMinSizeChange: (value: string) => void
  readonly onMaxSizeChange: (value: string) => void
  readonly modifiedAfter: string
  readonly modifiedBefore: string
  readonly onModifiedAfterChange: (value: string) => void
  readonly onModifiedBeforeChange: (value: string) => void
  readonly extensions: string
  readonly onExtensionsChange: (value: string) => void
  readonly activeCount: number
  readonly onClear: () => void
}

export function FilterPanel(props: FilterPanelProps) {
  const { t } = useTranslation()

  return (
    <div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={props.open ? 'secondary' : 'ghost'}
          iconLeft={<SlidersHorizontal size={14} />}
          onClick={() => {
            props.onOpenChange(!props.open)
          }}
          aria-expanded={props.open}
        >
          {t('scan.filters')}
          {props.activeCount > 0 && (
            <Badge dense tone="accent" className="ml-1.5">
              {props.activeCount}
            </Badge>
          )}
        </Button>

        {props.activeCount > 0 && (
          <Button size="sm" variant="ghost" iconLeft={<X size={13} />} onClick={props.onClear}>
            {t('scan.clearFilters')}
          </Button>
        )}
      </div>

      {props.open && (
        <div className="mt-3 grid gap-4 rounded-card border border-line bg-surface-2 p-4 md:grid-cols-2">
          <Field label={t('scan.filterQuality')}>
            <div className="flex flex-wrap gap-1.5">
              {QUALITIES.map((quality) => {
                const active = props.qualities.includes(quality)

                return (
                  <button
                    key={quality}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      props.onQualitiesChange(
                        active
                          ? props.qualities.filter((value) => value !== quality)
                          : [...props.qualities, quality],
                      )
                    }}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                      active
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-ink-muted hover:text-ink',
                    )}
                  >
                    {t(qualityKey(quality))}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label={t('scan.filterExtensions')} hint={t('scan.filterExtensionsHint')}>
            <Input
              value={props.extensions}
              onChange={(event) => {
                props.onExtensionsChange(event.target.value)
              }}
              placeholder="jpg, cr3, mp4"
            />
          </Field>

          <Field label={t('scan.filterSize')} hint={t('scan.filterSizeHint')}>
            <div className="flex items-center gap-2">
              <Input
                value={props.minSize}
                onChange={(event) => {
                  props.onMinSizeChange(event.target.value)
                }}
                placeholder={t('scan.filterMin')}
                aria-label={t('scan.filterMin')}
                aria-invalid={isInvalidSize(props.minSize)}
              />
              <span className="text-ink-subtle">–</span>
              <Input
                value={props.maxSize}
                onChange={(event) => {
                  props.onMaxSizeChange(event.target.value)
                }}
                placeholder={t('scan.filterMax')}
                aria-label={t('scan.filterMax')}
                aria-invalid={isInvalidSize(props.maxSize)}
              />
            </div>
          </Field>

          <Field label={t('scan.filterModified')}>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={props.modifiedAfter}
                onChange={(event) => {
                  props.onModifiedAfterChange(event.target.value)
                }}
                aria-label={t('scan.filterFrom')}
              />
              <span className="text-ink-subtle">–</span>
              <Input
                type="date"
                value={props.modifiedBefore}
                onChange={(event) => {
                  props.onModifiedBeforeChange(event.target.value)
                }}
                aria-label={t('scan.filterTo')}
              />
            </div>
          </Field>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-ink">{label}</p>
      {children}
      {hint !== undefined && <p className="mt-1 text-[11.5px] text-ink-subtle">{hint}</p>}
    </div>
  )
}

/** A non-empty value that will not parse is worth flagging to the user. */
function isInvalidSize(value: string): boolean {
  return value.trim().length > 0 && parseBytes(value) === null
}

function qualityKey(quality: RecoveryQuality) {
  switch (quality) {
    case 'excellent':
      return 'scan.qualityExcellent' as const
    case 'good':
      return 'scan.qualityGood' as const
    case 'fair':
      return 'scan.qualityFair' as const
    case 'poor':
      return 'scan.qualityPoor' as const
    case 'unknown':
      return 'scan.qualityUnknown' as const
  }
}

/**
 * Fold the panel's free-text inputs into the query filter.
 *
 * Unparseable values are dropped rather than applied, and an inverted range is
 * normalised — a user who types the larger figure first means the range, not an
 * empty result.
 */
export function applyAdvancedFilters(
  base: FileFilter,
  input: {
    qualities: readonly RecoveryQuality[]
    minSize: string
    maxSize: string
    modifiedAfter: string
    modifiedBefore: string
    extensions: string
  },
): FileFilter {
  const min = parseBytes(input.minSize)
  const max = parseBytes(input.maxSize)
  const after = parseDate(input.modifiedAfter)
  const before = parseDate(input.modifiedBefore, true)

  const extensions = input.extensions
    .split(/[\s,]+/u)
    .map((value) => value.trim().replace(/^\./u, '').toLowerCase())
    .filter((value) => value.length > 0)

  const [lowSize, highSize] = min !== null && max !== null && min > max ? [max, min] : [min, max]
  const [fromDate, toDate] =
    after !== null && before !== null && after > before ? [before, after] : [after, before]

  return {
    ...base,
    ...(input.qualities.length > 0 ? { qualities: [...input.qualities] } : {}),
    ...(extensions.length > 0 ? { extensions } : {}),
    ...(lowSize !== null ? { minSizeBytes: lowSize } : {}),
    ...(highSize !== null ? { maxSizeBytes: highSize } : {}),
    ...(fromDate !== null ? { modifiedAfter: fromDate } : {}),
    ...(toDate !== null ? { modifiedBefore: toDate } : {}),
  }
}

/** Parse a `yyyy-mm-dd` value. `endOfDay` makes an inclusive upper bound. */
function parseDate(value: string, endOfDay = false): number | null {
  if (value.trim().length === 0) return null

  const parsed = Date.parse(endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) ? parsed : null
}

/** How many advanced filters are in force, for the badge on the toggle. */
export function countActiveFilters(input: {
  qualities: readonly RecoveryQuality[]
  minSize: string
  maxSize: string
  modifiedAfter: string
  modifiedBefore: string
  extensions: string
}): number {
  let count = 0

  if (input.qualities.length > 0) count += 1
  if (parseBytes(input.minSize) !== null) count += 1
  if (parseBytes(input.maxSize) !== null) count += 1
  if (input.modifiedAfter.trim().length > 0) count += 1
  if (input.modifiedBefore.trim().length > 0) count += 1
  if (input.extensions.trim().length > 0) count += 1

  return count
}

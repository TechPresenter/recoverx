import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ProgressBar } from './ProgressBar'

export interface StatTileProps {
  label: string
  value: ReactNode
  /** Secondary line, e.g. "12.4 GiB of 32 GiB". */
  detail?: ReactNode
  icon?: ReactNode
  /** Renders a threshold-coloured meter beneath the value, 0–100. */
  meter?: number
  className?: string
}

/**
 * Single metric tile.
 *
 * The value uses tabular figures so a number updating twice a second does not
 * shift the tiles beside it — proportional digits make a live counter visibly
 * jitter.
 */
export function StatTile({ label, value, detail, icon, meter, className }: StatTileProps) {
  return (
    <div
      className={cn(
        'rounded-card gradient-surface border border-line p-4 transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-raised',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12.5px] font-medium text-ink-muted">{label}</span>
        {icon !== undefined && (
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            {icon}
          </span>
        )}
      </div>

      <p className="text-numeric mt-2 text-2xl leading-none font-semibold text-ink">{value}</p>

      {detail !== undefined && (
        <p className="text-numeric mt-1.5 truncate text-[12.5px] text-ink-subtle">{detail}</p>
      )}

      {meter !== undefined && (
        <ProgressBar value={meter} thresholds className="mt-3" ariaLabel={label} />
      )}
    </div>
  )
}

export interface DefinitionRowProps {
  term: string
  children: ReactNode
  /** Allows the value to be selected and copied — paths, versions, IDs. */
  selectable?: boolean
  className?: string
}

/** Key/value row used by the Dashboard environment panel and the About screen. */
export function DefinitionRow({
  term,
  children,
  selectable = false,
  className,
}: DefinitionRowProps) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-6 border-b border-line py-2 last:border-b-0',
        className,
      )}
    >
      <dt className="shrink-0 text-[13px] text-ink-muted">{term}</dt>
      <dd
        className={cn(
          'min-w-0 truncate text-right text-[13px] font-medium text-ink',
          selectable && 'selectable',
        )}
      >
        {children}
      </dd>
    </div>
  )
}

import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Lifts the card with a stronger shadow. For overlays and focal panels. */
  raised?: boolean
  /** Removes the default padding when the card hosts its own layout. */
  flush?: boolean
}

/** Primary surface container. */
export function Card({ raised = false, flush = false, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-card border border-line bg-surface',
        raised ? 'shadow-raised' : 'shadow-card',
        !flush && 'p-5',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

export interface CardHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** Actions aligned to the trailing edge, e.g. a refresh button. */
  actions?: ReactNode
  icon?: ReactNode
  className?: string
}

export function CardHeader({ title, description, actions, icon, className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon !== undefined && (
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>
          {description !== undefined && (
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">{description}</p>
          )}
        </div>
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Full-bleed divider that ignores the card's horizontal padding. */
export function CardDivider({ className }: { className?: string }) {
  return <hr className={cn('-mx-5 my-4 border-t border-line', className)} />
}

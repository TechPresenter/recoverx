import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

/**
 * Placeholder shown when a view has nothing to display.
 *
 * Always pairs the statement with a next step: "no results" alone leaves the
 * user unsure whether the app is broken or simply has nothing to show.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {icon !== undefined && (
        <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-ink-subtle">
          {icon}
        </span>
      )}
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {description !== undefined && (
          <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-ink-muted">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  )
}

import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  icon?: ReactNode
  className?: string
  /** Compact variant used inside dense table rows. */
  dense?: boolean
}

const TONE_STYLES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-ink-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
}

export function Badge({ tone = 'neutral', children, icon, className, dense = false }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap',
        dense ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-xs',
        TONE_STYLES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

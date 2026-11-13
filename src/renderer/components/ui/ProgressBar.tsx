import { cn } from '@/lib/cn'

export type ProgressTone = 'accent' | 'success' | 'warning' | 'danger'

export interface ProgressBarProps {
  /** Completion, 0–100. Values outside the range are clamped. */
  value: number
  tone?: ProgressTone
  className?: string
  /** Accessible name. Omit only when an adjacent label already names the bar. */
  ariaLabel?: string
  /**
   * Colours the bar by threshold instead of using `tone`: green below 70,
   * amber to 90, red above. Used for resource meters.
   */
  thresholds?: boolean
}

const TONE_STYLES: Record<ProgressTone, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

export function ProgressBar({
  value,
  tone = 'accent',
  className,
  ariaLabel,
  thresholds = false,
}: ProgressBarProps) {
  const clamped = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
  const resolvedTone = thresholds ? toneForLoad(clamped) : tone

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width,background-color] duration-500 ease-out',
          TONE_STYLES[resolvedTone],
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

function toneForLoad(value: number): ProgressTone {
  if (value >= 90) return 'danger'
  if (value >= 70) return 'warning'
  return 'success'
}

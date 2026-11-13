import { cn } from '@/lib/cn'

export interface SpinnerProps {
  /** Diameter in pixels. */
  size?: number
  className?: string
  /** Accessible label. Omit inside a control that already announces its state. */
  label?: string
}

/**
 * Indeterminate progress indicator.
 *
 * An SVG arc rather than a bordered div: a border-based spinner renders with
 * visible corner artefacts at small sizes on fractional device pixel ratios,
 * which is exactly the size it is used at inside buttons.
 */
export function Spinner({ size = 16, className, label }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('animate-spin', className)}
      role={label === undefined ? 'presentation' : 'status'}
      aria-label={label}
      aria-hidden={label === undefined}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

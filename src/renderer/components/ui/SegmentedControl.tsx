import { cn } from '@/lib/cn'

export interface Segment<T extends string> {
  readonly value: T
  readonly label: string
  readonly count?: number
}

export interface SegmentedControlProps<T extends string> {
  value: T
  segments: ReadonlyArray<Segment<T>>
  onValueChange: (value: T) => void
  ariaLabel: string
  className?: string
  size?: 'sm' | 'md'
}

/**
 * Mutually exclusive choice rendered as a row of pills.
 *
 * Uses `role="radiogroup"` with arrow-key navigation, which is what assistive
 * technology expects for a single-choice control — a row of independent buttons
 * would be announced as unrelated actions.
 */
export function SegmentedControl<T extends string>({
  value,
  segments,
  onValueChange,
  ariaLabel,
  className,
  size = 'md',
}: SegmentedControlProps<T>) {
  const move = (direction: 1 | -1): void => {
    const index = segments.findIndex((segment) => segment.value === value)
    if (index === -1) return

    // Wrapping matches native radio-group behaviour.
    const next = segments[(index + direction + segments.length) % segments.length]
    if (next !== undefined) onValueChange(next.value)
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        }
      }}
    >
      {segments.map((segment) => {
        const selected = segment.value === value

        return (
          <button
            key={segment.value}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: the group is one tab stop, and arrows move within.
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onValueChange(segment.value)
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors',
              size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
              selected
                ? 'bg-surface text-ink shadow-card'
                : 'text-ink-muted hover:bg-surface-3 hover:text-ink',
            )}
          >
            {segment.label}
            {segment.count !== undefined && (
              <span
                className={cn(
                  'text-numeric rounded-full px-1.5 text-[11px]',
                  selected ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-ink-subtle',
                )}
              >
                {segment.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

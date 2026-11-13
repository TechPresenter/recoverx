import { useId } from 'react'
import { cn } from '@/lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
  /** Shows a busy state while the change is being persisted. */
  pending?: boolean
  className?: string
}

/**
 * Labelled on/off control.
 *
 * Built on a real `<button role="switch">` rather than a styled checkbox: it
 * gives screen readers the correct role and state without a hidden input, and
 * the whole row — label and description included — becomes the hit target,
 * which matters for the dense settings list.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  pending = false,
  className,
}: SwitchProps) {
  const labelId = useId()
  const descriptionId = useId()

  return (
    <div className={cn('flex items-start justify-between gap-6 py-3', className)}>
      <div className="min-w-0">
        <span id={labelId} className="block text-sm font-medium text-ink">
          {label}
        </span>
        {description !== undefined && (
          <span
            id={descriptionId}
            className="mt-0.5 block text-[13px] leading-relaxed text-ink-muted"
          >
            {description}
          </span>
        )}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        disabled={disabled || pending}
        onClick={() => {
          onCheckedChange(!checked)
        }}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors duration-200',
          'disabled:cursor-not-allowed disabled:opacity-60',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-card',
            'transition-transform duration-200 ease-out',
            checked && 'translate-x-5',
          )}
        />
      </button>
    </div>
  )
}

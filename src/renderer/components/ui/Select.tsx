import { useId, type SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface SelectOption<T extends string> {
  readonly value: T
  readonly label: string
}

export interface SelectProps<T extends string> extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'value' | 'onChange' | 'size'
> {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onValueChange: (value: T) => void
  label?: string
  description?: string
  /** Renders label and control side by side, matching the settings rows. */
  inline?: boolean
}

/**
 * Dropdown built on the native `<select>`.
 *
 * A custom listbox would allow richer option rendering, but the native control
 * brings correct keyboard behaviour, type-ahead, and an OS-rendered popup that
 * is never clipped by the window — worth far more here than custom option
 * styling would be.
 */
export function Select<T extends string>({
  value,
  options,
  onValueChange,
  label,
  description,
  inline = false,
  className,
  disabled,
  ...rest
}: SelectProps<T>) {
  const id = useId()
  const descriptionId = useId()

  const control = (
    <div className={cn('relative', inline ? 'w-52 shrink-0' : 'w-full')}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={description === undefined ? undefined : descriptionId}
        onChange={(event) => {
          onValueChange(event.target.value as T)
        }}
        className={cn(
          'h-9 w-full appearance-none rounded-lg border border-line bg-surface',
          'pr-9 pl-3 text-sm text-ink transition-colors',
          'hover:border-line-strong focus:border-accent',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-subtle"
      />
    </div>
  )

  if (label === undefined) return control

  return (
    <div className={cn('gap-6 py-3', inline ? 'flex items-start justify-between' : 'block')}>
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          {label}
        </label>
        {description !== undefined && (
          <span
            id={descriptionId}
            className="mt-0.5 block text-[13px] leading-relaxed text-ink-muted"
          >
            {description}
          </span>
        )}
      </div>
      <div className={inline ? '' : 'mt-2'}>{control}</div>
    </div>
  )
}

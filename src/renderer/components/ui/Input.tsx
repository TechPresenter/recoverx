import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  description?: string
  error?: string
  iconLeft?: ReactNode
  /** Trailing content, e.g. a unit suffix or a browse button. */
  trailing?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, description, error, iconLeft, trailing, className, ...rest },
  ref,
) {
  const id = useId()
  const describedById = useId()
  const hasError = error !== undefined && error.length > 0

  return (
    <div className="w-full">
      {label !== undefined && (
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
          {label}
        </label>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          {iconLeft !== undefined && (
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-subtle">
              {iconLeft}
            </span>
          )}
          <input
            ref={ref}
            id={id}
            aria-invalid={hasError || undefined}
            aria-describedby={description === undefined && !hasError ? undefined : describedById}
            className={cn(
              'selectable h-9 w-full rounded-lg border bg-surface px-3 text-sm text-ink',
              'transition-colors placeholder:text-ink-subtle',
              'hover:border-line-strong focus:border-accent',
              'disabled:cursor-not-allowed disabled:opacity-60',
              iconLeft !== undefined && 'pl-9',
              hasError ? 'border-danger' : 'border-line',
              className,
            )}
            {...rest}
          />
        </div>
        {trailing}
      </div>

      {(description !== undefined || hasError) && (
        <p
          id={describedById}
          className={cn(
            'mt-1.5 text-[13px] leading-relaxed',
            hasError ? 'text-danger' : 'text-ink-muted',
          )}
        >
          {hasError ? error : description}
        </p>
      )}
    </div>
  )
})

export interface SearchInputProps {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  className?: string
  /** Accessible name, required because the control has no visible label. */
  ariaLabel: string
}

/** Search field with an inline clear affordance. */
export function SearchInput({
  value,
  onValueChange,
  placeholder,
  className,
  ariaLabel,
}: SearchInputProps) {
  return (
    <div className={cn('relative', className)}>
      <Search
        size={15}
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-subtle"
      />
      <input
        type="search"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => {
          onValueChange(event.target.value)
        }}
        className={cn(
          'selectable h-9 w-full rounded-lg border border-line bg-surface pr-9 pl-9 text-sm text-ink',
          'transition-colors placeholder:text-ink-subtle',
          'hover:border-line-strong focus:border-accent',
          // The native search clear button is inconsistently styled across
          // Chromium versions and cannot be themed; ours replaces it.
          '[&::-webkit-search-cancel-button]:hidden',
        )}
      />
      {value.length > 0 && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onValueChange('')
          }}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

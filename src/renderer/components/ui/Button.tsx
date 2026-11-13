import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Renders a spinner and blocks interaction without changing the button width. */
  loading?: boolean
  iconLeft?: ReactNode
  iconRight?: ReactNode
  /** Explicit, because a button inside a form defaults to `submit`. */
  type?: 'button' | 'submit' | 'reset'
}

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary:
    'gradient-accent text-accent-contrast shadow-glow hover:brightness-108 active:brightness-95 disabled:opacity-55 disabled:shadow-none',
  secondary:
    'bg-surface text-ink border border-line hover:bg-surface-2 hover:border-line-strong active:bg-surface-3',
  ghost: 'bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink active:bg-surface-3',
  subtle: 'bg-surface-2 text-ink border border-transparent hover:bg-surface-3',
  danger: 'bg-danger text-white hover:brightness-110 active:brightness-95 shadow-card',
}

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-9.5 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-lg',
}

/**
 * The application's primary action control.
 *
 * `loading` keeps the label mounted and hides it with `invisible` rather than
 * replacing it, so the button does not change width mid-click and shift the
 * layout under the user's cursor.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconLeft,
    iconRight,
    type = 'button',
    className,
    disabled,
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || loading

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex items-center justify-center font-medium select-none',
        'transition-[background-color,border-color,color,filter] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={size === 'lg' ? 18 : 15} />
        </span>
      ) : null}

      <span
        className={cn(
          'inline-flex items-center',
          SIZE_STYLES[size].includes('gap-1.5') ? 'gap-1.5' : 'gap-2',
          loading && 'invisible',
        )}
      >
        {iconLeft}
        {children}
        {iconRight}
      </span>
    </button>
  )
})

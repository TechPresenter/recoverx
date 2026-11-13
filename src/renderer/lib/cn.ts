import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Compose Tailwind class names.
 *
 * `clsx` handles conditionals; `twMerge` resolves conflicts so a caller-supplied
 * `className` reliably overrides a component's default. Without the merge,
 * `<Button className="px-6">` would emit both `px-4` and `px-6` and the winner
 * would depend on stylesheet order rather than on intent.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

import { cn } from '@/lib/cn'

export interface SkeletonProps {
  className?: string
}

/**
 * Loading placeholder.
 *
 * Reserves the space its content will occupy, which is what prevents the layout
 * shift that makes an application feel unstable while data arrives. The shimmer
 * is a background animation, so it costs nothing on the main thread and is
 * suppressed automatically under reduced-motion.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-shimmer rounded-md bg-surface-2',
        'bg-[linear-gradient(90deg,transparent_0%,var(--rx-surface-3)_50%,transparent_100%)]',
        'bg-[length:200%_100%]',
        className,
      )}
    />
  )
}

/** Stack of skeleton lines, for text blocks of a known approximate length. */
export function SkeletonLines({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', index === count - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

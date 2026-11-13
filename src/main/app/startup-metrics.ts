/**
 * Startup instrumentation.
 *
 * The product target is a visible, interactive window in under three seconds on
 * a cold start. A number that is not measured is not a target, so the elapsed
 * time to first paint is recorded on every launch, logged, and surfaced in the
 * About screen — which makes a regression visible during development rather
 * than in a review complaining that the app is slow to open.
 */

export interface StartupMetrics {
  /** High-resolution milliseconds from process start to first paint. */
  readonly startupMs: number
  /** `true` once the main window has painted. */
  readonly isReady: boolean
  /** Record first paint. Ignored after the first call. */
  markFirstPaint(): void
  /** Milliseconds elapsed since process start. */
  elapsed(): number
}

export function createStartupMetrics(): StartupMetrics {
  // `process.hrtime.bigint()` is monotonic — unlike `Date.now()`, it cannot be
  // skewed by an NTP correction landing mid-boot.
  const origin = process.hrtime.bigint()
  let firstPaintMs = 0

  const elapsed = (): number => Number(process.hrtime.bigint() - origin) / 1_000_000

  return {
    get startupMs() {
      return firstPaintMs
    },
    get isReady() {
      return firstPaintMs > 0
    },
    markFirstPaint() {
      if (firstPaintMs > 0) return
      firstPaintMs = Math.round(elapsed() * 100) / 100
    },
    elapsed,
  }
}

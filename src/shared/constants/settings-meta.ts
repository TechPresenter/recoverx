import type { AppSettings } from '../types/settings'

/**
 * Zod-free metadata about settings.
 *
 * Deliberately separate from `types/settings.ts`. That module defines the Zod
 * schemas, so importing any *value* from it drags the whole validation library
 * into the importing bundle — around 270 kB of source in the renderer, which
 * never validates a setting: the main process is the only writer, and it
 * re-validates every patch before persisting.
 *
 * Type-only imports are erased, so this file stays weightless while remaining
 * type-checked against the real settings shape.
 */

/**
 * Settings whose new value only takes effect after the application restarts.
 *
 * Chromium reads the hardware-acceleration switch while creating the GPU
 * process, long before any window exists, so toggling it at runtime does
 * nothing until the next launch. The UI uses this set to offer an inline
 * restart rather than leaving the user with a control that appears broken.
 */
export const RESTART_REQUIRED_SETTINGS: ReadonlySet<keyof AppSettings> = new Set<keyof AppSettings>(
  ['hardwareAcceleration'],
)

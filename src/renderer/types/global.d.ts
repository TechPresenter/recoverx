import type { RecoverXBridge } from '@shared/ipc/bridge'

/**
 * The only global the preload script installs.
 *
 * Declared as non-optional because the renderer cannot function without it: if
 * the bridge is missing, the preload failed to load and the correct response is
 * a hard error at startup (see `src/renderer/lib/ipc-client.ts`), not a
 * codebase full of optional-chaining that quietly degrades.
 */
declare global {
  interface Window {
    readonly recoverx: RecoverXBridge
  }
}

export {}

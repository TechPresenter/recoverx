/**
 * Public surface of the shared kernel.
 *
 * Both processes import from `@shared/...` sub-paths directly for optimal
 * tree-shaking; this barrel exists for ergonomic access in tests and for tooling
 * that needs a single entry point to the contract layer.
 */

export * from './constants/app'
export * from './constants/routes'
export * from './constants/settings-meta'

export * from './ipc/bridge'
export * from './ipc/channels'
export * from './ipc/contracts'

export * from './types/logging'
export * from './types/settings'
export * from './types/system'

export * from './utils/bytes'
export * from './utils/errors'
export * from './utils/guards'
export * from './utils/json'
export * from './utils/result'
export * from './utils/time'

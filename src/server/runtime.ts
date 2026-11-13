import { LicenseAuthority } from './authority'
import {
  ensureDatabaseDirectory,
  loadSigner,
  requireDatabaseFile,
  type ServerConfig,
} from './config'
import { createLicenseHttpServer, listen, type RunningServer } from './http'
import type { Logger } from './log'
import { RateLimiter } from './rate-limit'
import { EventRetention, scheduleEventPruning, type PruningSchedule } from './retention'
import type { TokenSigner } from './signing'
import { LicenseStore } from './store'

/**
 * Assemble a running licence server from a validated configuration.
 *
 * Kept apart from `server.ts` so the integration tests start exactly the same
 * assembly the deployed entry point does — the only thing the entry adds is
 * process signals and the exit code.
 */

export interface StartedServer {
  readonly running: RunningServer
  readonly signer: TokenSigner
  readonly store: LicenseStore
  /** Stop pruning, drain connections, then checkpoint and close the database. */
  stop(graceMs?: number): Promise<void>
}

export interface StartOptions {
  readonly clock?: () => number
}

export async function startServer(
  config: ServerConfig,
  logger: Logger,
  options: StartOptions = {},
): Promise<StartedServer> {
  // The signing key is loaded before the database is touched, so a server
  // whose key is missing or mismatched fails without creating an empty
  // database somewhere surprising.
  const signer = loadSigner(config)

  const dbFile = requireDatabaseFile(config)
  ensureDatabaseDirectory(dbFile)
  const store = LicenseStore.open(dbFile)
  let pruning: PruningSchedule | null = null

  try {
    const clock = options.clock ?? Date.now
    const authority = new LicenseAuthority({
      store,
      signer,
      clock,
      selfRelease: config.selfRelease,
    })

    const server = createLicenseHttpServer({
      authority,
      logger,
      adminToken: config.adminToken,
      trustProxy: config.trustProxy,
      rateLimiter: new RateLimiter({
        burst: config.rateLimit.burst,
        perMinute: config.rateLimit.perMinute,
        clock,
      }),
      healthCheck: () => {
        store.ping()
      },
    })

    // The first pass runs here, before the server takes requests, so history
    // that passed the retention while the server was down goes at once rather
    // than a day later. The constructor repeats the configuration's guard
    // that the retention covers the self-service window.
    pruning = scheduleEventPruning({
      retention: new EventRetention({
        store,
        days: config.eventRetentionDays,
        selfReleaseWindowDays: config.selfRelease.windowDays,
        clock,
      }),
      logger,
    })

    const running = await listen(server, config.port, config.host)
    const schedule = pruning

    return {
      running,
      signer,
      store,
      stop: async (graceMs?: number) => {
        // Before the database closes, so a pass can never start on a closed one.
        schedule.stop()
        try {
          await running.close(graceMs)
        } finally {
          store.close()
        }
      },
    }
  } catch (error) {
    pruning?.stop()
    store.close()
    throw error
  }
}

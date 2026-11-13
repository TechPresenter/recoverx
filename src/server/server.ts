import { ConfigError, readConfig } from './config'
import { createJsonLogger } from './log'
import { startServer, type StartedServer } from './runtime'

/**
 * Licence server entry point.
 *
 *     LICENSE_SIGNING_KEY_FILE=/run/secrets/license-signing-key.pem \
 *     node dist/license-server/server.mjs
 *
 * Everything here is process plumbing — configuration from the environment,
 * signals, exit codes. The server itself is assembled in `runtime.ts`, which
 * the integration tests use directly.
 */

const logger = createJsonLogger()

/** How long in-flight requests get to finish after SIGTERM. */
const SHUTDOWN_GRACE_MS = 10_000

async function main(): Promise<void> {
  const config = readConfig(process.env)
  const started = await startServer(config, logger)

  logger.info('Licence server listening', {
    url: started.running.url,
    database: config.dbFile,
    // The public key is not a secret, and printing it is how an operator
    // checks a server against the value compiled into a desktop build.
    publicKey: started.signer.publicKey,
    publicKeyFingerprint: started.signer.fingerprint,
    publicKeyCheck: config.expectedPublicKey === null ? 'not configured' : 'matches',
    adminApi: config.adminToken === null ? 'disabled' : 'enabled',
    trustProxy: config.trustProxy,
    selfRelease: config.selfRelease,
    eventRetentionDays: config.eventRetentionDays,
  })

  if (config.expectedPublicKey === null) {
    logger.warn(
      'RECOVERX_LICENSE_PUBLIC_KEY is not set, so this server cannot confirm that its signing key matches the public key compiled into the desktop builds. Set it to make a mismatch a start-up error instead of a customer-facing one.',
    )
  }

  installSignalHandlers(started)
}

function installSignalHandlers(started: StartedServer): void {
  let stopping = false

  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      // A second Ctrl+C means "now", and an operator should not have to find
      // the process ID to get it.
      logger.warn('Second signal received; exiting without waiting', { signal })
      process.exit(1)
    }

    stopping = true
    logger.info('Shutting down', { signal, graceMs: SHUTDOWN_GRACE_MS })

    started.stop(SHUTDOWN_GRACE_MS).then(
      () => {
        logger.info('Licence server stopped')
        process.exit(0)
      },
      (error: unknown) => {
        logger.error('Shutdown did not complete cleanly', { error })
        process.exit(1)
      },
    )
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception; exiting', { error })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection; exiting', { error: reason })
  process.exit(1)
})

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logger.error('Configuration error', { message: error.message })
    process.stderr.write(`\nThe licence server did not start.\n\n${error.message}\n\n`)
  } else {
    logger.error('Licence server failed to start', { error })
  }

  process.exit(1)
})

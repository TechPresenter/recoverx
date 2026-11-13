import { generateKeyPairSync, randomInt, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LicenseAuthority,
  PRODUCT_ID,
  type AuditContext,
  type SelfReleasePolicy,
} from '@server/authority'
import { createTokenSigner, type TokenSigner } from '@server/signing'
import { LicenseStore } from '@server/store'

/**
 * Shared fixtures for the licence server tests.
 *
 * Every signing key is generated per run, in memory. A private key committed
 * as a test fixture is a private key that eventually ends up somewhere it
 * should not, and the scheme survives everything except that key leaking.
 */

/** 12 November 2026, 12:00 UTC — a fixed "now" so expiry arithmetic is exact. */
export const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)

export const DAY = 86_400_000

/** Identifiers in the shape `machine-id.ts` produces: 24 base64url characters in groups of four. */
export const MACHINE_A = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ12'
export const MACHINE_B = 'QWER-TYUI-OPAS-DFGH-JKLZ-XCVB'
export const MACHINE_C = 'Z9Y8-X7W6-V5T4-S3R2-Q1P0-_-AB'
export const MACHINE_D = '1234-5678-90AB-CDEF-GHIJ-KLMN'

export const CUSTOMER: AuditContext = { actor: 'customer', ip: '203.0.113.7' }
export const CLI: AuditContext = { actor: 'cli' }

export { PRODUCT_ID }

export interface KeyPair {
  readonly privateKey: KeyObject
  /** SPKI DER, base64 — the form a desktop build embeds. */
  readonly publicKey: string
  /** PKCS#8 PEM — the form `npm run licensing:keys` writes. */
  readonly pem: string
}

export function freshKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }
}

/** A clock a test can move. */
export class FakeClock {
  current: number

  constructor(start = NOW) {
    this.current = start
  }

  readonly now = (): number => this.current

  advance(ms: number): void {
    this.current += ms
  }
}

export interface TempDir {
  readonly path: string
  cleanup(): void
}

export function tempDir(prefix = 'recoverx-licence-'): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true })
    },
  }
}

export interface Fixture {
  readonly dir: TempDir
  readonly dbFile: string
  readonly keys: KeyPair
  readonly signer: TokenSigner
  readonly store: LicenseStore
  readonly clock: FakeClock
  readonly authority: LicenseAuthority
  close(): void
}

export function openFixture(
  options: {
    randomIndex?: (max: number) => number
    keys?: KeyPair
    /** Defaults to the server's own default allowance. */
    selfRelease?: SelfReleasePolicy
  } = {},
): Fixture {
  const dir = tempDir()
  const dbFile = join(dir.path, 'licences.db')
  const keys = options.keys ?? freshKeyPair()
  const signer = createTokenSigner(keys.privateKey)
  const store = LicenseStore.open(dbFile)
  const clock = new FakeClock()
  const authority = new LicenseAuthority({
    store,
    signer,
    clock: clock.now,
    randomIndex: options.randomIndex ?? ((max) => randomInt(max)),
    selfRelease: options.selfRelease,
  })

  return {
    dir,
    dbFile,
    keys,
    signer,
    store,
    clock,
    authority,
    close: () => {
      store.close()
      dir.cleanup()
    },
  }
}

/**
 * A random source that replays `sequence` and then falls back to real
 * randomness — for steering the key generator into a collision.
 */
export function scriptedRandom(sequence: readonly number[]): (max: number) => number {
  let index = 0
  return (max) => {
    const next = sequence[index]
    index += 1
    return next === undefined ? randomInt(max) : next % max
  }
}

/** Nineteen picks that spell `body` in the key alphabet. */
export function picksFor(body: string, alphabet: string): number[] {
  return [...body].map((character) => alphabet.indexOf(character))
}

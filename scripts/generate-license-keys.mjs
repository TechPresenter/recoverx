#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Generate the vendor's licence signing key pair.
 *
 * Run once, before the first release:
 *
 *   npm run licensing:keys
 *
 * The public half is printed for `.env` / CI, where it is compiled into every
 * shipped build. The private half is written to `license-signing-key.pem` in
 * the working directory — which `.gitignore` already covers — and must be moved
 * to the activation service and kept out of this repository. Anyone holding it
 * can mint a licence for any edition of this product, forever.
 *
 * Losing it is worse than leaking it in one respect: every licence already sold
 * was signed with it, and a new key invalidates all of them at once.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')

const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' })

const privatePath = resolve(process.cwd(), 'license-signing-key.pem')
writeFileSync(privatePath, privatePem, { encoding: 'utf8', mode: 0o600 })

process.stdout.write(
  [
    '',
    'Licence signing key pair generated.',
    '',
    'Add this to your build environment (.env, or your CI secret store):',
    '',
    `  RECOVERX_LICENSE_PUBLIC_KEY=${publicDer}`,
    '',
    'The private key was written to:',
    '',
    `  ${privatePath}`,
    '',
    'Move it to your activation service now and delete this copy. It is not',
    'covered by any backup you have not made yourself, and it cannot be',
    'regenerated: replacing it invalidates every licence already sold.',
    '',
  ].join('\n'),
)

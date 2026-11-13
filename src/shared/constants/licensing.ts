/**
 * Vendor licensing configuration.
 *
 * Both values are supplied at build time and are deliberately empty by default,
 * because both fail safe when absent:
 *
 *  - With no public key, no activation can be verified, every build reports
 *    `unverifiable` and runs as Free. A build that shipped without its key
 *    gives the product away to nobody; a build that *defaulted* to trusting
 *    unsigned tokens would give it away to everybody.
 *  - With no activation URL, online activation is refused with an explanation
 *    and offline activation still works. Removing a licence then clears it
 *    locally only; releasing the seat is left to support.
 *
 * The key pair is generated once, with `npm run licensing:keys`. The public
 * half belongs here — it is compiled into every copy shipped and is not a
 * secret. The private half signs activation tokens on the vendor's server and
 * must never enter this repository, because anyone holding it can mint a
 * licence for any edition.
 */

/** Ed25519 public key, SPKI DER encoded as base64. */
export const LICENSE_PUBLIC_KEY: string = readDefine('RECOVERX_LICENSE_PUBLIC_KEY')

/** Endpoint that exchanges a licence key for a signed activation token. */
export const LICENSE_ACTIVATION_URL: string = readDefine('RECOVERX_ACTIVATION_URL')

/**
 * Endpoint that releases this machine's seat when the licence is removed.
 *
 * Derived rather than configured separately, so a build can never be shipped
 * with the two pointing at different servers — activating against one service
 * and releasing against another would leave every seat permanently consumed.
 */
export const LICENSE_DEACTIVATION_URL: string = deriveDeactivationUrl(LICENSE_ACTIVATION_URL)

/**
 * The deactivation endpoint that sits beside an activation endpoint.
 *
 * Resolved as a relative reference, so `…/v1/activate` becomes
 * `…/v1/deactivate` and the version segment is carried across. The activation
 * URL must therefore name the endpoint itself, not a directory: with a trailing
 * slash the result would be `…/activate/deactivate`.
 *
 * Returns an empty string — "not configured" — for an empty or unparsable
 * input rather than throwing. This runs at import time in both processes, and a
 * typo in a build variable must cost the customer an online seat release, not
 * the ability to start the application.
 */
export function deriveDeactivationUrl(activationUrl: string): string {
  if (activationUrl.length === 0) return ''

  try {
    return new URL('deactivate', activationUrl).toString()
  } catch {
    return ''
  }
}

/**
 * Read a build-time value.
 *
 * `import.meta.env` is how Vite exposes these to both bundles. The guard is not
 * ceremony: this module is imported by the renderer, by the main process and by
 * the test runner, and only the first two have the injected object.
 */
function readDefine(name: string): string {
  const source = import.meta.env as unknown as Record<string, unknown> | undefined
  const value = source?.[name]

  return typeof value === 'string' ? value.trim() : ''
}

import { z } from 'zod'
import { FREE_EDITION_RECOVERY_LIMIT_BYTES, LICENSE_EDITIONS } from '../constants/app'

/**
 * Licensing.
 *
 * The model has two distinct pieces, and conflating them is the usual mistake.
 *
 * A **licence key** is the short string a customer types. It is an identifier,
 * not a credential: it is checksummed so typing errors are caught before a
 * network round trip, and it carries no entitlement of its own.
 *
 * An **activation token** is the authority. It is a payload signed with the
 * vendor's private key, naming the edition and the machine it was issued for,
 * and it is verified locally against a public key compiled into the build. That
 * is what makes offline activation possible without trusting the client, and
 * what makes a stolen key useless on a machine it was not issued for.
 *
 * One thing this cannot do is stop a determined attacker. Any check that runs
 * on the user's own machine can be patched out of it, and no amount of
 * obfuscation changes that. The purpose here is to keep honest customers honest
 * and make casual copying not work — not to pretend at unbreakable protection.
 */

export const LicenseEditionSchema = z.enum(LICENSE_EDITIONS)
export type LicenseEdition = z.infer<typeof LicenseEditionSchema>

/**
 * What an edition permits.
 *
 * Deliberately shallow. The only limit the product specifies is the Free
 * edition's recovery ceiling, and inventing further restrictions would be a
 * pricing decision rather than an engineering one. Everything paid is
 * unrestricted; the differences between the paid tiers are seats and support,
 * which live on the vendor's side.
 */
export interface EditionEntitlements {
  /** Total bytes the edition may ever recover. `null` means unlimited. */
  readonly recoveryLimitBytes: number | null
  /** Machines one licence may be activated on. `null` means unlimited. */
  readonly activations: number | null
  /** `true` where the licence permits use on behalf of third parties. */
  readonly commercialUse: boolean
}

export const ENTITLEMENTS: Readonly<Record<LicenseEdition, EditionEntitlements>> = {
  free: {
    recoveryLimitBytes: FREE_EDITION_RECOVERY_LIMIT_BYTES,
    activations: null,
    commercialUse: false,
  },
  professional: { recoveryLimitBytes: null, activations: 1, commercialUse: false },
  business: { recoveryLimitBytes: null, activations: 3, commercialUse: true },
  // Technician licences travel with an engineer between customer machines, so
  // the activation count is the thing that cannot be capped.
  technician: { recoveryLimitBytes: null, activations: null, commercialUse: true },
  enterprise: { recoveryLimitBytes: null, activations: null, commercialUse: true },
}

export function entitlementsFor(edition: LicenseEdition): EditionEntitlements {
  return ENTITLEMENTS[edition]
}

/**
 * Why the application is running at the entitlement it is.
 *
 * Reported so the user is never left guessing. "Your licence stopped working"
 * with no reason is the support ticket this field exists to prevent.
 */
export const LicenseStateSchema = z.enum([
  /** No licence has been activated. */
  'unlicensed',
  /** A valid, signed activation is in force. */
  'active',
  /** The activation is signed but its term has ended. */
  'expired',
  /** The activation is signed for a different machine. */
  'machine-mismatch',
  /** The stored activation failed signature verification. */
  'invalid',
  /** The build carries no public key, so no activation can be trusted. */
  'unverifiable',
])
export type LicenseState = z.infer<typeof LicenseStateSchema>

export const LicenseStatusSchema = z.object({
  state: LicenseStateSchema,
  edition: LicenseEditionSchema,
  /** Masked for display: only the final group is shown. */
  maskedKey: z.string().nullable(),
  activatedAt: z.number().nullable(),
  /** `null` for a perpetual licence. */
  expiresAt: z.number().nullable(),
  /** Stable identifier of this machine, shown for offline activation. */
  machineId: z.string(),
  registeredTo: z.string().nullable(),
  recoveryLimitBytes: z.number().nullable(),
  /** Bytes recovered so far, counted only where a limit applies. */
  recoveredBytes: z.number(),
  /** Bytes still permitted. `null` when unlimited. */
  remainingBytes: z.number().nullable(),
})

export type LicenseStatus = z.infer<typeof LicenseStatusSchema>

/** The payload a signed activation token carries. */
export const ActivationClaimsSchema = z.object({
  /** Format version, so a future issuer can change the shape safely. */
  v: z.literal(1),
  edition: LicenseEditionSchema,
  /** The licence key this activation was issued against. */
  key: z.string().min(1),
  /** Machine the activation is bound to. */
  machine: z.string().min(1),
  issuedAt: z.number(),
  /** Epoch milliseconds, or `null` for perpetual. */
  expiresAt: z.number().nullable(),
  registeredTo: z.string().nullable(),
})

export type ActivationClaims = z.infer<typeof ActivationClaimsSchema>

/** Length of one group in a formatted licence key. */
export const KEY_GROUP_LENGTH = 5

/** Groups after the product prefix. */
export const KEY_GROUP_COUNT = 4

/**
 * Prefix every key carries, so a wrong product's key is rejected instantly.
 *
 * Spelled only with characters from the key alphabet — no I, L, O or U — so
 * there is no misreading of it that the normaliser has to forgive.
 */
export const KEY_PREFIX = 'RECX'

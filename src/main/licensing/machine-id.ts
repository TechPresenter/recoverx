import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hostname, platform, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { APP_ID } from '@shared/constants/app'

/**
 * A stable identifier for this machine.
 *
 * The requirements pull against each other. It must survive a reboot, an
 * application reinstall and a Windows feature update, or paying customers get
 * locked out of software they bought. It must change when the machine is
 * genuinely a different one, or a licence copied to a colleague's computer
 * works. And it must not be a fingerprint the vendor could use to track
 * anything else about the user.
 *
 * The answer used here is Windows' own `MachineGuid`, generated at install and
 * stable for the life of that installation, combined with the host name and
 * salted with the application identifier. The result is hashed, so what leaves
 * the machine is a value that identifies this installation to this vendor and
 * is useless for correlating anything anywhere else.
 *
 * The identifier is presented to the user in full, because offline activation
 * requires them to send it to the vendor, and asking someone to transmit an
 * opaque value they cannot inspect is not a reasonable thing to do.
 */

const execFileAsync = promisify(execFile)

const QUERY_TIMEOUT_MS = 10_000

/** Groups of the displayed identifier, for legibility when read aloud. */
const DISPLAY_GROUP_LENGTH = 4
const DISPLAY_LENGTH = 24

let cached: string | null = null

/**
 * Resolve this machine's identifier.
 *
 * Cached for the process lifetime: it cannot change while the application is
 * running, and every licence check would otherwise spawn a registry query.
 */
export async function resolveMachineId(): Promise<string> {
  if (cached !== null) return cached

  const components = [APP_ID, hostname().toLowerCase(), await readPlatformIdentifier()]

  // Joined with a character none of the components can contain, so two
  // different machines cannot collide by shifting a boundary.
  const digest = createHash('sha256').update(components.join('|')).digest('base64url')

  cached = formatMachineId(digest.slice(0, DISPLAY_LENGTH).toUpperCase())
  return cached
}

/**
 * Read the operating system's own installation identifier.
 *
 * On Windows this is `MachineGuid`, written once when Windows is installed. It
 * is deliberately preferred over hardware serial numbers: a disk or network
 * card can be replaced by a customer without their licence dying, and a virtual
 * machine's synthetic hardware is not stable enough to key a licence to.
 */
async function readPlatformIdentifier(): Promise<string> {
  if (platform() !== 'win32') {
    // Nothing else is a supported target yet. The user account is a poor
    // substitute, but it keeps the identifier stable rather than random, which
    // matters for anyone running the test suite on another platform.
    return `${platform()}:${safeUsername()}`
  }

  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { timeout: QUERY_TIMEOUT_MS, windowsHide: true },
    )

    const guid = extractMachineGuid(stdout)
    if (guid !== null) return guid
  } catch {
    // Falls through: a locked-down machine that refuses the read still gets a
    // usable identifier, just one derived from less stable inputs.
  }

  return `fallback:${safeUsername()}`
}

/**
 * Pull the GUID out of `reg query` output.
 *
 * Exported for tests: the output format is fixed but tab-separated in a way
 * that is easy to parse wrongly, and a wrong parse silently produces a machine
 * identifier that changes between reads.
 */
export function extractMachineGuid(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.includes('MachineGuid')) continue

    // The line is `    MachineGuid    REG_SZ    <guid>`, separated by runs of
    // whitespace whose exact composition varies by Windows version.
    const parts = line.trim().split(/\s+/u)
    const value = parts[parts.length - 1]

    if (value !== undefined && value.length >= 32 && value !== 'REG_SZ') return value
  }

  return null
}

/** Group the identifier so a customer can read it back over the phone. */
export function formatMachineId(raw: string): string {
  const groups: string[] = []

  for (let index = 0; index < raw.length; index += DISPLAY_GROUP_LENGTH) {
    groups.push(raw.slice(index, index + DISPLAY_GROUP_LENGTH))
  }

  return groups.join('-')
}

function safeUsername(): string {
  try {
    return userInfo().username.toLowerCase()
  } catch {
    return 'unknown'
  }
}

/** Discard the cached identifier. Tests only. */
export function resetMachineIdCache(): void {
  cached = null
}

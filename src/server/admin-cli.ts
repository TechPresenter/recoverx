import { existsSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { describeUnknown } from '@shared/utils/errors'
import type { LicenseEdition } from '@shared/types/license'
import { maskKey } from '@shared/utils/license-key'
import {
  LicenseAuthority,
  standingOf,
  type CreateLicensesResult,
  type LicenseDetails,
  type SelfReleaseStanding,
} from './authority'
import {
  ConfigError,
  ensureDatabaseDirectory,
  loadSigner,
  readConfig,
  requireDatabaseFile,
} from './config'
import { isLicenseError } from './errors'
import { EventRetention, type PruneResult } from './retention'
import type { TokenSigner } from './signing'
import { LicenseStore, type LicenseRecord, type LicenseSummary, type PaidEdition } from './store'

/**
 * The licence administration CLI.
 *
 * What an operator runs after a sale, a refund or a support ticket. It works
 * directly on the server's SQLite database — on the same host, or on a copy —
 * and needs the signing key only for the one command that issues a token
 * (`offline`) and the one that prints its public half (`public-key`).
 * `prune-events` is the running server's daily retention pass, on demand.
 *
 * Parsing and execution are separated from the process (`admin.ts`) so the
 * tests can drive every command with an argument array and read back what it
 * printed and what exit code it chose.
 */

const PROGRAM = 'node admin.mjs'

export const COMMAND_NAMES = [
  'create',
  'list',
  'show',
  'revoke',
  'restore',
  'extend',
  'release',
  'reset',
  'offline',
  'prune-events',
  'public-key',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

interface OptionSpec {
  readonly type: 'string' | 'boolean'
  readonly short?: string
  /** Placeholder shown in help, e.g. `<n>`. */
  readonly value?: string
  readonly description: string
}

interface CommandSpec {
  readonly summary: string
  /** Positional arguments, in order. All are required. */
  readonly arguments: readonly string[]
  readonly options: Readonly<Record<string, OptionSpec>>
  readonly examples: readonly string[]
  /** Whether the command needs the private signing key. */
  readonly needsSigner: boolean
}

const COMMON_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  db: {
    type: 'string',
    value: '<file>',
    description: 'Licence database (default: $LICENSE_DB_FILE; one of the two is required)',
  },
  json: { type: 'boolean', description: 'Print JSON instead of text, for scripts' },
  help: { type: 'boolean', short: 'h', description: 'Show help for this command' },
}

const COMMANDS: Readonly<Record<CommandName, CommandSpec>> = {
  create: {
    summary: 'Mint new licence keys',
    arguments: [],
    options: {
      edition: {
        type: 'string',
        value: '<edition>',
        description: 'professional, business, technician or enterprise (required)',
      },
      count: { type: 'string', value: '<n>', description: 'How many keys to mint (default 1)' },
      seats: {
        type: 'string',
        value: '<n|unlimited>',
        description: "Computers per key (default: the edition's standard)",
      },
      expires: {
        type: 'string',
        value: '<date>',
        description: 'Last day the licence works, YYYY-MM-DD (UTC)',
      },
      days: { type: 'string', value: '<n>', description: 'Term length in days, from today' },
      to: { type: 'string', value: '<name>', description: 'Registered owner, shown in the app' },
      email: { type: 'string', value: '<address>', description: "Customer's e-mail address" },
      order: {
        type: 'string',
        value: '<ref>',
        description: 'Order reference; re-running with the same one mints nothing new',
      },
      notes: { type: 'string', value: '<text>', description: 'Free-form note for support' },
    },
    examples: [
      `${PROGRAM} create --edition professional --to "Jane Doe" --email jane@example.com --order INV-1042`,
      `${PROGRAM} create --edition business --days 365 --order INV-1043`,
      `${PROGRAM} create --edition technician --count 5 --expires 2027-12-31 --json`,
    ],
    needsSigner: false,
  },
  list: {
    summary: 'List licences, newest first',
    arguments: [],
    options: {
      edition: { type: 'string', value: '<edition>', description: 'Only this edition' },
      search: {
        type: 'string',
        value: '<text>',
        description: 'Match key, name, e-mail or order reference',
      },
      order: { type: 'string', value: '<ref>', description: 'Only this order reference' },
      limit: { type: 'string', value: '<n>', description: 'At most this many (default 50)' },
      offset: { type: 'string', value: '<n>', description: 'Skip this many first' },
    },
    examples: [`${PROGRAM} list --search jane@example.com`, `${PROGRAM} list --order INV-1042`],
    needsSigner: false,
  },
  show: {
    summary: 'Show a licence, the computers it is on, and its history',
    arguments: ['key'],
    options: {},
    examples: [`${PROGRAM} show RECX-XXXXX-XXXXX-XXXXX-XXXXX`],
    needsSigner: false,
  },
  revoke: {
    summary: 'Stop a licence from activating (refund, chargeback, abuse)',
    arguments: ['key'],
    options: {
      reason: { type: 'string', value: '<text>', description: 'Why, for the audit trail' },
    },
    examples: [`${PROGRAM} revoke RECX-XXXXX-XXXXX-XXXXX-XXXXX --reason "refund INV-1042"`],
    needsSigner: false,
  },
  restore: {
    summary: 'Undo a revocation',
    arguments: ['key'],
    options: {},
    examples: [`${PROGRAM} restore RECX-XXXXX-XXXXX-XXXXX-XXXXX`],
    needsSigner: false,
  },
  extend: {
    summary: 'Renew or change when a licence ends',
    arguments: ['key'],
    options: {
      days: {
        type: 'string',
        value: '<n>',
        description: 'Add n days to the current end date (or to today, if it has passed)',
      },
      expires: { type: 'string', value: '<date>', description: 'Set the last day, YYYY-MM-DD' },
      perpetual: { type: 'boolean', description: 'Remove the end date' },
    },
    examples: [
      `${PROGRAM} extend RECX-XXXXX-XXXXX-XXXXX-XXXXX --days 365`,
      `${PROGRAM} extend RECX-XXXXX-XXXXX-XXXXX-XXXXX --expires 2028-03-31`,
    ],
    needsSigner: false,
  },
  release: {
    // Also the answer to the self-service allowance's refusal; it bypasses the
    // allowance and is not counted against it.
    summary: "Free one computer's seat (old PC died, or the customer's own moves are used up)",
    arguments: ['key', 'machine-id'],
    options: {},
    examples: [`${PROGRAM} release RECX-XXXXX-XXXXX-XXXXX-XXXXX ABCD-EFGH-IJKL-MNOP-QRST-UVWX`],
    needsSigner: false,
  },
  reset: {
    summary: 'Free every seat a licence holds',
    arguments: ['key'],
    options: {},
    examples: [`${PROGRAM} reset RECX-XXXXX-XXXXX-XXXXX-XXXXX`],
    needsSigner: false,
  },
  offline: {
    summary: 'Issue an activation for a computer with no internet access',
    arguments: ['key', 'machine-id'],
    options: {
      out: {
        type: 'string',
        value: '<file>',
        description: 'Write the activation to a file instead of printing it',
      },
    },
    examples: [
      `${PROGRAM} offline RECX-XXXXX-XXXXX-XXXXX-XXXXX ABCD-EFGH-IJKL-MNOP-QRST-UVWX --out activation.txt`,
    ],
    needsSigner: true,
  },
  'prune-events': {
    // The running server does this itself every day; the command is for a
    // database that no server has open, and for seeing what the pass deletes.
    summary: 'Delete activation history older than LICENSE_EVENT_RETENTION_DAYS',
    arguments: [],
    options: {
      'dry-run': {
        type: 'boolean',
        description: 'Count what would be deleted, and delete nothing',
      },
    },
    examples: [`${PROGRAM} prune-events --dry-run`, `${PROGRAM} prune-events --json`],
    needsSigner: false,
  },
  'public-key': {
    summary: 'Print the public key that desktop builds must embed',
    arguments: [],
    options: {},
    examples: [`${PROGRAM} public-key`],
    needsSigner: true,
  },
}

export type ParsedCommandLine =
  | { readonly kind: 'help'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string; readonly usage: string }
  | {
      readonly kind: 'run'
      readonly command: CommandName
      readonly args: readonly string[]
      readonly options: Readonly<Record<string, string | boolean | undefined>>
      readonly db: string | undefined
      readonly json: boolean
    }

function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value)
}

/**
 * Turn an argument vector into a command, help text, or a usage error.
 *
 * The command comes first (`admin <command> [arguments] [options]`), which keeps
 * the grammar unambiguous: an option value can never be mistaken for a command.
 */
export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const [first, ...rest] = argv

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    const topic = first === 'help' ? rest[0] : undefined
    if (topic !== undefined && isCommandName(topic)) {
      return { kind: 'help', text: commandHelp(topic) }
    }
    return { kind: 'help', text: generalHelp() }
  }

  if (!isCommandName(first)) {
    return {
      kind: 'error',
      message: `Unknown command "${first}".`,
      usage: generalHelp(),
    }
  }

  const spec = COMMANDS[first]
  const options = { ...COMMON_OPTIONS, ...spec.options }

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...rest],
      options: Object.fromEntries(
        Object.entries(options).map(([name, option]) => [
          name,
          option.short === undefined
            ? { type: option.type }
            : { type: option.type, short: option.short },
        ]),
      ),
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    return { kind: 'error', message: describeUnknown(error), usage: commandHelp(first) }
  }

  const values = parsed.values as Record<string, string | boolean | undefined>

  if (values.help === true) return { kind: 'help', text: commandHelp(first) }

  if (parsed.positionals.length !== spec.arguments.length) {
    const expected =
      spec.arguments.length === 0
        ? 'takes no arguments'
        : `needs ${spec.arguments.map((name) => `<${name}>`).join(' ')}`
    return {
      kind: 'error',
      message: `"${first}" ${expected}, but was given ${parsed.positionals.length}.`,
      usage: commandHelp(first),
    }
  }

  return {
    kind: 'run',
    command: first,
    args: parsed.positionals,
    options: values,
    db: typeof values.db === 'string' ? values.db : undefined,
    json: values.json === true,
  }
}

export function generalHelp(): string {
  const width = Math.max(...COMMAND_NAMES.map((name) => name.length))

  return [
    'RecoverX licence administration',
    '',
    `Usage: ${PROGRAM} <command> [arguments] [options]`,
    '',
    'Commands:',
    ...COMMAND_NAMES.map((name) => `  ${name.padEnd(width)}  ${COMMANDS[name].summary}`),
    '',
    'Options for every command:',
    ...formatOptions(COMMON_OPTIONS),
    '',
    `Run "${PROGRAM} <command> --help" for a command's own options.`,
    '',
    'Configuration comes from the same environment as the server: LICENSE_DB_FILE,',
    'LICENSE_SIGNING_KEY_FILE or LICENSE_SIGNING_KEY for "offline" and "public-key",',
    'and LICENSE_EVENT_RETENTION_DAYS for "prune-events".',
    'See docs/LICENSE-SERVER.md.',
    '',
  ].join('\n')
}

export function commandHelp(name: CommandName): string {
  const spec = COMMANDS[name]
  const positional = spec.arguments.map((argument) => ` <${argument}>`).join('')
  const own = Object.keys(spec.options).length > 0

  return [
    spec.summary,
    '',
    `Usage: ${PROGRAM} ${name}${positional} [options]`,
    '',
    ...(own ? ['Options:', ...formatOptions(spec.options), ''] : []),
    'Common options:',
    ...formatOptions(COMMON_OPTIONS),
    '',
    'Examples:',
    ...spec.examples.map((example) => `  ${example}`),
    '',
  ].join('\n')
}

function formatOptions(options: Readonly<Record<string, OptionSpec>>): string[] {
  const rows = Object.entries(options).map(([name, option]) => {
    const flag = `${option.short === undefined ? '    ' : `-${option.short}, `}--${name}${
      option.value === undefined ? '' : ` ${option.value}`
    }`
    return [flag, option.description] as const
  })

  const width = Math.max(...rows.map(([flag]) => flag.length))
  return rows.map(([flag, description]) => `  ${flag.padEnd(width)}  ${description}`)
}

// --- execution ---------------------------------------------------------------

export interface AdminIo {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly clock?: () => number
}

/** Raised for a bad option value; reported like a parse error, with exit code 2. */
class UsageError extends Error {}

/**
 * Run the CLI and return the process exit code.
 *
 * 0 success, 1 the operation was refused or failed, 2 the command line was
 * wrong. Scripts can tell "fix your invocation" from "that licence does not
 * exist" without parsing text.
 */
export function runAdmin(argv: readonly string[], io: AdminIo): number {
  const parsed = parseCommandLine(argv)

  if (parsed.kind === 'help') {
    io.stdout(parsed.text)
    return 0
  }

  if (parsed.kind === 'error') {
    io.stderr(`error: ${parsed.message}\n\n${parsed.usage}`)
    return 2
  }

  const fail = (message: string, code: number): number => {
    io.stderr(parsed.json ? `${JSON.stringify({ error: message })}\n` : `error: ${message}\n`)
    return code
  }

  try {
    const config = readConfig(
      parsed.db === undefined ? io.env : { ...io.env, LICENSE_DB_FILE: parsed.db },
      io.cwd,
    )
    const spec = COMMANDS[parsed.command]
    const signer = spec.needsSigner ? loadSigner(config) : null

    if (parsed.command === 'public-key') {
      printPublicKey(signer, parsed.json, io)
      return 0
    }

    const dbFile = requireDatabaseFile(config)

    if (parsed.command === 'create') {
      ensureDatabaseDirectory(dbFile)
    } else if (!existsSync(dbFile)) {
      // Opening would silently create an empty database, and "no licences
      // found" is a misleading answer to "you pointed me at the wrong file".
      return fail(`There is no licence database at ${dbFile}. Set LICENSE_DB_FILE or pass --db.`, 1)
    }

    const store = LicenseStore.open(dbFile)
    try {
      if (parsed.command === 'prune-events') {
        const retention = new EventRetention({
          store,
          days: config.eventRetentionDays,
          selfReleaseWindowDays: config.selfRelease.windowDays,
          ...(io.clock === undefined ? {} : { clock: io.clock }),
        })
        const result = retention.prune({ dryRun: parsed.options['dry-run'] === true })
        io.stdout(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : describePruned(result))
        return 0
      }

      const authority = new LicenseAuthority({
        store,
        signer,
        // The CLI never releases on a customer's behalf through the allowance,
        // but `show` reports against it, so it reads the server's setting.
        selfRelease: config.selfRelease,
        ...(io.clock === undefined ? {} : { clock: io.clock }),
      })
      execute(parsed.command, parsed.args, parsed.options, parsed.json, authority, io)
      return 0
    } finally {
      store.close()
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n\n${commandHelp(parsed.command)}`)
      return 2
    }
    if (isLicenseError(error) || error instanceof ConfigError) return fail(error.message, 1)
    return fail(describeUnknown(error), 1)
  }
}

function execute(
  command: Exclude<CommandName, 'public-key' | 'prune-events'>,
  args: readonly string[],
  options: Readonly<Record<string, string | boolean | undefined>>,
  json: boolean,
  authority: LicenseAuthority,
  io: AdminIo,
): void {
  const text = (name: string): string | undefined => {
    const value = options[name]
    return typeof value === 'string' ? value : undefined
  }
  const key = args[0] ?? ''
  const machine = args[1] ?? ''
  const context = { actor: 'cli' as const }
  const print = (value: unknown, human: string): void => {
    io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : human)
  }

  switch (command) {
    case 'create': {
      const edition = text('edition')
      if (edition === undefined) throw new UsageError('"create" needs --edition.')

      const seats = text('seats')
      const result = authority.createLicenses(
        {
          edition: anyEdition(edition),
          count: integerOption(text('count'), 'count'),
          ...(seats === undefined
            ? {}
            : {
                seats: seats.trim().toLowerCase() === 'unlimited' ? null : integer(seats, 'seats'),
              }),
          expires: text('expires'),
          days: integerOption(text('days'), 'days'),
          registeredTo: text('to'),
          email: text('email'),
          orderRef: text('order'),
          notes: text('notes'),
        },
        context,
      )
      print(result, describeCreated(result))
      return
    }

    case 'list': {
      const edition = text('edition')
      const licenses = authority.list({
        edition: edition === undefined ? undefined : paidEdition(edition),
        search: text('search'),
        orderRef: text('order'),
        limit: integerOption(text('limit'), 'limit'),
        offset: integerOption(text('offset'), 'offset', 0),
      })
      print({ licenses }, describeList(licenses, authority.now()))
      return
    }

    case 'show': {
      const details = authority.show(key)
      print(details, describeDetails(details))
      return
    }

    case 'revoke': {
      const license = authority.revoke(key, text('reason') ?? null, context)
      print({ license }, `Revoked ${license.key}${reasonSuffix(license)}.\n`)
      return
    }

    case 'restore': {
      const license = authority.restore(key, context)
      print({ license }, `Restored ${license.key}; it can be activated again.\n`)
      return
    }

    case 'extend': {
      const license = authority.extend(
        key,
        {
          days: integerOption(text('days'), 'days'),
          expires: text('expires'),
          perpetual: options.perpetual === true ? true : undefined,
        },
        context,
      )
      print(
        { license },
        `${license.key} now ${license.expiresAt === null ? 'never expires' : `expires ${formatTime(license.expiresAt)}`}.\n` +
          'Computers already activated pick up the new date the next time they activate.\n',
      )
      return
    }

    case 'release': {
      const released = authority.release(key, machine, context)
      print(
        { released },
        released
          ? `Released the seat ${machine.trim().toUpperCase()} held on this licence.\n`
          : `Machine ${machine.trim().toUpperCase()} was not holding a seat; nothing changed.\n`,
      )
      return
    }

    case 'reset': {
      const released = authority.resetSeats(key, context)
      print(
        { released },
        `Released ${released} seat${released === 1 ? '' : 's'}. Every computer must activate again.\n`,
      )
      return
    }

    case 'offline': {
      const result = authority.issueOffline(key, machine, context)
      const out = text('out')
      const summary =
        `Activation for ${maskKey(result.claims.key)} (${result.claims.edition}) on machine ${result.claims.machine}, ` +
        `${result.claims.expiresAt === null ? 'perpetual' : `valid until ${formatTime(result.claims.expiresAt)}`}.`

      if (out !== undefined) {
        writeFileSync(out, `${result.token}\n`, { encoding: 'utf8' })
        print(
          { token: result.token, claims: result.claims, file: out },
          `${summary}\nWrote it to ${out}. Send that file to the customer to paste into the offline activation screen.\n`,
        )
        return
      }

      if (json) {
        print({ token: result.token, claims: result.claims }, '')
      } else {
        // The token alone goes to stdout, so `> activation.txt` captures exactly
        // what the customer needs and nothing else.
        io.stderr(`${summary}\nSend the customer the line below.\n`)
        io.stdout(`${result.token}\n`)
      }
      return
    }
  }
}

function printPublicKey(signer: TokenSigner | null, json: boolean, io: AdminIo): void {
  if (signer === null) throw new Error('No signing key is loaded')

  io.stdout(
    json
      ? `${JSON.stringify({ publicKey: signer.publicKey, fingerprint: signer.fingerprint }, null, 2)}\n`
      : [
          'Put this in the build environment of every desktop release:',
          '',
          `RECOVERX_LICENSE_PUBLIC_KEY=${signer.publicKey}`,
          '',
          `Fingerprint: ${signer.fingerprint}`,
          '',
        ].join('\n'),
  )
}

// --- option values -----------------------------------------------------------

function integer(raw: string, name: string): number {
  const trimmed = raw.trim()
  if (!/^\d{1,9}$/u.test(trimmed)) {
    throw new UsageError(`--${name} must be a whole number, not "${raw}".`)
  }
  return Number(trimmed)
}

function integerOption(raw: string | undefined, name: string): number | undefined
function integerOption(raw: string | undefined, name: string, fallback: number): number
function integerOption(
  raw: string | undefined,
  name: string,
  fallback?: number,
): number | undefined {
  return raw === undefined ? fallback : integer(raw, name)
}

/**
 * Any edition name, Free included.
 *
 * Free is let through on purpose so the licensing rules, not the argument
 * parser, explain why it cannot be minted.
 */
function anyEdition(raw: string): LicenseEdition {
  const value = raw.trim().toLowerCase()
  if (value === 'free') return value
  return paidEdition(value)
}

function paidEdition(raw: string): PaidEdition {
  const value = raw.trim().toLowerCase()
  if (
    value === 'professional' ||
    value === 'business' ||
    value === 'technician' ||
    value === 'enterprise'
  ) {
    return value
  }
  throw new UsageError(
    `--edition must be professional, business, technician or enterprise, not "${raw}".`,
  )
}

// --- human-readable output ---------------------------------------------------

function formatTime(epochMs: number): string {
  const iso = new Date(epochMs).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function seatsOf(license: LicenseRecord): string {
  return license.maxActivations === null ? 'unlimited' : String(license.maxActivations)
}

function reasonSuffix(license: LicenseRecord): string {
  return license.revokeReason === null ? '' : ` (${license.revokeReason})`
}

function describeCreated(result: CreateLicensesResult): string {
  const first = result.licenses[0]
  if (first === undefined) return 'No licences were created.\n'

  const count = result.licenses.length
  const plural = count === 1 ? '' : 's'
  const term = first.expiresAt === null ? 'perpetual' : `until ${formatTime(first.expiresAt)}`
  const seats =
    first.maxActivations === null
      ? 'unlimited computers'
      : `${first.maxActivations} computer${first.maxActivations === 1 ? '' : 's'}`

  const header = result.created
    ? `Created ${count} ${first.edition} licence${plural} (${seats} each, ${term}).`
    : `Order ${first.orderRef ?? ''} was already fulfilled, so nothing new was created. Its licence${plural}:`

  const owner = [
    first.registeredTo === null ? null : `Registered to: ${first.registeredTo}`,
    first.email === null ? null : `E-mail: ${first.email}`,
    first.orderRef === null ? null : `Order: ${first.orderRef}`,
  ].filter((part): part is string => part !== null)

  return [
    header,
    ...(owner.length > 0 ? [owner.join('   ')] : []),
    '',
    ...result.licenses.map((license) => `  ${license.key}`),
    '',
  ].join('\n')
}

function describeList(licenses: readonly LicenseSummary[], now: number): string {
  if (licenses.length === 0) return 'No licences match.\n'

  const rows = licenses.map((license) => [
    license.key,
    license.edition,
    `${license.activeSeats}/${seatsOf(license)}`,
    license.expiresAt === null ? 'perpetual' : formatTime(license.expiresAt).slice(0, 10),
    standingOf(license, now),
    license.registeredTo ?? '',
    license.orderRef ?? '',
  ])

  return `${table(['KEY', 'EDITION', 'SEATS', 'EXPIRES', 'STATUS', 'REGISTERED TO', 'ORDER'], rows)}\n`
}

function describeDetails(details: LicenseDetails): string {
  const { license } = details

  const status =
    details.standing === 'revoked' && license.revokedAt !== null
      ? `revoked ${formatTime(license.revokedAt)}${reasonSuffix(license)}`
      : details.standing === 'expired' && license.expiresAt !== null
        ? `expired ${formatTime(license.expiresAt)}`
        : 'active'

  const fields: Array<readonly [string, string]> = [
    ['Key', license.key],
    ['Edition', license.edition],
    ['Status', status],
    ['Seats', `${details.activeSeats} of ${seatsOf(license)} in use`],
    ['Self-service moves', describeSelfReleases(details.selfReleases)],
    ['Expires', license.expiresAt === null ? 'never (perpetual)' : formatTime(license.expiresAt)],
    ['Registered to', license.registeredTo ?? '-'],
    ['E-mail', license.email ?? '-'],
    ['Order', license.orderRef ?? '-'],
    ['Created', formatTime(license.createdAt)],
    ['Notes', license.notes ?? '-'],
  ]

  const width = Math.max(...fields.map(([label]) => label.length)) + 1
  const lines = fields.map(([label, value]) => `${`${label}:`.padEnd(width)}  ${value}`)

  const machines =
    details.activations.length === 0
      ? ['  (never activated)']
      : table(
          ['MACHINE', 'FIRST ACTIVATED', 'LAST ACTIVATED', 'RELEASED'],
          details.activations.map((activation) => [
            activation.machineId,
            formatTime(activation.firstActivatedAt),
            formatTime(activation.lastActivatedAt),
            activation.releasedAt === null ? '-' : formatTime(activation.releasedAt),
          ]),
        )
          .split('\n')
          .map((line) => `  ${line}`)

  const events =
    details.events.length === 0
      ? ['  (none)']
      : details.events.map((event) =>
          `  ${formatTime(event.at)}  ${event.type.padEnd(20)}  ${event.machineId ?? ''}${
            event.ip === null ? '' : `  from ${event.ip}`
          }`.trimEnd(),
        )

  return [...lines, '', 'Computers:', ...machines, '', 'Recent events:', ...events, ''].join('\n')
}

function describePruned(result: PruneResult): string {
  const events = `${result.found} event${result.found === 1 ? '' : 's'}`
  const before = `recorded before ${formatTime(result.cutoff)} (the retention is ${result.retentionDays} days)`

  if (result.dryRun) {
    return `${events} ${before} would be deleted. This was a dry run: nothing was deleted.\n`
  }
  if (result.deleted === 0) return `No events were ${before}; nothing was deleted.\n`
  return `Deleted ${events} ${before}.\n`
}

/**
 * The self-service release allowance, as support reads it while a customer
 * explains that the application refused to move their licence.
 */
function describeSelfReleases(standing: SelfReleaseStanding): string {
  const recent = `${standing.recent} in the last ${standing.windowDays} days`

  if (standing.limit === null) return `${recent}; not limited (unlimited seats)`
  if (standing.limit === 0) return `${recent}; self-service moves are turned off — use release`

  const spent = standing.recent >= standing.limit ? ' — allowance spent; use release or reset' : ''
  return `${standing.recent} of ${standing.limit} in the last ${standing.windowDays} days${spent}`
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()

  return [line(headers), ...rows.map(line)].join('\n')
}

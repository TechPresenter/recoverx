#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * Build, sign, verify and stage RecoverX for the Microsoft Store.
 *
 *   npm run package:store                 (runs `npm run icon` and `npm run build` first)
 *   node scripts/package-store.mjs --help
 *
 * The primary Store route is an MSI/EXE listing of the NSIS installer (Store
 * Policy 10.2.9). Microsoft does not host or re-sign such an app: Partner Center
 * is given a URL, downloads the installer from it, and checks that the
 * installer *and every PE file inside it* is signed by a certificate from the
 * Microsoft Trusted Root Program. Most of what this script does follows from
 * that:
 *
 *  1. Preflight. A Store build that cannot verify licences would refuse every
 *     key a customer buys, and it would pass certification anyway, because a
 *     certifier on the Free edition never notices. So the licence public key
 *     and activation URL compiled into out/ are checked before anything is
 *     built, along with the version and the signing material.
 *  2. Build the NSIS installer with electron-builder, with `forceCodeSigning`
 *     so a signing failure stops the build instead of producing a half-signed
 *     installer. The NSIS plug-in DLLs, which electron-builder leaves unsigned,
 *     are signed with the same certificate before makensis embeds them.
 *  3. Verify every PE file — the unpacked app, resources\elevate.exe, the
 *     installer, the uninstaller extracted back out of the installer, and the
 *     NSIS plug-ins inside both — with Windows' own Get-AuthenticodeSignature.
 *     electron-builder reporting success is not evidence; the signature on the
 *     file is. Then check that the publisher name written for electron-updater
 *     matches that signer, or no installed copy could ever update again.
 *  4. Stage release/<version>/store/: a copy of the installer under the name it
 *     is published with (RecoverX-Setup-<version>-x64.exe, plus a
 *     NOT-FOR-SUBMISSION suffix on dry runs), its SHA-256, and submission.md /
 *     submission.json holding exactly what to type into Partner Center.
 *
 * `--msix` builds the optional MSIX package instead (electron-builder.msix.yml).
 *
 * Dry runs (`--unsigned`, `--allow-unlicensed`, `--allow-untrusted-signatures`,
 * `--override-version`) are for testing this pipeline. Their output is named
 * and stamped NOT-FOR-SUBMISSION, and by default goes to a separate directory
 * so it can never overwrite a real release.
 *
 * Pure Node, no dependencies beyond electron-builder itself. Windows only:
 * signtool, makeappx and Get-AuthenticodeSignature are Windows tools.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/**
 * require() as electron-builder itself resolves modules, so the
 * app-builder-lib internals used here are the very copy that runs the build.
 */
const builderRequire = () => createRequire(require.resolve('electron-builder'))

/** Where the installer is hosted when RECOVERX_STORE_DOWNLOAD_BASE is not set. */
const DEFAULT_DOWNLOAD_BASE = 'https://recoverx.snapkio.com/downloads/win'

/** Partner Center → Packages → "Installer parameters" for an NSIS installer. */
const SILENT_SWITCH = '/S'

const NOT_FOR_SUBMISSION = 'NOT-FOR-SUBMISSION'

/**
 * How the NSIS installer's exit codes map onto Partner Center's scenarios.
 *
 * 0, 1 and 2 are NSIS's own contract (0 success, 1 cancelled by the user, 2
 * aborted by the script); electron-builder's templates use no other codes for
 * an assisted, per-machine installer. 1223 never comes from the installer at
 * all: it is ERROR_CANCELLED, which Windows returns to whoever launched the
 * installer when the user declines the UAC prompt, so the installer never
 * starts.
 */
const RETURN_CODES = [
  { code: 0, scenario: 'Installation successful', meaning: 'Installed (or reinstalled) normally.' },
  {
    code: 1,
    scenario: 'Installation cancelled by user',
    meaning: 'The user cancelled the installer. Cannot happen in a silent (/S) install.',
  },
  {
    code: 1223,
    scenario: 'Installation cancelled by user',
    meaning: 'The UAC elevation prompt was declined (ERROR_CANCELLED); the installer never ran.',
  },
  {
    code: 2,
    scenario: 'Miscellaneous',
    meaning:
      'Aborted by the installer: another copy of the installer is running, RecoverX could not be closed, the previous version failed to uninstall, or Windows is not 64-bit.',
  },
]

// --- Command line ----------------------------------------------------------

const HELP = `Build, sign, verify and stage RecoverX for the Microsoft Store.

Usage:
  npm run package:store [-- options]
  node scripts/package-store.mjs [options]     (after npm run icon && npm run build)

Options:
  --msix                        Build the OPTIONAL MSIX package (electron-builder.msix.yml)
                                instead of the signed NSIS installer. Only after Microsoft
                                has pre-approved the allowElevation capability.
  --out <dir>                   Output directory. Default: release/<version>
                                (release/<version>-${NOT_FOR_SUBMISSION} for dry runs).
  --help                        Show this help.

Dry-run switches (output is labelled ${NOT_FOR_SUBMISSION}):
  --unsigned                    Build without signing; report signatures instead of failing.
  --allow-unlicensed            Continue when the licence public key / activation URL are
                                missing or wrong. Such a build rejects every licence key.
  --allow-untrusted-signatures  Accept signatures that do not chain to a trusted root and
                                lack a timestamp (a throwaway self-signed test certificate).
  --override-version <x.y.z>    Package under another version without editing package.json.

Licensing (read at BUILD time by electron-vite, from the environment or .env files):
  RECOVERX_LICENSE_PUBLIC_KEY   Ed25519 public key, SPKI DER base64 (npm run licensing:keys).
  RECOVERX_ACTIVATION_URL       https://…/v1/activate on the licence server.

Signing (exactly one; see docs/BUILDING.md#code-signing):
  WIN_CSC_SHA1 / WIN_CSC_SUBJECT_NAME
                                A token / HSM certificate in the Windows certificate store,
                                selected by thumbprint and/or subject. signtool signs through
                                the vendor's CSP/KSP.
  CSC_LINK (+ CSC_KEY_PASSWORD) A .pfx file or its base64 (legacy; WIN_CSC_LINK also works).
  WIN_SIGN_HOOK                 Path to a module exporting async (configuration) => void
                                that signs AND timestamps configuration.path (cloud HSM
                                tools). Requires WIN_PUBLISHER_NAME.
  AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER_NAME
                                Azure Artifact Signing (plus AZURE_TENANT_ID, AZURE_CLIENT_ID,
                                AZURE_CLIENT_SECRET). Not offered to organisations in India.
  WIN_PUBLISHER_NAME            With WIN_SIGN_HOOK only: the certificate subject's CN exactly
                                (or its full DN), recorded for electron-updater's update
                                signature check. Ignored for the other mechanisms, where it is
                                read from the certificate. Either way the build fails unless
                                it matches the installer's actual signer.

Store staging:
  RECOVERX_STORE_DOWNLOAD_BASE  HTTPS base the installer is hosted under.
                                Default: ${DEFAULT_DOWNLOAD_BASE} → <base>/<version>/<file>

MSIX (--msix), copied exactly from Partner Center → Product identity:
  RECOVERX_STORE_IDENTITY_NAME            Package/Identity/Name
  RECOVERX_STORE_PUBLISHER                Package/Identity/Publisher (CN=…)
  RECOVERX_STORE_PUBLISHER_DISPLAY_NAME   Package/Properties/PublisherDisplayName

Note: every RECOVERX_* variable present during \`npm run build\` is compiled into the
app bundle by electron-vite. Never put a secret in a RECOVERX_* variable.
`

function parseCommandLine() {
  try {
    const { values } = parseArgs({
      options: {
        msix: { type: 'boolean', default: false },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        unsigned: { type: 'boolean', default: false },
        'allow-unlicensed': { type: 'boolean', default: false },
        'allow-untrusted-signatures': { type: 'boolean', default: false },
        'override-version': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    })
    return values
  } catch (error) {
    process.stderr.write(`${error.message}\n\nRun with --help for usage.\n`)
    process.exit(2)
  }
}

// --- Output helpers --------------------------------------------------------

function say(line = '') {
  process.stdout.write(`${line}\n`)
}

function heading(text) {
  say('')
  say(`== ${text} ${'='.repeat(Math.max(0, 72 - text.length))}`)
}

/** A failure the user can fix, reported with how to fix it. */
class Problem extends Error {
  constructor(message, fix) {
    super(message)
    this.fix = fix
  }
}

// --- Preflight: environment as electron-vite sees it ------------------------

/**
 * Minimal dotenv reader, matching what Vite's loader accepts for the values
 * this script cares about: KEY=value, optional `export`, optional quotes, and
 * `#` comments after an unquoted value.
 */
function readDotenv(file) {
  if (!existsSync(file)) return {}

  const result = {}
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const match = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/u.exec(line)
    if (match === null) continue

    let value = match[2].trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'" || quote === '`') && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1))
      if (quote === '"') value = value.replace(/\\n/gu, '\n')
    } else {
      value = value.replace(/\s+#.*$/u, '').trim()
    }

    result[match[1]] = value
  }

  return result
}

/**
 * The RECOVERX_* values a production `electron-vite build` compiles in.
 *
 * Vite's precedence, lowest first: .env, .env.local, .env.production,
 * .env.production.local, then the process environment, which always wins. The
 * main bundle's root is the project root, so that is where the files are read.
 */
function resolveBuildEnvironment() {
  const merged = {}
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    Object.assign(merged, readDotenv(join(ROOT, name)))
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('RECOVERX_') && value !== undefined) merged[key] = value
  }

  return merged
}

/**
 * Find the value a bundle was compiled with.
 *
 * electron-vite inlines `import.meta.env` as an object literal, so a value
 * appears as `RECOVERX_NAME:"value"` (esbuild writes plain ASCII strings with
 * double quotes). Returns '' when the bundle carries no such value, trimmed
 * the way src/shared/constants/licensing.ts trims it at run time.
 */
function compiledValue(bundle, name) {
  const match = new RegExp(`["']?${name}["']?\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'u').exec(bundle)
  return match === null ? '' : JSON.parse(`"${match[1]}"`).trim()
}

/** Long values (the public key) shortened for a one-line message. */
function abbreviate(value) {
  return value.length > 40 ? `${value.slice(0, 16)}…${value.slice(-12)}` : value
}

function checkLicensing(problems, warnings) {
  const bundlePath = join(ROOT, 'out', 'main', 'index.js')
  const bundle = readFileSync(bundlePath, 'utf8')
  const environment = resolveBuildEnvironment()

  /*
   * What ships is the value compiled into out/, so that is the value read and
   * validated — never the environment's. The environment only says what it
   * *should* be: when it names a value, the compiled one must equal it
   * exactly. A substring test is not enough: out/ built with
   * `…/v1/activate/` contains `…/v1/activate`, and would pass while shipping
   * a client whose seat releases all go to `…/activate/deactivate`.
   */
  const resolveValue = (name) => {
    const compiled = compiledValue(bundle, name)
    const expected = (environment[name] ?? '').trim()
    return { value: compiled, expected, stale: expected.length > 0 && compiled !== expected }
  }

  const key = resolveValue('RECOVERX_LICENSE_PUBLIC_KEY')
  const url = resolveValue('RECOVERX_ACTIVATION_URL')
  const rebuild =
    'Set it in the environment (or .env.production) and run `npm run package:store`, which rebuilds out/ first.'
  const stale = (name, entry, show) =>
    new Problem(
      `${name} is set to ${show(entry.expected)}, but out/main/index.js was built with ${entry.value.length > 0 ? show(entry.value) : 'none'} — out/ is stale.`,
      'Rebuild with `npm run build` (npm run package:store does this) in the environment that holds the intended value.',
    )

  if (key.stale) {
    problems.push(stale('RECOVERX_LICENSE_PUBLIC_KEY', key, abbreviate))
  } else if (key.value.length === 0) {
    problems.push(
      new Problem(
        'RECOVERX_LICENSE_PUBLIC_KEY is not set, and out/main/index.js was built without one. This build would reject every licence key a customer buys.',
        `Generate the key pair once with \`npm run licensing:keys\` (keep the private key on the licence server). ${rebuild}`,
      ),
    )
  } else {
    try {
      const parsed = createPublicKey({
        key: Buffer.from(key.value, 'base64'),
        format: 'der',
        type: 'spki',
      })
      if (parsed.asymmetricKeyType !== 'ed25519') {
        throw new Error(`it is an ${String(parsed.asymmetricKeyType)} key`)
      }
      say(`  licence public key  ok (Ed25519, compiled into out/: ${abbreviate(key.value)})`)
    } catch (error) {
      problems.push(
        new Problem(
          `RECOVERX_LICENSE_PUBLIC_KEY compiled into out/ is not an Ed25519 SPKI public key in base64: ${error.message}.`,
          'Copy the value `npm run licensing:keys` printed — the base64 line, not the PEM private key.',
        ),
      )
    }
  }

  if (url.stale) {
    problems.push(stale('RECOVERX_ACTIVATION_URL', url, (value) => value))
  } else if (url.value.length === 0) {
    problems.push(
      new Problem(
        'RECOVERX_ACTIVATION_URL is not set, and out/main/index.js was built without one. Online activation would be refused in every copy.',
        `Deploy the licence server (server-php/README.md) and set its activation endpoint, e.g. https://recoverx.snapkio.com/v1/activate. ${rebuild}`,
      ),
    )
  } else {
    let parsed = null
    try {
      parsed = new URL(url.value)
    } catch {
      problems.push(
        new Problem(
          `RECOVERX_ACTIVATION_URL compiled into out/ is not a URL: ${url.value}`,
          'Use the full https://… address of /v1/activate.',
        ),
      )
    }

    if (parsed !== null) {
      if (parsed.protocol !== 'https:') {
        problems.push(
          new Problem(
            `RECOVERX_ACTIVATION_URL must use https (it is ${parsed.protocol}//). Licence keys and machine ids must not cross the internet in clear text.`,
            'Put the licence server behind TLS (docs/LICENSE-SERVER.md) and use its https:// address.',
          ),
        )
      } else if (parsed.pathname.endsWith('/')) {
        problems.push(
          new Problem(
            'RECOVERX_ACTIVATION_URL ends with "/". The client derives the deactivation endpoint from it as a relative URL, which then becomes …/activate/deactivate.',
            'Name the endpoint itself, e.g. https://recoverx.snapkio.com/v1/activate.',
          ),
        )
      } else {
        if (!parsed.pathname.endsWith('/activate')) {
          warnings.push(
            `RECOVERX_ACTIVATION_URL does not end in /activate (${parsed.pathname}); the licence server's contract is POST /v1/activate.`,
          )
        }
        say(`  activation URL      ok (compiled into out/: ${url.value})`)
      }
    }
  }
}

// --- Preflight: version ----------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

function checkVersion(version, msix, problems) {
  const match = SEMVER.exec(version)
  if (match === null) {
    problems.push(
      new Problem(`Version "${version}" is not x.y.z semver.`, 'Fix "version" in package.json.'),
    )
    return
  }

  if (match[4] !== undefined) {
    problems.push(
      new Problem(
        `Version ${version} is a pre-release. The Store offers one build to every customer, and pre-releases belong on the beta/alpha update channels.`,
        'Release a stable x.y.z version (npm version <x.y.z> --no-git-tag-version).',
      ),
    )
  }

  if (msix) {
    const parts = match.slice(1, 4).map(Number)
    if (parts[0] < 1) {
      problems.push(
        new Problem(
          `MSIX version ${version} becomes ${version}.0, and the Store rejects a package version whose first part is 0.`,
          'Release the MSIX as 1.0.0 or later.',
        ),
      )
    }
    if (parts.some((part) => part > 65535)) {
      problems.push(
        new Problem(
          `Every MSIX version part must be at most 65535 (${version}).`,
          'Use a smaller version number.',
        ),
      )
    }
  }
}

// --- Preflight: signing ----------------------------------------------------

function present(name) {
  const value = process.env[name]
  return value !== undefined && value.trim().length > 0
}

const PFX_VARIABLES = ['CSC_LINK', 'WIN_CSC_LINK']
const STORE_VARIABLES = ['WIN_CSC_SHA1', 'WIN_CSC_SUBJECT_NAME']
const AZURE_VARIABLES = [
  'AZURE_SIGN_ENDPOINT',
  'AZURE_SIGN_ACCOUNT',
  'AZURE_SIGN_PROFILE',
  'AZURE_SIGN_PUBLISHER_NAME',
]
const ALL_SIGNING_VARIABLES = [
  ...PFX_VARIABLES,
  'CSC_KEY_PASSWORD',
  'WIN_CSC_KEY_PASSWORD',
  ...STORE_VARIABLES,
  'WIN_SIGN_HOOK',
  'WIN_PUBLISHER_NAME',
  ...AZURE_VARIABLES,
]

/**
 * Turn the signing environment into electron-builder `win` configuration.
 *
 * Exactly one mechanism may be configured. electron-builder has its own
 * precedence when several are present (Azure over a hook over the store over a
 * .pfx), and a release signed with a certificate other than the one intended
 * is caught only by the signer check after a full build — so the ambiguity is
 * refused up front instead.
 *
 * The publisher name matters as much as the signature. electron-builder writes
 * it into resources\app-update.yml, and electron-updater installs an update
 * only if the downloaded installer's signer matches it exactly (the subject's
 * CN, or every field of a full DN). A name that differs from the certificate
 * by so much as "Private Limited" ships a release that refuses every later
 * update, and Store-installed copies can then only be fixed by hand. So:
 *
 *  - .pfx and certificate store: electron-builder reads the certificate and
 *    derives the name itself, which is right by construction. A
 *    WIN_PUBLISHER_NAME there is ignored rather than allowed to override it.
 *  - Hook and Azure: electron-builder never sees the certificate, so the name
 *    must be supplied — and checkUpdaterPublisher() compares what was written
 *    with the signer actually found on the installer before anything is staged.
 */
function signingConfiguration(problems, warnings) {
  const mechanisms = []
  if (PFX_VARIABLES.some(present)) mechanisms.push('pfx')
  if (STORE_VARIABLES.some(present)) mechanisms.push('certificate-store')
  if (present('WIN_SIGN_HOOK')) mechanisms.push('hook')
  if (AZURE_VARIABLES.some(present)) mechanisms.push('azure')

  if (mechanisms.length === 0) {
    problems.push(
      new Problem(
        'No code-signing certificate is configured. The Store requires the installer and every PE file in it to be signed by a Microsoft Trusted Root Program CA.',
        'Set WIN_CSC_SHA1 (thumbprint of your token/HSM certificate in the Windows certificate store), or CSC_LINK + CSC_KEY_PASSWORD for a .pfx, or WIN_SIGN_HOOK for a cloud HSM. See docs/BUILDING.md#code-signing. For a pipeline test, pass --unsigned.',
      ),
    )
    return null
  }

  if (mechanisms.length > 1) {
    problems.push(
      new Problem(
        `More than one signing mechanism is configured (${mechanisms.join(', ')}).`,
        'Unset all but one, so the certificate that signs the release is the one you intended.',
      ),
    )
    return null
  }

  const publisherName = process.env.WIN_PUBLISHER_NAME?.trim() ?? ''
  if (publisherName.length > 0 && mechanisms[0] !== 'hook') {
    warnings.push(
      `WIN_PUBLISHER_NAME ("${publisherName}") is ignored: with ${mechanisms[0] === 'azure' ? 'Azure Artifact Signing the name is AZURE_SIGN_PUBLISHER_NAME' : 'this certificate electron-builder reads the publisher name from the certificate itself'}.`,
    )
  }

  switch (mechanisms[0]) {
    case 'pfx':
      // electron-builder reads CSC_LINK / WIN_CSC_LINK and the password itself.
      return {
        description: `.pfx certificate from ${present('WIN_CSC_LINK') ? 'WIN_CSC_LINK' : 'CSC_LINK'}`,
        win: { signtoolOptions: {} },
      }

    case 'certificate-store': {
      const options = {}
      if (present('WIN_CSC_SHA1')) {
        options.certificateSha1 = process.env.WIN_CSC_SHA1.replace(/\s+/gu, '').toUpperCase()
      }
      if (present('WIN_CSC_SUBJECT_NAME')) {
        options.certificateSubjectName = process.env.WIN_CSC_SUBJECT_NAME.trim()
      }
      return {
        description: `certificate-store certificate (${Object.entries(options)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')})`,
        win: { signtoolOptions: options },
      }
    }

    case 'hook': {
      const hook = resolve(ROOT, process.env.WIN_SIGN_HOOK.trim())
      if (!existsSync(hook)) {
        problems.push(
          new Problem(`WIN_SIGN_HOOK points to ${hook}, which does not exist.`, 'Fix the path.'),
        )
        return null
      }
      if (publisherName.length === 0) {
        problems.push(
          new Problem(
            'WIN_SIGN_HOOK is set without WIN_PUBLISHER_NAME. With a hook electron-builder never sees the certificate, so it cannot record the publisher that electron-updater checks every downloaded update against — and without it, updates install unverified.',
            "Set WIN_PUBLISHER_NAME to the certificate subject's CN exactly as the CA issued it (the CA's portal and the certificate's details show it — legal suffixes such as \"Private Limited\" included), or to its full subject DN. The build fails if it does not match the signer.",
          ),
        )
        return null
      }
      return {
        description: `signing hook ${relative(ROOT, hook)}`,
        win: { signtoolOptions: { sign: hook, publisherName } },
      }
    }

    case 'azure': {
      const missing = [...AZURE_VARIABLES, 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID'].filter(
        (name) => !present(name),
      )
      if (missing.length > 0) {
        problems.push(
          new Problem(
            `Azure Artifact Signing is partly configured; missing ${missing.join(', ')}.`,
            'Set all of them (and AZURE_CLIENT_SECRET or another EnvironmentCredential method), or unset the AZURE_SIGN_* variables.',
          ),
        )
        return null
      }
      return {
        description: `Azure Artifact Signing (${process.env.AZURE_SIGN_ACCOUNT} / ${process.env.AZURE_SIGN_PROFILE})`,
        win: {
          // Dropped explicitly: electron-builder warns and ignores signtool
          // options when Azure is configured, and the log should not suggest
          // that anything in them applies.
          signtoolOptions: null,
          azureSignOptions: {
            publisherName: process.env.AZURE_SIGN_PUBLISHER_NAME.trim(),
            endpoint: process.env.AZURE_SIGN_ENDPOINT.trim(),
            codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT.trim(),
            certificateProfileName: process.env.AZURE_SIGN_PROFILE.trim(),
          },
        },
      }
    }

    default:
      return null
  }
}

// --- Preflight: MSIX identity ------------------------------------------------

function msixIdentity(problems) {
  const identityName = process.env.RECOVERX_STORE_IDENTITY_NAME?.trim() ?? ''
  const publisher = process.env.RECOVERX_STORE_PUBLISHER?.trim() ?? ''
  const publisherDisplayName = process.env.RECOVERX_STORE_PUBLISHER_DISPLAY_NAME?.trim() ?? ''
  const where =
    'Copy it exactly (case-sensitive) from Partner Center → your app → Product management → Product identity.'

  if (!/^[A-Za-z0-9.-]{3,50}$/u.test(identityName)) {
    problems.push(
      new Problem(
        `RECOVERX_STORE_IDENTITY_NAME must be the Package/Identity/Name value (3–50 letters, digits, "." or "-"); got "${identityName}".`,
        where,
      ),
    )
  }
  // Partner Center shows Package/Identity/Publisher with its "CN=" already in
  // place; prefixing another one gives a package the reserved product rejects
  // at upload, after a sideload test that passes (the test certificate would
  // be made from the same doubled value).
  if (!publisher.startsWith('CN=') || /^CN=\s*CN=/iu.test(publisher)) {
    problems.push(
      new Problem(
        `RECOVERX_STORE_PUBLISHER must be the Package/Identity/Publisher value exactly as Partner Center shows it, which starts with a single "CN=" (e.g. CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX); got "${publisher}".`,
        where,
      ),
    )
  }
  if (publisherDisplayName.length === 0) {
    problems.push(
      new Problem(
        'RECOVERX_STORE_PUBLISHER_DISPLAY_NAME (Package/Properties/PublisherDisplayName) is not set.',
        where,
      ),
    )
  }

  // The Store re-signs MSIX packages itself. A package signed here would need a
  // certificate whose subject equals the Partner Center publisher, and a .pfx
  // meant for the NSIS installer would either fail the build or, worse,
  // produce a package with the wrong identity.
  const leaked = ALL_SIGNING_VARIABLES.filter(present)
  if (leaked.length > 0) {
    problems.push(
      new Problem(
        `Code-signing variables are set (${leaked.join(', ')}). The Store re-signs MSIX packages, and an MSIX signed with the installer's certificate does not match its Partner Center identity.`,
        'Unset them for the MSIX build. (To sideload-test, sign a separate copy with a test certificate whose subject equals RECOVERX_STORE_PUBLISHER — see docs/MICROSOFT-STORE.md.)',
      ),
    )
  }

  return { identityName, publisher, publisherDisplayName }
}

// --- Tools -------------------------------------------------------------------

function findSevenZip() {
  const candidates = [
    process.env.SEVEN_ZIP,
    '7z',
    join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
  ].filter((candidate) => candidate !== undefined && candidate.length > 0)

  // `7z i` lists the archive formats this build can read. The standalone 7za
  // that some tools bundle cannot open NSIS installers, so it is skipped.
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['i'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0 && /\bnsis\b/iu.test(probe.stdout)) return candidate
  }

  return null
}

/**
 * Get-AuthenticodeSignature for many files in one PowerShell process.
 *
 * Paths travel through a file rather than the command line, which has a length
 * limit and its own quoting rules, and the script travels as -EncodedCommand
 * for the same reason.
 */
function authenticode(files, scratch) {
  if (files.length === 0) return []

  const listFile = join(scratch, `authenticode-${String(Date.now())}.txt`)
  writeFileSync(listFile, files.join('\r\n'), 'utf8')

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rows = foreach ($line in (Get-Content -LiteralPath $env:STORE_VERIFY_LIST -Encoding UTF8)) {
  # [string]: Get-Content decorates each line with PSPath and friends, which
  # Windows PowerShell 5.1's ConvertTo-Json would otherwise serialise.
  $path = [string]$line
  if ([string]::IsNullOrWhiteSpace($path)) { continue }
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  $certificate = $signature.SignerCertificate
  [pscustomobject]@{
    path = $path
    status = [string]$signature.Status
    message = [string]$signature.StatusMessage
    signer = if ($certificate) { $certificate.Subject } else { $null }
    thumbprint = if ($certificate) { $certificate.Thumbprint } else { $null }
    timestamped = ($null -ne $signature.TimeStamperCertificate)
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
`
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, STORE_VERIFY_LIST: listFile },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  )

  if (result.status !== 0) {
    throw new Error(`Get-AuthenticodeSignature failed: ${result.stderr || result.stdout}`)
  }

  const parsed = JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, ''))
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** Is this file a Windows PE image ("MZ" header pointing at a "PE\0\0" signature)? */
function isPortableExecutable(file) {
  let descriptor
  try {
    descriptor = openSync(file, 'r')
    const header = Buffer.alloc(64)
    if (readSync(descriptor, header, 0, 64, 0) < 64 || header.toString('latin1', 0, 2) !== 'MZ') {
      return false
    }
    const offset = header.readUInt32LE(0x3c)
    const signature = Buffer.alloc(4)
    return (
      readSync(descriptor, signature, 0, 4, offset) === 4 &&
      signature.equals(Buffer.from('PE\0\0', 'latin1'))
    )
  } catch {
    return false
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// --- Signature verification --------------------------------------------------

/**
 * Extract the PE files an NSIS executable carries, with 7-Zip, into `into`.
 * Paths are flattened: NSIS keeps plug-ins in $PLUGINSDIR, and every name is
 * unique within one installer.
 */
function extractPortableExecutables(sevenZip, archive, into, what) {
  rmSync(into, { recursive: true, force: true })
  mkdirSync(into, { recursive: true })
  const result = spawnSync(sevenZip, ['e', '-y', `-o${into}`, archive, '*.exe', '*.dll', '-r'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0)
    throw new Error(`7-Zip could not read the ${what}: ${result.stdout}${result.stderr}`)
  return walk(into).filter(isPortableExecutable)
}

/**
 * Check every PE file the installer delivers.
 *
 * All required, because Store Policy 10.2.9 asks for the installer and *all*
 * of its PE files to be signed:
 *
 *  - everything in win-unpacked (by content, not just extension — a PE file
 *    with an unexpected extension still counts for the Store);
 *  - the installer;
 *  - the uninstaller. It exists only inside the installer — electron-builder
 *    builds and signs it, embeds it, and deletes the loose copy — so it is
 *    extracted back out with 7-Zip to be checked;
 *  - the NSIS plug-in DLLs embedded in the installer and, separately, in the
 *    uninstaller, which both unpack into %TEMP% while they run. electron-builder
 *    does not sign these; signNsisPlugins() does, before makensis embeds them.
 */
function verifySignatures({ unpackedDir, installer, scratch, mode }) {
  const required = walk(unpackedDir).filter(isPortableExecutable)
  if (installer !== null) required.push(installer)

  const notes = []
  const places = new Map()
  let uninstaller = null

  if (installer !== null) {
    const sevenZip = findSevenZip()
    if (sevenZip === null) {
      const message =
        'The uninstaller and NSIS plug-ins could not be checked: 7-Zip was not found (install it, e.g. `winget install 7zip.7zip`, or set SEVEN_ZIP to 7z.exe).'
      if (mode.strict) throw new Problem(message, 'Install 7-Zip and rerun.')
      notes.push(message)
    } else {
      const fromInstaller = extractPortableExecutables(
        sevenZip,
        installer,
        join(scratch, 'installer-contents'),
        'installer',
      )
      uninstaller = fromInstaller.find((file) => /uninstall/iu.test(basename(file))) ?? null
      if (uninstaller === null) {
        throw new Error(
          'No uninstaller was found inside the installer; electron-builder changed how it embeds it.',
        )
      }

      for (const file of fromInstaller) {
        required.push(file)
        places.set(file, file === uninstaller ? 'inside installer' : 'NSIS plug-in in installer')
      }
      for (const file of extractPortableExecutables(
        sevenZip,
        uninstaller,
        join(scratch, 'uninstaller-contents'),
        'uninstaller',
      )) {
        required.push(file)
        places.set(file, 'NSIS plug-in in uninstaller')
      }
    }
  }

  const rows = authenticode(required, scratch)
  const byPath = new Map(rows.map((row) => [row.path, row]))
  const label = (file) =>
    file.startsWith(unpackedDir)
      ? relative(unpackedDir, file)
      : file === installer
        ? `${basename(file)} (installer)`
        : `${basename(file)} (${places.get(file) ?? 'inside installer'})`

  const isMicrosoft = (row) =>
    row.status === 'Valid' && /O=Microsoft Corporation/u.test(row.signer ?? '')
  const failures = []
  const report = []
  const ourThumbprints = new Set()

  for (const file of required) {
    const row = byPath.get(file)
    const entry = { file: label(file), ...row, path: undefined, required: true }
    report.push(entry)

    if (isMicrosoft(row)) {
      entry.verdict = 'ok (Microsoft-signed, left as is)'
      continue
    }

    if (row.thumbprint !== null) ourThumbprints.add(row.thumbprint)

    const signed =
      row.status === 'Valid' ||
      (mode.allowUntrusted && ['UnknownError', 'NotTrusted'].includes(row.status))
    const timestamped = row.timestamped || mode.allowUntrusted

    if (signed && timestamped) {
      entry.verdict =
        row.status === 'Valid'
          ? 'ok'
          : `ok (untrusted chain accepted by --allow-untrusted-signatures)`
    } else {
      entry.verdict = !signed ? `FAIL: ${row.status}` : 'FAIL: not timestamped'
      failures.push(entry)
    }
  }

  if (ourThumbprints.size > 1) {
    failures.push({
      file: '(all)',
      verdict: `FAIL: files are signed by ${String(ourThumbprints.size)} different certificates (${[...ourThumbprints].join(', ')})`,
    })
  }

  return {
    report,
    failures,
    notes,
    thumbprints: [...ourThumbprints],
    installerSigner: installer === null ? null : (byPath.get(installer)?.signer ?? null),
  }
}

/**
 * Will electron-updater accept the next update signed like this release?
 *
 * Every installed copy checks a downloaded update with
 * windowsExecutableCodeSignatureVerifier: the installer's
 * SignerCertificate.Subject must match one of the publisherName entries in
 * resources\app-update.yml — the CN exactly, or every field of a full DN.
 * The release itself installs fine either way; it is the *next* one that is
 * refused ("not signed by the application owner"), on every machine, with no
 * way to push a fix through the updater. So the comparison is made here, with
 * electron-updater's own DN parser, against the signer Windows reports for
 * the installer just built.
 */
function checkUpdaterPublisher(unpackedDir, installerSigner) {
  const file = join(unpackedDir, 'resources', 'app-update.yml')
  if (!existsSync(file)) {
    return {
      ok: false,
      publisherNames: [],
      message: `${relative(ROOT, file)} is missing, so installed copies could not update at all.`,
    }
  }

  // Both from the dependency trees that use them: js-yaml as electron-builder
  // wrote the file, builder-util-runtime as electron-updater parses the DN.
  const { load } = createRequire(builderRequire().resolve('app-builder-lib/package.json'))(
    'js-yaml',
  )
  const { parseDn } = createRequire(require.resolve('electron-updater'))('builder-util-runtime')

  const configured = load(readFileSync(file, 'utf8'))?.publisherName
  const publisherNames = (Array.isArray(configured) ? configured : [configured])
    .filter((name) => typeof name === 'string' && name.trim().length > 0)
    .map(String)

  if (publisherNames.length === 0) {
    return {
      ok: false,
      publisherNames,
      message:
        'app-update.yml has no publisherName, so installed copies would accept an update signed by anyone.',
    }
  }
  if (installerSigner === null) {
    return { ok: false, publisherNames, message: 'the installer has no signer to compare with.' }
  }

  const subject = parseDn(installerSigner)
  const matches = publisherNames.some((name) => {
    const dn = parseDn(name)
    if (dn.size > 0) return [...dn.keys()].every((key) => dn.get(key) === subject.get(key))
    return name === subject.get('CN')
  })

  return {
    ok: matches,
    publisherNames,
    message: matches
      ? `app-update.yml publisherName ${JSON.stringify(publisherNames)} matches the signer`
      : `app-update.yml publisherName ${JSON.stringify(publisherNames)} does not match the installer's signer "${installerSigner}" (CN "${String(subject.get('CN'))}"). Every copy of this release would refuse every future update.`,
  }
}

// --- NSIS plug-ins -------------------------------------------------------------

/**
 * The NSIS plug-in DLLs electron-builder's assisted, per-machine installer and
 * its uninstaller embed (app-builder-lib 26.15.3 templates), found by
 * extracting a built installer. If a template change embeds another one, the
 * verification fails with it NotSigned: add its name here.
 *
 * An explicit list rather than every DLL in the plug-in folders, because each
 * name costs one signing operation — a PIN prompt on some tokens, a billed
 * signature on some cloud HSMs — and the folders hold about 25 DLLs that are
 * never used.
 */
const NSIS_PLUGINS = [
  'nsis7z.dll',
  'StdUtils.dll',
  'UAC.dll',
  'WinShell.dll',
  'System.dll',
  'nsDialogs.dll',
  'nsExec.dll',
]

/**
 * Sign the NSIS plug-ins before makensis embeds them in the installer and
 * uninstaller.
 *
 * electron-builder signs the app, the installer and the uninstaller, but the
 * plug-in DLLs come unsigned from its NSIS toolset, and Store Policy 10.2.9
 * wants every PE file in the installer signed. They are not signed in
 * electron-builder's download cache, which every other build shares: the two
 * folders makensis reads them from — the NSIS distribution (System, nsDialogs,
 * nsExec) and electron-builder's nsis-resources bundle (nsis7z, UAC, StdUtils,
 * WinShell) — are copied into `workDir`, the copies are signed, and
 * electron-builder is pointed at them through its documented overrides,
 * ELECTRON_BUILDER_NSIS_DIR and ELECTRON_BUILDER_NSIS_RESOURCES_DIR.
 *
 * Runs as electron-builder's afterSign hook: after the app is signed (so the
 * signing configuration is resolved and has just worked) and before the NSIS
 * target resolves its toolset paths. Signing goes through electron-builder's
 * own signWindows(), so the certificate, hook, timestamp server and hash are
 * exactly those of every other file. Returns the overrides to restore.
 */
async function signNsisPlugins(context, workDir) {
  const toolsets = builderRequire()('app-builder-lib/out/toolsets/windows.js')
  const { signWindows } = builderRequire()('app-builder-lib/out/codeSign/windowsCodeSign.js')
  if (
    typeof toolsets.getMakeNsisPath !== 'function' ||
    typeof toolsets.getNsisPluginsPath !== 'function' ||
    typeof signWindows !== 'function'
  ) {
    throw new Problem(
      'This electron-builder no longer exposes the NSIS toolset and signing functions package-store.mjs uses to sign the NSIS plug-ins.',
      'Update signNsisPlugins() in scripts/package-store.mjs for the installed app-builder-lib.',
    )
  }

  const { packager } = context
  const nsisVersion = packager.config.toolsets?.nsis
  const nsis = packager.config.nsis ?? {}
  const pluginArch = nsis.unicode === false ? 'x86-ansi' : 'x86-unicode'

  const makensis = await toolsets.getMakeNsisPath(nsisVersion, nsis.customNsisBinary)
  const nsisDir = makensis.env?.NSISDIR
  if (nsisDir === undefined || !existsSync(join(nsisDir, 'Plugins', pluginArch))) {
    throw new Problem(
      `The NSIS toolset at ${makensis.path} does not have the legacy layout (NSISDIR\\Plugins\\${pluginArch}) package-store.mjs knows how to sign.`,
      'Remove toolsets.nsis from electron-builder.yml, or update signNsisPlugins() in scripts/package-store.mjs.',
    )
  }
  const resourcesPlugins = await toolsets.getNsisPluginsPath(nsisVersion, nsis.customNsisResources)

  const nsisCopy = join(workDir, 'nsis')
  const resourcesCopy = join(workDir, 'nsis-resources')
  rmSync(workDir, { recursive: true, force: true })
  cpSync(nsisDir, nsisCopy, { recursive: true })
  cpSync(join(resourcesPlugins, pluginArch), join(resourcesCopy, 'plugins', pluginArch), {
    recursive: true,
  })

  const folders = [
    join(nsisCopy, 'Plugins', pluginArch),
    join(resourcesCopy, 'plugins', pluginArch),
  ]
  for (const name of NSIS_PLUGINS) {
    const copies = folders.map((folder) => join(folder, name)).filter((file) => existsSync(file))
    if (copies.length === 0) {
      throw new Problem(
        `NSIS plug-in ${name} is in neither the NSIS distribution nor electron-builder's nsis-resources.`,
        'Update NSIS_PLUGINS in scripts/package-store.mjs for the installed electron-builder.',
      )
    }
    for (const file of copies) {
      const signed = await signWindows(
        { path: file, options: packager.platformSpecificBuildOptions },
        packager,
      )
      if (!signed) throw new Problem(`NSIS plug-in ${file} was not signed.`)
    }
  }

  const previous = {
    ELECTRON_BUILDER_NSIS_DIR: process.env.ELECTRON_BUILDER_NSIS_DIR,
    ELECTRON_BUILDER_NSIS_RESOURCES_DIR: process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR,
  }
  process.env.ELECTRON_BUILDER_NSIS_DIR = nsisCopy
  process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = resourcesCopy
  say(`  NSIS plug-ins signed: ${NSIS_PLUGINS.join(', ')}`)
  return previous
}

function printSignatureReport({ report, notes }) {
  const width = Math.min(60, Math.max(...report.map((entry) => entry.file.length)))
  for (const entry of report) {
    const signer =
      entry.signer === null || entry.signer === undefined
        ? ''
        : `  ${(/CN=([^,]+)/u.exec(entry.signer) ?? [])[1] ?? entry.signer}`
    say(
      `  ${entry.file.padEnd(width)}  ${entry.status.padEnd(13)} ${entry.timestamped ? 'ts' : '  '}  ${entry.verdict}${signer}`,
    )
  }
  for (const note of notes) say(`  note: ${note}`)
}

// --- Staging -------------------------------------------------------------------

function stageExe({
  installer,
  version,
  outDir,
  labels,
  signatures,
  updaterPublisherNames,
  signingDescription,
}) {
  const storeDir = join(outDir, 'store')
  rmSync(storeDir, { recursive: true, force: true })
  mkdirSync(storeDir, { recursive: true })

  const suffix = labels.length > 0 ? `-${NOT_FOR_SUBMISSION}` : ''
  const fileName = `RecoverX-Setup-${version}-x64${suffix}.exe`
  const target = join(storeDir, fileName)
  copyFileSync(installer, target)

  const hash = sha256(target)
  const bytes = statSync(target).size
  writeFileSync(`${target}.sha256`, `${hash} *${fileName}\n`)

  const base = (process.env.RECOVERX_STORE_DOWNLOAD_BASE?.trim() || DEFAULT_DOWNLOAD_BASE).replace(
    /\/+$/u,
    '',
  )
  if (!base.startsWith('https://')) {
    throw new Problem(
      `RECOVERX_STORE_DOWNLOAD_BASE must be an https:// URL (got ${base}).`,
      'The Store only accepts HTTPS package URLs.',
    )
  }
  const packageUrl = `${base}/${version}/${fileName}`

  const signers = signatures.report.filter(
    (entry) => entry.required && !/Microsoft/u.test(entry.verdict),
  )
  const submission = {
    product: 'RecoverX',
    route: 'Microsoft Store — MSI/EXE app (Store Policy 10.2.9)',
    version,
    notForSubmission: labels.length > 0,
    notForSubmissionReasons: labels,
    generatedAt: new Date().toISOString(),
    package: {
      url: packageUrl,
      appType: 'EXE',
      architecture: 'x64',
      languages: ['en-us'],
      installerParameters: SILENT_SWITCH,
      returnCodes: RETURN_CODES,
    },
    installer: { file: fileName, bytes, sha256: hash },
    signing: {
      configuredWith: signingDescription,
      thumbprints: signatures.thumbprints,
      signer: signers[0]?.signer ?? null,
      updaterPublisherNames,
      filesChecked: signatures.report.filter((entry) => entry.required).length,
    },
    reminders: [
      `Upload ${fileName} to exactly ${packageUrl} before submitting, and check it downloads (HTTP 200, ${String(bytes)} bytes, SHA-256 ${hash}).`,
      'Never replace or delete the file at a URL that has been submitted. Every release gets a new versioned URL; Partner Center and customers mid-install may still fetch the old one.',
      'The electron-updater feed (latest.yml + installer + blockmap under https://recoverx.snapkio.com/updates/win/latest/) is published separately, as before; existing users update through it.',
    ],
  }

  writeFileSync(join(storeDir, 'submission.json'), `${JSON.stringify(submission, null, 2)}\n`)
  writeFileSync(
    join(storeDir, 'signature-report.json'),
    `${JSON.stringify(signatures.report, null, 2)}\n`,
  )
  writeFileSync(join(storeDir, 'submission.md'), submissionMarkdown(submission))

  return { storeDir, target, packageUrl, hash, bytes }
}

function submissionMarkdown(submission) {
  const warning = submission.notForSubmission
    ? `> **${NOT_FOR_SUBMISSION}.** This build is a pipeline test: ${submission.notForSubmissionReasons.join('; ')}. Do not upload it to Partner Center.\n\n`
    : ''

  return `# RecoverX ${submission.version} — Partner Center submission

${warning}Generated ${submission.generatedAt} by \`scripts/package-store.mjs\`. The full runbook is
docs/MICROSOFT-STORE.md; this file is only what this build needs.

## 1. Host the installer

Upload \`${submission.installer.file}\` to:

\`\`\`
${submission.package.url}
\`\`\`

| | |
| --- | --- |
| Size | ${String(submission.installer.bytes)} bytes |
| SHA-256 | \`${submission.installer.sha256}\` |

Check before submitting: \`curl -sSfI ${submission.package.url}\` must return 200 over HTTPS, with no
redirect to HTTP and no login. **Never change or delete a file at a URL you have submitted** — the
next release gets its own versioned folder.

## 2. Partner Center → Packages

| Field | Value |
| --- | --- |
| Package URL | \`${submission.package.url}\` |
| App type | ${submission.package.appType} |
| Architecture | ${submission.package.architecture} |
| Languages | English (United States) — \`en-us\` |
| Installer parameters | \`${submission.package.installerParameters}\` |

Installer return codes (add each row; 0 is the success code):

| Return code | Scenario | What it means for RecoverX |
| --- | --- | --- |
${submission.package.returnCodes.map((row) => `| ${String(row.code)} | ${row.scenario} | ${row.meaning} |`).join('\n')}

## 3. Signing evidence

Configured with: ${submission.signing.configuredWith}.
Signer: ${submission.signing.signer ?? '(unsigned)'}.
electron-updater publisher check: ${submission.signing.updaterPublisherNames.length > 0 ? `\`${submission.signing.updaterPublisherNames.join('`, `')}\` (matches the signer)` : '(none — unsigned build)'}.
${String(submission.signing.filesChecked)} required PE files — the app, the installer, the uninstaller and the NSIS
plug-ins inside both — checked with Get-AuthenticodeSignature; see \`signature-report.json\`.

## Reminders

${submission.reminders.map((line) => `- ${line}`).join('\n')}
`
}

function stageMsix({ appx, version, outDir, labels, identity, manifest }) {
  const storeDir = join(outDir, 'store')
  rmSync(storeDir, { recursive: true, force: true })
  mkdirSync(storeDir, { recursive: true })

  const suffix = labels.length > 0 ? `-${NOT_FOR_SUBMISSION}` : ''
  const fileName = basename(appx).replace(/\.appx$/u, `${suffix}.appx`)
  const target = join(storeDir, fileName)
  copyFileSync(appx, target)

  const hash = sha256(target)
  writeFileSync(`${target}.sha256`, `${hash} *${fileName}\n`)

  const summary = {
    product: 'RecoverX',
    route: 'Microsoft Store — MSIX (optional; requires allowElevation pre-approval)',
    version,
    notForSubmission: labels.length > 0,
    notForSubmissionReasons: labels,
    generatedAt: new Date().toISOString(),
    package: { file: fileName, bytes: statSync(target).size, sha256: hash },
    identity,
    manifest,
  }
  writeFileSync(join(storeDir, 'submission-msix.json'), `${JSON.stringify(summary, null, 2)}\n`)

  return { storeDir, target }
}

/** Read AppxManifest.xml and the file list back out of the built package. */
function inspectAppx(appx, scratch) {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($env:STORE_APPX)
try {
  $entry = $zip.GetEntry('AppxManifest.xml')
  $reader = New-Object System.IO.StreamReader($entry.Open())
  $manifest = $reader.ReadToEnd()
  $reader.Close()
  $names = @($zip.Entries | ForEach-Object { $_.FullName })
} finally { $zip.Dispose() }
$signature = Get-AuthenticodeSignature -LiteralPath $env:STORE_APPX
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ manifest = $manifest; entries = $names; signature = [string]$signature.Status })
`
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, STORE_APPX: appx },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      cwd: scratch,
    },
  )
  if (result.status !== 0)
    throw new Error(`Could not read the package: ${result.stderr || result.stdout}`)

  const parsed = JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, ''))
  const attribute = (element, name) =>
    (new RegExp(`<${element}\\b[^>]*\\s${name}=["']([^"']*)["']`, 'u').exec(parsed.manifest) ??
      [])[1] ?? null

  return {
    identityName: attribute('Identity', 'Name'),
    publisher: attribute('Identity', 'Publisher'),
    version: attribute('Identity', 'Version'),
    applicationId: attribute('Application', 'Id'),
    minVersion: attribute('TargetDeviceFamily', 'MinVersion'),
    maxVersionTested: attribute('TargetDeviceFamily', 'MaxVersionTested'),
    capabilities: [...parsed.manifest.matchAll(/<(?:rescap:)?Capability\s+Name="([^"]+)"/gu)].map(
      (match) => match[1],
    ),
    hasUpdaterConfig: parsed.entries.some((name) => /app-update\.yml$/iu.test(name)),
    hasElevateHelper: parsed.entries.some((name) => /elevate\.exe$/iu.test(name)),
    assets: parsed.entries.filter((name) => /^assets\//iu.test(name)).length,
    hasResourcesPri: parsed.entries.some((name) => /^resources.*\.pri$/iu.test(name)),
    signature: parsed.signature,
  }
}

// --- Main ----------------------------------------------------------------------

async function main() {
  const options = parseCommandLine()
  if (options.help) {
    say(HELP)
    return
  }

  if (process.platform !== 'win32') {
    throw new Problem(
      'The Store pipeline runs on Windows only.',
      'signtool, makeappx and Get-AuthenticodeSignature are Windows tools; use a Windows machine or the CI windows-latest runner.',
    )
  }

  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const version = options['override-version']?.trim() || packageJson.version
  const msix = options.msix

  const labels = []
  if (options.unsigned && !msix) labels.push('built with --unsigned')
  if (options['allow-unlicensed']) labels.push('licensing checks bypassed with --allow-unlicensed')
  if (options['allow-untrusted-signatures'])
    labels.push('untrusted/untimestamped signatures accepted with --allow-untrusted-signatures')
  if (options['override-version'] !== undefined)
    labels.push(
      `version overridden to ${version} with --override-version (package.json says ${packageJson.version})`,
    )

  const outDir = resolve(
    options.out ??
      join(ROOT, 'release', labels.length > 0 ? `${version}-${NOT_FOR_SUBMISSION}` : version),
  )

  heading(
    `RecoverX ${version} — Microsoft Store ${msix ? 'MSIX (optional route)' : 'EXE (MSI/EXE route)'}`,
  )
  say(`  output              ${outDir}`)
  if (labels.length > 0) {
    say('')
    say(`  *** ${NOT_FOR_SUBMISSION} ***`)
    for (const label of labels) say(`  - ${label}`)
  }

  // --- Preflight -------------------------------------------------------------
  heading('Preflight')
  const problems = []
  const warnings = []

  for (const file of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    if (!existsSync(join(ROOT, file))) {
      problems.push(
        new Problem(
          `${file} is missing.`,
          'Run `npm run build` first — `npm run package:store` does it for you.',
        ),
      )
    }
  }
  for (const asset of msix
    ? ['build/icon.ico', 'build/appx/StoreLogo.scale-100.png']
    : ['build/icon.ico']) {
    if (!existsSync(join(ROOT, asset))) {
      problems.push(
        new Problem(
          `${asset} is missing.`,
          'Run `npm run icon` — `npm run package:store` does it for you.',
        ),
      )
    }
  }

  if (problems.length === 0) {
    const licensing = []
    checkLicensing(licensing, warnings)
    if (options['allow-unlicensed']) {
      for (const problem of licensing) warnings.push(`(--allow-unlicensed) ${problem.message}`)
    } else {
      problems.push(...licensing)
    }
  }

  checkVersion(version, msix, problems)

  let signing = null
  let identity = null
  if (msix) {
    identity = msixIdentity(problems)
  } else if (options.unsigned) {
    warnings.push('--unsigned: nothing will be signed; the signature report is informational.')
  } else {
    signing = signingConfiguration(problems, warnings)
    if (signing !== null) say(`  signing             ${signing.description}`)

    // The NSIS plug-ins are signed from an afterSign hook this script installs
    // (signNsisPlugins). A hook in electron-builder.yml would be silently
    // replaced by it, so one there is refused rather than lost.
    if (/^afterSign\s*:/mu.test(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'))) {
      problems.push(
        new Problem(
          'electron-builder.yml defines afterSign, which package-store.mjs replaces with its own hook (signing the NSIS plug-ins).',
          'Call your hook from signNsisPlugins() in scripts/package-store.mjs instead.',
        ),
      )
    }
  }

  if (!msix && !options.unsigned && findSevenZip() === null) {
    problems.push(
      new Problem(
        '7-Zip was not found. It is needed to extract the uninstaller from the installer and check its signature.',
        'Install 7-Zip (`winget install 7zip.7zip`) or set SEVEN_ZIP to the full path of 7z.exe.',
      ),
    )
  }

  for (const warning of warnings) say(`  warning: ${warning}`)

  if (problems.length > 0) {
    say('')
    for (const problem of problems) {
      say(`  ✗ ${problem.message}`)
      if (problem.fix) say(`      → ${problem.fix}`)
    }
    say('')
    throw new Problem(
      `Preflight failed with ${String(problems.length)} problem(s); nothing was built.`,
    )
  }
  say('  preflight passed')

  if (msix) {
    say('')
    say('  !! allowElevation is a RESTRICTED capability. Justify it (and runFullTrust) in')
    say('  !! Partner Center under Submission options → Restricted capabilities; certification')
    say('  !! reviews it and fails the submission if it is refused (docs/MICROSOFT-STORE.md §11).')
  }

  // --- Build -----------------------------------------------------------------
  heading('electron-builder')
  const { build, Platform, Arch } = require('electron-builder')

  const scratch = mkdtempSync(join(tmpdir(), 'recoverx-store-'))
  // The NSIS toolset overrides signNsisPlugins() sets for this build, put back
  // afterwards whatever happens.
  let toolsetOverrides = null
  try {
    const config = {
      directories: { output: outDir },
      ...(options['override-version'] !== undefined ? { extraMetadata: { version } } : {}),
    }

    if (msix) {
      Object.assign(config, {
        // A path containing "." is taken by electron-builder as the config file
        // to load in place of electron-builder.yml; that file extends the base.
        extends: './electron-builder.msix.yml',
        forceCodeSigning: false,
        appx: {
          identityName: identity.identityName,
          publisher: identity.publisher,
          publisherDisplayName: identity.publisherDisplayName,
        },
      })
    } else if (options.unsigned) {
      Object.assign(config, { forceCodeSigning: false, win: { signExecutable: false } })
    } else {
      Object.assign(config, {
        forceCodeSigning: true,
        win: signing.win,
        afterSign: async (context) => {
          toolsetOverrides = await signNsisPlugins(context, join(scratch, 'nsis-toolset'))
        },
      })
    }

    const artifacts = await build({
      projectDir: ROOT,
      targets: Platform.WINDOWS.createTarget(msix ? 'appx' : 'nsis', Arch.x64),
      publish: 'never',
      config,
    }).catch((error) => {
      // makeappx.exe from electron-builder's tool bundles loads its packaging
      // DLLs as side-by-side private assemblies. Where Windows refuses that
      // activation context (seen on a Windows 11 Insider build, 10.0.26300),
      // Node reports only "spawn UNKNOWN"; the Application event log has the
      // real reason. An installed Windows SDK's makeappx works around it.
      if (msix && /spawn UNKNOWN/u.test(String(error?.message))) {
        throw new Problem(
          `makeappx.exe could not be started (${String(error.message)}). This is usually a side-by-side configuration error — see Event Viewer → Windows Logs → Application, source SideBySide.`,
          'Install the Windows SDK and set ELECTRON_BUILDER_WINDOWS_KITS_PATH to its bin\\<version>\\x64 folder (the one containing makeappx.exe, makepri.exe and signtool.exe), or build on another Windows 10/11 machine or the CI runner.',
        )
      }
      throw error
    })

    if (msix) {
      const appx = artifacts.find((file) => file.endsWith('.appx'))
      if (appx === undefined)
        throw new Error(`electron-builder produced no .appx (${artifacts.join(', ')})`)

      heading('Package check')
      const manifest = inspectAppx(appx, scratch)
      for (const [key, value] of Object.entries(manifest))
        say(`  ${key.padEnd(18)}  ${JSON.stringify(value)}`)

      const failures = []
      if (manifest.identityName !== identity.identityName)
        failures.push('Identity Name does not match RECOVERX_STORE_IDENTITY_NAME')
      if (manifest.publisher !== identity.publisher)
        failures.push('Identity Publisher does not match RECOVERX_STORE_PUBLISHER')
      if (
        !manifest.capabilities.includes('allowElevation') ||
        !manifest.capabilities.includes('runFullTrust')
      ) {
        failures.push('the manifest lacks runFullTrust or allowElevation')
      }
      if (manifest.hasUpdaterConfig)
        failures.push('app-update.yml leaked into the package (electron-updater would run)')
      if (!manifest.hasResourcesPri)
        failures.push(
          'no resources.pri: the build/appx tile set was not used (SampleAppx placeholders?)',
        )
      if (manifest.signature !== 'NotSigned')
        failures.push(`the package is signed (${manifest.signature}); the Store expects to sign it`)
      if (failures.length > 0)
        throw new Problem(`The MSIX package is not right: ${failures.join('; ')}.`)
      if (manifest.hasElevateHelper)
        say(
          '  note: resources\\elevate.exe is present (copied by electron-builder; unused in MSIX)',
        )

      const staged = stageMsix({ appx, version, outDir, labels, identity, manifest })
      heading(labels.length > 0 ? NOT_FOR_SUBMISSION : 'Ready for Partner Center (MSIX)')
      say(`  package   ${staged.target}`)
      say(`  details   ${join(staged.storeDir, 'submission-msix.json')}`)
      say(
        '  Upload the .appx under Packages; justify runFullTrust and allowElevation under Submission options.',
      )
      return
    }

    const installer = artifacts.find((file) => file.endsWith('.exe'))
    if (installer === undefined)
      throw new Error(`electron-builder produced no installer (${artifacts.join(', ')})`)

    heading('Authenticode verification')
    const signatures = verifySignatures({
      unpackedDir: join(outDir, 'win-unpacked'),
      installer,
      scratch,
      mode: { strict: !options.unsigned, allowUntrusted: options['allow-untrusted-signatures'] },
    })
    printSignatureReport(signatures)

    if (signatures.failures.length > 0) {
      if (options.unsigned) {
        say(`  ${String(signatures.failures.length)} file(s) unsigned — expected with --unsigned.`)
      } else {
        throw new Problem(
          `${String(signatures.failures.length)} PE file(s) failed verification: ${signatures.failures.map((entry) => entry.file).join(', ')}.`,
          'A NotSigned DLL in the app usually means a new Electron release added one: add its name to win.signExts in electron-builder.yml. A NotSigned NSIS plug-in means electron-builder now embeds another one: add it to NSIS_PLUGINS in scripts/package-store.mjs.',
        )
      }
    } else {
      say(
        `  all ${String(signatures.report.filter((entry) => entry.required).length)} required PE files pass`,
      )
    }

    heading('Update signature check')
    let updaterPublisher = null
    if (options.unsigned) {
      say('  skipped: an --unsigned build has no signer for electron-updater to compare with')
    } else {
      updaterPublisher = checkUpdaterPublisher(
        join(outDir, 'win-unpacked'),
        signatures.installerSigner,
      )
      say(`  ${updaterPublisher.ok ? 'ok' : 'FAIL'}: ${updaterPublisher.message}`)
      if (!updaterPublisher.ok) {
        throw new Problem(
          `electron-updater's publisher check would fail: ${updaterPublisher.message}`,
          signing?.description.startsWith('signing hook') === true
            ? "Set WIN_PUBLISHER_NAME to the signer's CN exactly as shown above (or its full DN) and rebuild."
            : 'Report this: for this signing mechanism electron-builder derives the name from the certificate.',
        )
      }
    }

    heading('Staging')
    const staged = stageExe({
      installer,
      version,
      outDir,
      labels,
      signatures,
      updaterPublisherNames: updaterPublisher?.publisherNames ?? [],
      signingDescription: signing?.description ?? 'nothing (--unsigned)',
    })
    say(`  installer  ${staged.target}`)
    say(`  sha256     ${staged.hash}`)
    say(`  host at    ${staged.packageUrl}`)
    say(`  paste      ${join(staged.storeDir, 'submission.md')}`)

    heading(labels.length > 0 ? `${NOT_FOR_SUBMISSION}` : 'Ready for Partner Center')
    if (labels.length > 0) {
      for (const label of labels) say(`  - ${label}`)
    } else {
      say(
        '  Smoke-test the installer silently on a clean VM (setup /S, then uninstall /S), host it at the',
      )
      say('  URL above, and follow docs/MICROSOFT-STORE.md from "Partner Center".')
    }
  } finally {
    if (toolsetOverrides !== null) {
      for (const [name, value] of Object.entries(toolsetOverrides)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  say('')
  if (error instanceof Problem) {
    process.stderr.write(`package-store: ${error.message}\n`)
    if (error.fix) process.stderr.write(`  → ${error.fix}\n`)
  } else {
    process.stderr.write(`package-store: ${error.stack ?? String(error)}\n`)
  }
  // Also re-asserted on exit: electron-builder's own temp-directory clean-up
  // runs from exit handlers, and a failed release must never reach CI as a
  // success (electron-builder's CLI guards its exit code the same way).
  process.exitCode = 1
  process.once('exit', () => {
    process.exitCode = 1
  })
})

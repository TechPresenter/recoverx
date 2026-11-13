#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron as electron } from '@playwright/test'

/**
 * Capture Microsoft Store listing screenshots from the built application.
 *
 *   npm run build
 *   npm run store:screenshots [-- --out <dir>] [--theme dark] [--routes dashboard,scan]
 *
 * Launches the compiled bundle in out/ exactly the way the end-to-end suite
 * does (tests/e2e/application.e2e.ts): Playwright's Electron launcher, project
 * root as the app, and a throwaway user-data directory in the OS temp folder so
 * the shots never show — or touch — an installed copy's settings, history or
 * licence. The window's content area is sized to 1920×1080, every main screen
 * is visited through the hash router, and each is saved as a PNG.
 *
 * Partner Center accepts PNG screenshots of 1366×768 or larger (up to 10; 4–8
 * recommended) and shows them in the order uploaded, which is the order here.
 *
 * What it cannot do is make the screens interesting. A fresh profile has no
 * scan results and no history, and an unelevated process sees no raw devices.
 * For the listing, run this from an elevated terminal on a machine with a
 * spare USB stick attached, and capture a scan in progress and its results by
 * hand (docs/store/listing.en-US.md lists the captions). The script warns when
 * it is not elevated.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Screens worth showing in a listing, in display order, by route-table name.
 * Logs is left out on purpose: even a throwaway profile's log lines carry
 * machine paths, and a log viewer sells nothing.
 */
const DEFAULT_ROUTES = [
  'Dashboard',
  'Scan',
  'Devices',
  'Partitions',
  'Health',
  'History',
  'License',
  'Settings',
  'About',
]

const HELP = `Capture Microsoft Store screenshots from the built app (run \`npm run build\` first).

Usage:
  npm run store:screenshots [-- options]

Options:
  --out <dir>        Where to write the PNGs. Default: release/store-listing/screenshots
  --routes <list>    Comma-separated route names from src/shared/constants/routes.ts
                     (case-insensitive). Default: ${DEFAULT_ROUTES.join(',')}
  --theme <mode>     light | dark | system. Default: leave the app default (system).
  --width <px>       Content width. Default 1920.
  --height <px>      Content height. Default 1080.
  --settle <ms>      Time to let each screen load its data. Default 2500.
  --help             Show this help.
`

function parseCommandLine() {
  try {
    const { values } = parseArgs({
      options: {
        out: { type: 'string' },
        routes: { type: 'string' },
        theme: { type: 'string' },
        width: { type: 'string', default: '1920' },
        height: { type: 'string', default: '1080' },
        settle: { type: 'string', default: '2500' },
        help: { type: 'boolean', short: 'h', default: false },
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

function say(line = '') {
  process.stdout.write(`${line}\n`)
}

/**
 * The route table, read from its single source of truth.
 *
 * Parsed as text rather than imported: the file is TypeScript, and loading it
 * would tie this script to a TypeScript loader for the sake of ten strings.
 */
function readRouteTable() {
  const source = readFileSync(join(ROOT, 'src', 'shared', 'constants', 'routes.ts'), 'utf8')
  const block = /export const AppRoute = \{([\s\S]*?)\} as const/u.exec(source)
  if (block === null) throw new Error('Could not find AppRoute in src/shared/constants/routes.ts')

  const routes = new Map()
  for (const match of block[1].matchAll(/(\w+):\s*'([^']+)'/gu)) routes.set(match[1], match[2])
  return routes
}

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`--${name} must be a positive integer`)
  return parsed
}

async function main() {
  const options = parseCommandLine()
  if (options.help) {
    say(HELP)
    return
  }

  const width = positiveInteger(options.width, 'width')
  const height = positiveInteger(options.height, 'height')
  const settle = positiveInteger(options.settle, 'settle')
  if (width < 1366 || height < 768) {
    say(`warning: ${String(width)}×${String(height)} is below the Store's 1366×768 minimum.`)
  }

  const table = readRouteTable()
  const byLowerName = new Map(
    [...table].map(([name, path]) => [name.toLowerCase(), { name, path }]),
  )
  const wanted = (options.routes?.split(',') ?? DEFAULT_ROUTES)
    .map((name) => name.trim())
    .filter(Boolean)
  const routes = wanted.map((name) => {
    const route = byLowerName.get(name.toLowerCase())
    if (route === undefined) {
      throw new Error(`Unknown route "${name}". Known: ${[...table.keys()].join(', ')}`)
    }
    return route
  })

  if (options.theme !== undefined && !['light', 'dark', 'system'].includes(options.theme)) {
    throw new Error('--theme must be light, dark or system')
  }

  const bundle = join(ROOT, 'out', 'main', 'index.js')
  try {
    statSync(bundle)
  } catch {
    throw new Error('out/main/index.js is missing. Run `npm run build` first.')
  }

  const outDir = resolve(options.out ?? join(ROOT, 'release', 'store-listing', 'screenshots'))
  mkdirSync(outDir, { recursive: true })

  const userDataDir = mkdtempSync(join(tmpdir(), 'recoverx-screens-'))
  say(`App:        ${bundle}`)
  say(`User data:  ${userDataDir} (throwaway)`)
  say(`Output:     ${outDir}`)

  const app = await electron.launch({
    // Device scale factor 1, so a 1920×1080 content area is a 1920×1080 PNG on
    // a laptop running at 125% or 150% as well.
    args: ['--force-device-scale-factor=1', '.'],
    cwd: ROOT,
    env: {
      ...process.env,
      RECOVERX_USER_DATA_DIR: userDataDir,
      RECOVERX_LOG_LEVEL: 'warn',
      RECOVERX_OPEN_DEVTOOLS: 'false',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page
      .getByRole('heading', { level: 1 })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })

    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window === undefined) return
        if (window.isMaximized()) window.unmaximize()
        window.setContentSize(size.width, size.height)
        window.center()
      },
      { width, height },
    )

    // Windows keeps a window inside the desktop's work area, so on a 1080p
    // screen the window above ends up a taskbar short of 1080. Emulating the
    // viewport gives the renderer the exact size regardless; the title bar is
    // part of the page, so the shot looks the same as a real window.
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(500)

    const bridge = async (channel, payload) =>
      page.evaluate(
        async ([name, body]) => {
          const api = globalThis.recoverx
          return api === undefined ? { ok: false } : api.invoke(name, body)
        },
        [channel, payload],
      )

    if (options.theme !== undefined) {
      const result = await bridge('settings:update', { patch: { theme: options.theme } })
      if (result?.ok !== true) say(`warning: could not switch the theme to ${options.theme}`)
    }

    const snapshot = await bridge('system:get-snapshot', undefined)
    if (snapshot?.ok === true && snapshot.data?.isElevated === false) {
      say('')
      say('warning: not running as Administrator. Devices, Scan, Partitions and Health will show')
      say('         their "Administrator rights are required" state. For listing screenshots, run')
      say('         this from an elevated terminal.')
    }

    say('')
    let index = 0
    for (const route of routes) {
      index += 1
      await page.evaluate((path) => {
        window.location.hash = `#${path}`
      }, route.path)

      await page
        .getByRole('heading', { level: 1 })
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await page.waitForTimeout(settle)

      // Then wait out loading placeholders. Device enumeration and SMART
      // queries go through PowerShell and can take several seconds; a listing
      // screenshot of grey skeleton bars sells nothing. The classes are the
      // ones Skeleton.tsx and Spinner.tsx render.
      const loaded = await page
        .waitForFunction(
          () => document.querySelector('.animate-shimmer, .animate-spin') === null,
          undefined,
          {
            timeout: 30_000,
          },
        )
        .then(() => true)
        .catch(() => false)
      if (loaded) await page.waitForTimeout(300)
      // Park the pointer in a corner so no hover state is captured.
      await page.mouse.move(width - 1, height - 1)

      const text = await page.evaluate(() => document.body.innerText.trim().length)
      const file = join(outDir, `${String(index).padStart(2, '0')}-${route.name.toLowerCase()}.png`)
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' })

      // Read the size back from the PNG header rather than trusting the request.
      const header = readFileSync(file).subarray(16, 24)
      const shot = { width: header.readUInt32BE(0), height: header.readUInt32BE(4) }
      const problems = []
      if (!loaded) problems.push('still loading after 30 s')
      if (text < 40) problems.push('looks empty')
      if (shot.width !== width || shot.height !== height) problems.push('wrong size')

      const bytes = statSync(file).size
      say(
        `${file}  ${String(shot.width)}×${String(shot.height)}, ${(bytes / 1024).toFixed(0)} KB${problems.length > 0 ? `  ← ${problems.join(', ')}: check it` : ''}`,
      )
    }
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }

  say('')
  say('Done. Review every image before uploading: the Store rejects screenshots that')
  say('misrepresent the product (Store Policy 10.1.1).')
}

main().catch((error) => {
  process.stderr.write(`store-screenshots: ${error.stack ?? String(error)}\n`)
  process.exitCode = 1
})

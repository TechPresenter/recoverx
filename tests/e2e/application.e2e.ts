import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

/**
 * End-to-end coverage against a real Electron runtime.
 *
 * This is the only suite where the whole stack runs together: the `app://`
 * protocol handler, session hardening, the preload bridge, the IPC registry and
 * a real SQLite file. It is therefore where the Electron-coupled modules that
 * the unit suite cannot import are actually verified.
 *
 * Requires `npm run build` first — the specs drive the compiled bundle in `out/`,
 * not the source.
 */

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'recoverx-e2e-'))

  app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Keeps the suite off an installed copy's database and log directory.
      RECOVERX_USER_DATA_DIR: userDataDir,
      RECOVERX_LOG_LEVEL: 'debug',
      RECOVERX_OPEN_DEVTOOLS: 'false',
    },
  })

  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
})

test('creates its database and applies migrations on first run', async () => {
  // The dashboard only renders once settings have loaded, which requires the
  // database to be open and migrated.
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()

  expect(existsSync(join(userDataDir, 'recoverx.db'))).toBe(true)
  expect(existsSync(join(userDataDir, 'logs'))).toBe(true)
})

test('renders the custom window chrome', async () => {
  await expect(page.getByText('RecoverX').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Minimise' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible()
})

test('exposes only the two bridge functions to the renderer', async () => {
  const surface = await page.evaluate(() => {
    const bridge = (globalThis as unknown as { recoverx?: object }).recoverx
    return {
      keys: bridge === undefined ? [] : Object.keys(bridge).sort(),
      hasRequire: 'require' in globalThis,
      hasProcess: 'process' in globalThis,
    }
  })

  expect(surface.keys).toEqual(['invoke', 'subscribe'])
  // Context isolation and sandboxing must leave no Node surface behind.
  expect(surface.hasRequire).toBe(false)
  expect(surface.hasProcess).toBe(false)
})

test('rejects an IPC call on an undeclared channel', async () => {
  const result = await page.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        recoverx: { invoke: (channel: string, payload: unknown) => Promise<{ ok: boolean }> }
      }
    ).recoverx

    return bridge.invoke('app:definitely-not-a-channel', undefined)
  })

  expect(result.ok).toBe(false)
})

test('rejects a malformed payload on a declared channel', async () => {
  const result = await page.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        recoverx: {
          invoke: (
            channel: string,
            payload: unknown,
          ) => Promise<{ ok: boolean; error?: { code: string } }>
        }
      }
    ).recoverx

    return bridge.invoke('settings:update', { patch: { theme: 'neon' } })
  })

  expect(result.ok).toBe(false)
  expect(result.error?.code).toBe('VALIDATION')
})

test('persists a settings change across a reload', async () => {
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

  const motion = page.getByRole('switch', { name: 'Reduce motion' })
  await expect(motion).not.toBeChecked()

  await motion.click()
  await expect(motion).toBeChecked()

  // A reload rebuilds the renderer from scratch; the value can only survive if
  // it reached SQLite.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: 'Settings' }).click()

  await expect(page.getByRole('switch', { name: 'Reduce motion' })).toBeChecked()
})

test('applies a theme change to the document root', async () => {
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByLabel('Theme').selectOption('dark')

  await expect(page.locator('html')).toHaveClass(/dark/)

  await page.getByLabel('Theme').selectOption('light')
  await expect(page.locator('html')).not.toHaveClass(/dark/)
})

test('writes diagnostics that the Logs screen can read back', async () => {
  await page.getByRole('link', { name: 'Logs' }).click()
  await expect(page.getByRole('heading', { name: 'Logs', level: 1 })).toBeVisible()

  // Boot always logs "RecoverX starting", so the file, the reader, the
  // filter and the virtualised list are all exercised by this one assertion.
  await page.getByRole('searchbox', { name: /Search messages/ }).fill('RecoverX starting')

  await expect(page.getByText('RecoverX starting').first()).toBeVisible({ timeout: 15_000 })
})

test('reports build and storage details on the About screen', async () => {
  await page.getByRole('link', { name: 'About' }).click()

  await expect(page.getByRole('heading', { name: 'About', level: 1 })).toBeVisible()
  await expect(page.getByText('Electron', { exact: true })).toBeVisible()
  // The data folder and the log folder both start with this path, so the match
  // is intentionally non-unique.
  await expect(page.getByText(userDataDir, { exact: false }).first()).toBeVisible()
})

test('blocks navigation away from the application origin', async () => {
  const navigated = await page.evaluate(async () => {
    // This callback runs in the browser. It cannot say `window`, because that
    // identifier resolves to the Playwright `Page` binding in the enclosing
    // scope at compile time, and the Node tsconfig has no DOM lib.
    const browser = globalThis as unknown as { location: { href: string } }

    const before = browser.location.href
    browser.location.href = 'https://example.com'
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { before, after: browser.location.href }
  })

  expect(navigated.after).toBe(navigated.before)
})

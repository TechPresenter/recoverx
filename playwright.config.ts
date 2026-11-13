import { defineConfig } from '@playwright/test'

/**
 * End-to-end suite for RecoverX.
 *
 * These specs drive the *packaged bundle* (out/) through Playwright's Electron
 * launcher, which is the only place where the real SQLite driver, the real IPC
 * transport and the real security hardening are all exercised together.
 *
 * Run `npm run build` before `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  // Electron tests share a single user-data directory per worker; running them
  // serially keeps the SQLite file and the log directory deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'test-results/playwright-junit.xml' }]]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
})

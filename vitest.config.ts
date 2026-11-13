import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const r = (...segments: string[]): string => resolve(__dirname, ...segments)

/**
 * Vitest workspace for RecoverX.
 *
 * Two projects run side by side because the code under test has two different
 * runtimes:
 *
 *   "node"     — src/shared kernel and the pure logic of src/main (contracts,
 *                migration planning, formatting, log parsing). Runs on plain
 *                Node, so it must not touch Electron or native addons.
 *
 *   "renderer" — React components, hooks and Zustand stores, under jsdom.
 *
 * Anything that requires the *real* SQLite driver or a live Electron runtime is
 * covered by the Playwright/Electron suite in tests/e2e instead. `better-sqlite3`
 * is compiled against the Electron ABI by the postinstall step, so it is not
 * loadable from a plain Node test process — see docs/DEVELOPMENT.md.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': r('src/renderer'),
      '@main': r('src/main'),
      '@shared': r('src/shared'),
      '@server': r('src/server'),
    },
  },
  test: {
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    passWithNoTests: false,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      /*
       * Scoped to the logic that a Node or jsdom process can genuinely exercise:
       * the shared kernel, the persistence layer, and the pure cores extracted
       * out of the main process.
       *
       * Modules that require a live Electron runtime — window management, the
       * IPC registry, session hardening, bootstrap — are deliberately excluded.
       * Including them would report a large block of permanently-zero files and
       * make the number meaningless. They are covered by the Playwright/Electron
       * suite in tests/e2e instead.
       */
      include: [
        'src/shared/**/*.ts',
        'src/main/database/**/*.ts',
        'src/main/logging/log-parser.ts',
        'src/main/services/settings-codec.ts',
        'src/main/services/settings.service.ts',
        // The licence server runs on plain Node, so all of it is testable here
        // except the two entry points, which are only process plumbing.
        'src/server/**/*.ts',
      ],
      exclude: [
        'src/**/*.d.ts',
        'src/shared/index.ts',
        'src/server/server.ts',
        'src/server/admin.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: [r('tests/renderer/setup.ts')],
        },
      },
    ],
  },
})

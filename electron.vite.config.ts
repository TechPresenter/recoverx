import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const r = (...segments: string[]): string => resolve(__dirname, ...segments)

/** Packages grouped into long-lived vendor chunks. See `manualChunks` below. */
const REACT_PACKAGES = new Set([
  'react',
  'react-dom',
  'scheduler',
  'react-router',
  'react-router-dom',
])
const CHART_PACKAGES = new Set(['chart.js', 'react-chartjs-2', '@kurkle/color'])
const I18N_PACKAGES = new Set(['i18next', 'react-i18next', 'html-parse-stringify', 'void-elements'])

/**
 * Extract the package name from a module id, handling scoped packages and
 * nested `node_modules` directories.
 */
function resolvePackageName(id: string): string | null {
  const segments = id.split(/[\\/]node_modules[\\/]/)
  const tail = segments[segments.length - 1]
  if (segments.length < 2 || tail === undefined) return null

  const parts = tail.split(/[\\/]/)
  const first = parts[0]
  if (first === undefined) return null

  if (first.startsWith('@')) {
    const second = parts[1]
    return second === undefined ? first : `${first}/${second}`
  }

  return first
}

/**
 * electron-vite build graph for RecoverX.
 *
 * Three independent bundles are produced:
 *   out/main/index.js      — Electron main process (CommonJS, Node 24 target)
 *   out/preload/index.js   — sandbox-safe context bridge (CommonJS)
 *   out/renderer/          — React application (ES2022, browser target)
 *
 * `externalizeDepsPlugin` keeps every runtime `dependency` out of the main and
 * preload bundles. That is mandatory for `better-sqlite3` (a native .node addon
 * that cannot be bundled) and it also keeps the main bundle small, which is the
 * single biggest lever on cold-start time.
 */
/**
 * Build-time environment variables exposed to the bundles.
 *
 * Only this prefix is forwarded, so an unrelated variable in a developer's
 * shell — or a CI secret for another service — can never be compiled into a
 * shipped build by accident.
 */
const ENV_PREFIX = 'RECOVERX_'

export default defineConfig({
  main: {
    envPrefix: ENV_PREFIX,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': r('src/main'),
        '@shared': r('src/shared'),
      },
    },
    build: {
      target: 'node22',
      outDir: 'out/main',
      minify: 'esbuild',
      sourcemap: true,
      reportCompressedSize: false,
      rollupOptions: {
        input: { index: r('src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },

  preload: {
    envPrefix: ENV_PREFIX,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
      },
    },
    build: {
      target: 'node22',
      outDir: 'out/preload',
      minify: 'esbuild',
      sourcemap: true,
      reportCompressedSize: false,
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
        // A sandboxed preload script is evaluated in a restricted CommonJS
        // scope; ESM output would fail to load at runtime.
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },

  renderer: {
    envPrefix: ENV_PREFIX,
    root: r('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': r('src/renderer'),
        '@shared': r('src/shared'),
      },
    },
    server: {
      // Deterministic port so the Playwright/Electron harness and the DevTools
      // workspace mapping never have to guess.
      port: 5273,
      strictPort: true,
    },
    build: {
      target: 'es2022',
      outDir: 'out/renderer',
      sourcemap: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 900,
      // electron-vite does not enable minification by default. Without these,
      // the renderer ships the unminified production React build — roughly four
      // times the bytes to parse before first paint.
      minify: 'esbuild',
      cssMinify: 'esbuild',
      rollupOptions: {
        input: { index: r('src/renderer/index.html') },
        output: {
          // Split the heavy, rarely-changing vendor surface away from feature
          // code, so a patch release only invalidates a small chunk and first
          // paint is not blocked on the charting or i18n bundles.
          //
          // A function rather than the object form: the object form resolves
          // each name to a single entry module, so secondary entry points
          // (`react-dom/client`) and transitive dependencies (`scheduler`,
          // `@kurkle/color`) silently land back in the main chunk.
          //
          // Matching is on the exact package name. A prefix test would put
          // `react-chartjs-2` and `react-i18next` into the React chunk, which
          // both inflates it and creates a chunk import cycle.
          //
          // Everything not listed is left to Rollup. A catch-all `vendor` chunk
          // is what produces cycles: `zustand` imports React while
          // `react-router` imports `cookie`, so the two chunks end up importing
          // each other.
          manualChunks: (id: string): string | undefined => {
            const packageName = resolvePackageName(id)
            if (packageName === null) return undefined

            if (REACT_PACKAGES.has(packageName)) return 'vendor-react'
            if (CHART_PACKAGES.has(packageName)) return 'vendor-charts'
            if (I18N_PACKAGES.has(packageName)) return 'vendor-i18n'

            return undefined
          },
        },
      },
    },
  },
})

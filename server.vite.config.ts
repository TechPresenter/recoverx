import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const r = (...segments: string[]): string => resolve(__dirname, ...segments)

/**
 * Build of the vendor-side licence server and its admin CLI.
 *
 *     npm run licensing:build
 *       → dist/license-server/server.mjs
 *       → dist/license-server/admin.mjs
 *
 * A Vite SSR build rather than `tsc`, for the same reason the desktop app is
 * bundled: the path aliases (`@shared`, `@main`, `@server`) are resolved at
 * build time, and every dependency is bundled in. The output needs nothing
 * but a Node runtime — no `npm install` on the server, no `node_modules` in
 * the container image, and no chance of a dependency resolving differently in
 * production than it did in CI.
 *
 * Node built-ins stay external, `node:sqlite` among them: it is part of the
 * runtime, not a package.
 */
export default defineConfig({
  // Nothing from a developer's `.env` belongs in a server bundle; its
  // configuration is read from the environment at run time.
  envDir: false,
  publicDir: false,
  logLevel: 'warn',
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@main': r('src/main'),
      '@server': r('src/server'),
    },
  },
  ssr: {
    target: 'node',
    // Bundle every package (today that is zod) into the output.
    noExternal: true,
  },
  build: {
    ssr: true,
    target: 'node22',
    outDir: r('dist/license-server'),
    emptyOutDir: true,
    sourcemap: true,
    // Unminified: stack traces in a production log should be readable without
    // a source-map lookup, and the bundle is small either way.
    minify: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        server: r('src/server/server.ts'),
        admin: r('src/server/admin.ts'),
      },
      external: [/^node:/u, ...builtinModules],
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
        // Entries only, so `./admin.mjs` runs directly on a Unix host.
        banner: (chunk) => (chunk.isEntry ? '#!/usr/bin/env node' : ''),
      },
    },
  },
})

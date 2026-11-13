import { runAdmin } from './admin-cli'

/**
 * Admin CLI entry point.
 *
 *     node dist/license-server/admin.mjs create --edition professional --order INV-1042
 *
 * All behaviour lives in `admin-cli.ts`; this file only connects it to the
 * process. `process.exitCode` rather than `process.exit()`, so buffered output
 * to a pipe is flushed before the process ends.
 */
process.exitCode = runAdmin(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
})

#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Check the PHP licence server: `npm run licensing:php:test`.
 *
 * 1. Finds a PHP binary with the sodium and pdo_sqlite extensions — the
 *    RECOVERX_PHP_BIN environment variable, then `php` on the PATH, then
 *    XAMPP's C:/xampp/php/php.exe — loading sodium with `-d extension=sodium`
 *    when it is installed but not enabled (never touching php.ini).
 * 2. Runs `php -l` on every .php file under server-php/.
 * 3. Runs the unit tests, server-php/tests/run.php. Extra arguments are passed
 *    on as a name filter: `npm run licensing:php:test -- Authority`.
 *
 * Exits non-zero when PHP cannot be found, a file does not parse, or a test
 * fails. The HTTP contract-parity suite is separate and runs under vitest
 * (tests/unit/server/php-contract.test.ts).
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const php = findPhp()
if (php === null) {
  console.error(
    [
      'No PHP 8.1+ with the sodium and pdo_sqlite extensions was found.',
      'Looked at: RECOVERX_PHP_BIN, `php` on the PATH, and C:/xampp/php/php.exe.',
      'Install PHP (or XAMPP), or point RECOVERX_PHP_BIN at a php binary.',
    ].join('\n'),
  )
  process.exit(1)
}

process.stdout.write(`Using ${php.bin} ${php.args.join(' ')} (PHP ${php.version})\n\n`)

const files = listPhpFiles(root)
const broken = []
for (const file of files) {
  const result = spawnSync(php.bin, [...php.args, '-l', file], { encoding: 'utf8' })
  if (result.status !== 0) broken.push(`${relative(root, file)}\n${result.stdout}${result.stderr}`)
}

if (broken.length > 0) {
  console.error(`php -l found problems in ${broken.length} of ${files.length} files:\n`)
  console.error(broken.join('\n'))
  process.exit(1)
}
process.stdout.write(`php -l: ${files.length} files, no syntax errors\n\n`)

const tests = spawnSync(
  php.bin,
  [...php.args, join('tests', 'run.php'), ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
  },
)

if (tests.error !== undefined) {
  console.error(`Could not run the tests: ${tests.error.message}`)
  process.exit(1)
}
process.exit(tests.status ?? 1)

/**
 * The first PHP that can run the server, with the arguments it needs.
 *
 * @returns {{ bin: string, args: string[], version: string } | null}
 */
function findPhp() {
  const candidates = [process.env.RECOVERX_PHP_BIN, 'php', 'C:/xampp/php/php.exe'].filter(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  )
  const check =
    "echo (extension_loaded('sodium') ? 1 : 0), ' ', (extension_loaded('pdo_sqlite') ? 1 : 0), ' ', PHP_VERSION_ID, ' ', PHP_VERSION;"

  for (const bin of candidates) {
    for (const args of [[], ['-d', 'extension=sodium']]) {
      const result = spawnSync(bin, [...args, '-d', 'display_startup_errors=0', '-r', check], {
        encoding: 'utf8',
      })
      if (result.error !== undefined) break
      if (result.status !== 0) continue

      const fields = result.stdout.trim().split(/\s+/u).slice(-4)
      const [sodium, sqlite, id, version] = fields
      if (sodium === '1' && sqlite === '1' && Number(id) >= 80100) {
        return { bin, args, version: version ?? id ?? '?' }
      }
    }
  }

  return null
}

/** Every .php file under `directory`, skipping dependency and output folders. */
function listPhpFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!['node_modules', 'data', 'vendor'].includes(entry.name))
        found.push(...listPhpFiles(path))
    } else if (entry.name.endsWith('.php')) {
      found.push(path)
    }
  }
  return found.sort()
}

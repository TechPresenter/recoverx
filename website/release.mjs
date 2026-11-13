#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  ContentError,
  VERSION_PATTERN,
  installerFileName,
  installerPath,
  readReleases,
} from './lib/content.mjs'

/**
 * Point the website's download page at a new installer.
 *
 *     node website/release.mjs release/<version>/store/RecoverX-Setup-<version>-x64.exe
 *         [--date YYYY-MM-DD] [--content <dir>]
 *
 * Writes website/content/release.json from the file itself — version, name,
 * size and SHA-256 — because the checksum on the download page is something
 * customers are told to compare against, and a hand-copied one that is wrong
 * by a character teaches them to ignore it.
 *
 * Takes the installer scripts/package-store.mjs stages under `store/` after
 * checking every signature in it — the same name and bytes the Store
 * submission points at — and refuses one stamped NOT-FOR-SUBMISSION. The release notes for the version must already be in
 * releases.json with the same date, so the download page and the release
 * notes cannot disagree. See "Publishing a release" in website/README.md.
 */

const WEBSITE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`release: ${message}\n`)
  process.exit(1)
}

/** @param {Date} date */
function localIsoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
function sha256(file) {
  return new Promise((done, failed) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', failed)
      .on('end', () => done(hash.digest('hex')))
  })
}

const args = process.argv.slice(2)
/** @type {string | undefined} */
let installerArgument
let date = localIsoDate(new Date())
let contentDir = join(WEBSITE_DIR, 'content')

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  const value = args[index + 1]
  if (argument === '--date' && value !== undefined) {
    date = value
    index += 1
  } else if (argument === '--content' && value !== undefined) {
    contentDir = resolve(value)
    index += 1
  } else if (
    argument !== undefined &&
    !argument.startsWith('--') &&
    installerArgument === undefined
  ) {
    installerArgument = argument
  } else {
    fail(
      'usage: node website/release.mjs <RecoverX-Setup-<version>-x64.exe> [--date YYYY-MM-DD] [--content <dir>]',
    )
  }
}

if (installerArgument === undefined) {
  fail('name the installer to publish, e.g. release/0.1.0/store/RecoverX-Setup-0.1.0-x64.exe')
}

const installer = resolve(/** @type {string} */ (installerArgument))
if (!existsSync(installer) || !statSync(installer).isFile()) fail(`no such file: ${installer}`)

const fileName = basename(installer)
if (fileName.includes('NOT-FOR-SUBMISSION')) {
  fail(`${fileName} is a test build (NOT-FOR-SUBMISSION) and must never be offered for download.`)
}

const match = /^RecoverX-Setup-(.+)-x64\.exe$/u.exec(fileName)
const version = match?.[1] ?? ''
if (!VERSION_PATTERN.test(version) || fileName !== installerFileName(version)) {
  fail(
    `${fileName} is not named RecoverX-Setup-<version>-x64.exe. Use the copy under ` +
      'release/<version>/store/ that `npm run package:store` writes after verifying its signatures.',
  )
}

if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) fail(`--date must be YYYY-MM-DD (got ${date}).`)

try {
  const releases = readReleases(join(contentDir, 'releases.json'))
  const notes = releases.find((release) => release.version === version)
  if (!notes) {
    fail(`releases.json has no entry for ${version}. Write its release notes first.`)
  } else if (notes.date !== date) {
    fail(
      `releases.json gives ${version} the date ${String(notes.date)}; set it to ${date} ` +
        '(the day the installer is uploaded), or pass --date to match.',
    )
  }
} catch (error) {
  if (error instanceof ContentError) fail(error.message)
  throw error
}

const record = {
  version,
  fileName,
  sha256: await sha256(installer),
  size: statSync(installer).size,
  date,
}

const target = join(contentDir, 'release.json')
writeFileSync(
  target,
  `${JSON.stringify(
    {
      '//': 'The installer offered on /download/. Written by `node website/release.mjs <installer.exe>` — do not edit the hash or size by hand. `null` until the first installer has been uploaded to /downloads/win/<version>/; the page then says a release is being prepared.',
      installer: record,
    },
    null,
    2,
  )}\n`,
)

process.stdout.write(
  [
    `Wrote ${target}`,
    `  ${record.fileName}  ${String(record.size)} bytes`,
    `  SHA-256 ${record.sha256}`,
    '',
    'Next:',
    `  1. Upload the installer to public_html${installerPath(record)} (a new folder; never replace a published file).`,
    '  2. npm run website:build, and upload dist/website/ (see website/README.md).',
    '',
  ].join('\n'),
)

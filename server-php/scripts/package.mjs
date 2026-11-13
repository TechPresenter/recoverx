#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * Package the PHP licence server for upload: `npm run licensing:php:package`.
 *
 * Writes release/license-server-php/recoverx-licensing-php-<version>.zip, laid
 * out exactly as the folders sit on the host, so the README's upload steps are
 * "put this folder there":
 *
 *     recoverx-licensing/app/…        → next to public_html (never web-accessible)
 *     recoverx-licensing/README.md
 *     public_html/.htaccess           → into the site's public_html
 *     public_html/v1/index.php
 *     public_html/admin/index.php
 *     public_html/setup/index.php
 *
 * Tests, the provisioning tool (app/bin, for tests and development only) and
 * anything in a data/ folder are left out: a package must never carry a key,
 * a database or a configuration.
 *
 * The zip is written here in plain Node (deflate from node:zlib, CRC-32 and
 * the container format by hand), so packaging needs no new dependency and
 * works the same on every platform. After writing, the archive is read back
 * and every entry is inflated and checked against its CRC.
 */

const serverDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoDir = dirname(serverDir)
const require = createRequire(import.meta.url)
const { version } = /** @type {{ version: string }} */ (require(join(repoDir, 'package.json')))

const outputDir = join(repoDir, 'release', 'license-server-php')
const output = join(outputDir, `recoverx-licensing-php-${version}.zip`)

/** Never packaged, wherever they appear. */
const EXCLUDED = [
  /^app\/bin(\/|$)/u,
  /(^|\/)data(\/|$)/u,
  /(^|\/)config\.local\.php$/u,
  /\.(db|key|pem|log|sqlite3?)$/u,
]

/** @type {Array<{ name: string, data: Buffer | null, mtime: Date }>} */
const entries = []

function main() {
  addTree(join(serverDir, 'app'), 'app', 'recoverx-licensing/app')
  addFile(join(serverDir, 'README.md'), 'recoverx-licensing/README.md')
  addTree(join(serverDir, 'public'), '', 'public_html')

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const required of [
    'recoverx-licensing/app/bootstrap.php',
    'public_html/.htaccess',
    'public_html/v1/index.php',
    'public_html/admin/index.php',
    'public_html/setup/index.php',
  ]) {
    if (!entries.some((entry) => entry.name === required)) {
      console.error(`The package would be missing ${required}; refusing to write it.`)
      process.exit(1)
    }
  }

  const archive = writeZip(entries)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(output, archive)

  const listed = verifyZip(archive)
  process.stdout.write(
    `${relative(repoDir, output)} (${archive.length} bytes, ${listed.length} entries)\n\n`,
  )
  for (const entry of listed) {
    process.stdout.write(`  ${entry.size.toString().padStart(7)}  ${entry.name}\n`)
  }
}

// --- collecting files ---------------------------------------------------------------

/**
 * Add a directory and everything under it.
 *
 * @param {string} directory absolute source directory
 * @param {string} relativeToServer its path relative to server-php/, for exclusions
 * @param {string} target its path inside the zip
 */
function addTree(directory, relativeToServer, target) {
  entries.push({ name: `${target}/`, data: null, mtime: statSync(directory).mtime })

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name)
    const rel = relativeToServer === '' ? entry.name : `${relativeToServer}/${entry.name}`
    if (EXCLUDED.some((pattern) => pattern.test(rel))) continue

    if (entry.isDirectory()) addTree(source, rel, `${target}/${entry.name}`)
    else if (entry.isFile()) addFile(source, `${target}/${entry.name}`)
  }
}

function addFile(source, name) {
  entries.push({
    name: name.split(sep).join('/'),
    data: readFileSync(source),
    mtime: statSync(source).mtime,
  })
}

// --- the zip format -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time, the only timestamps the basic zip format has. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** @param {Array<{ name: string, data: Buffer | null, mtime: Date }>} items */
function writeZip(items) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8')
    const isDirectory = item.data === null
    const raw = item.data ?? Buffer.alloc(0)
    const deflated = isDirectory ? raw : deflateRawSync(raw, { level: 9 })
    const useDeflate = !isDirectory && deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const crc = crc32(raw)
    const { time, date } = dosDateTime(item.mtime)
    // Unix permissions in the high half of the external attributes, so an
    // extractor that honours them creates 0755 folders and 0644 files.
    const external = isDirectory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4) // made by: Unix, zip 3.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(external, 38)
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  if (offset > 0xffffffff || items.length > 0xffff) {
    throw new Error('The package is too large for a basic zip file.')
  }

  return Buffer.concat([...locals, directory, end])
}

/**
 * Read the archive back through its central directory, inflate every entry
 * and check its CRC — so a packaging bug fails here, not on the host.
 */
function verifyZip(archive) {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endOffset < 0) throw new Error('No end-of-central-directory record was written.')

  const count = archive.readUInt16LE(endOffset + 10)
  let pointer = archive.readUInt32LE(endOffset + 16)
  const listed = []

  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(pointer) !== 0x02014b50)
      throw new Error(`Bad central header ${index}.`)
    const method = archive.readUInt16LE(pointer + 10)
    const crc = archive.readUInt32LE(pointer + 16)
    const compressed = archive.readUInt32LE(pointer + 20)
    const size = archive.readUInt32LE(pointer + 24)
    const nameLength = archive.readUInt16LE(pointer + 28)
    const extra = archive.readUInt16LE(pointer + 30)
    const comment = archive.readUInt16LE(pointer + 32)
    const localOffset = archive.readUInt32LE(pointer + 42)
    const name = archive.toString('utf8', pointer + 46, pointer + 46 + nameLength)

    if (archive.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error(`Bad local header for ${name}.`)
    const dataStart =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28)
    const stored = archive.subarray(dataStart, dataStart + compressed)
    const data = method === 8 ? inflateRawSync(stored) : stored

    if (data.length !== size || crc32(data) !== crc)
      throw new Error(`${name} does not read back intact.`)

    listed.push({ name, size })
    pointer += 46 + nameLength + extra + comment
  }

  return listed
}

// Last, so every constant above is initialised before it runs.
main()

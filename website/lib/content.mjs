import { readFileSync } from 'node:fs'

/**
 * The site's own data files, read and checked.
 *
 * `website/content/release.json` and `releases.json` are edited by hand (or,
 * for the installer, by website/release.mjs) and then published to every
 * visitor, so a mistake in one is a mistake on the live site: a download link
 * to a file that is not there, or a checksum a customer will be told to trust.
 * Every field is therefore checked here and the build stops on the first
 * problem, naming the file and the field.
 */

/**
 * @typedef {object} Installer
 * @property {string} version
 * @property {string} fileName `RecoverX-Setup-<version>-x64.exe`.
 * @property {string} sha256 Lower-case hex.
 * @property {number} size Bytes.
 * @property {string} date `YYYY-MM-DD`, the day it was uploaded.
 */

/**
 * @typedef {object} Release
 * @property {string} version
 * @property {string | null} date `YYYY-MM-DD`, or `null` while not yet released.
 * @property {string} title
 * @property {string[]} notes
 */

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

/**
 * The installer's published file name for a version. Matches what
 * scripts/package-store.mjs stages, so the file uploaded for the Store and
 * the one linked from the site are the same bytes under the same name.
 *
 * @param {string} version
 */
export function installerFileName(version) {
  return `RecoverX-Setup-${version}-x64.exe`
}

/**
 * Where an installer is published. Versioned and immutable: a file at one of
 * these URLs is never replaced (see website/README.md).
 *
 * @param {Installer} installer
 */
export function installerPath(installer) {
  return `/downloads/win/${installer.version}/${installer.fileName}`
}

/** A content file that failed its checks. */
export class ContentError extends Error {}

/**
 * Read a JSON file into an unknown value, to be checked field by field.
 *
 * @param {string} path
 * @returns {unknown}
 */
export function readJson(path) {
  const text = readFileSync(path, 'utf8')
  try {
    // eslint-disable-next-line no-restricted-syntax -- the result is `unknown` and every caller checks it field by field; Zod is an application dependency the dependency-free site build does not take on.
    return JSON.parse(text)
  } catch (error) {
    throw new ContentError(`${path}: not valid JSON (${String(error)})`)
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} where
 * @param {unknown} value
 * @returns {string}
 */
function requireString(where, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ContentError(`${where} must be a non-empty string.`)
  }
  return value
}

/**
 * @param {string} where
 * @param {unknown} value
 * @returns {string}
 */
function requireDate(where, value) {
  const text = requireString(where, value)
  const parsed = new Date(`${text}T00:00:00Z`)
  if (!DATE_PATTERN.test(text) || Number.isNaN(parsed.getTime())) {
    throw new ContentError(`${where} must be a date written YYYY-MM-DD (got "${text}").`)
  }
  // Rejects 2026-02-31, which Date would quietly roll over into March.
  if (parsed.toISOString().slice(0, 10) !== text) {
    throw new ContentError(`${where} is not a real date: "${text}".`)
  }
  return text
}

/**
 * @param {string} path
 * @returns {Installer | null}
 */
export function readInstaller(path) {
  const data = readJson(path)
  if (!isRecord(data) || !('installer' in data)) {
    throw new ContentError(`${path}: expected an object with an "installer" field.`)
  }

  const raw = data.installer
  if (raw === null) return null
  if (!isRecord(raw)) throw new ContentError(`${path}: "installer" must be an object or null.`)

  const version = requireString(`${path}: installer.version`, raw.version)
  if (!VERSION_PATTERN.test(version)) {
    throw new ContentError(`${path}: installer.version "${version}" is not a version number.`)
  }

  const fileName = requireString(`${path}: installer.fileName`, raw.fileName)
  if (fileName !== installerFileName(version)) {
    throw new ContentError(
      `${path}: installer.fileName must be "${installerFileName(version)}" (got "${fileName}").`,
    )
  }

  const sha256 = requireString(`${path}: installer.sha256`, raw.sha256)
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new ContentError(`${path}: installer.sha256 must be 64 lower-case hex digits.`)
  }

  const size = raw.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new ContentError(`${path}: installer.size must be a positive whole number of bytes.`)
  }

  const date = requireDate(`${path}: installer.date`, raw.date)

  return { version, fileName, sha256, size, date }
}

/**
 * Compare two versions numerically, so 0.10.0 sorts after 0.9.0.
 * Pre-release suffixes sort before the release they lead to.
 *
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const [coreA = '', preA] = a.split('-', 2)
  const [coreB = '', preB] = b.split('-', 2)
  const partsA = coreA.split('.').map(Number)
  const partsB = coreB.split('.').map(Number)

  for (let index = 0; index < 3; index += 1) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (preA === preB) return 0
  if (preA === undefined) return 1
  if (preB === undefined) return -1
  return preA < preB ? -1 : 1
}

/**
 * @param {string} path
 * @returns {Release[]}
 */
export function readReleases(path) {
  const data = readJson(path)
  if (!isRecord(data) || !Array.isArray(data.releases)) {
    throw new ContentError(`${path}: expected an object with a "releases" array.`)
  }

  /** @type {unknown[]} */
  const entries = data.releases
  const releases = entries.map((entry, index) => {
    const where = `${path}: releases[${index}]`
    if (!isRecord(entry)) throw new ContentError(`${where} must be an object.`)

    const version = requireString(`${where}.version`, entry.version)
    if (!VERSION_PATTERN.test(version)) {
      throw new ContentError(`${where}.version "${version}" is not a version number.`)
    }

    const date = entry.date === null ? null : requireDate(`${where}.date`, entry.date)
    const title = requireString(`${where}.title`, entry.title)

    const notes = entry.notes
    if (!Array.isArray(notes) || notes.length === 0) {
      throw new ContentError(`${where}.notes must be a non-empty array of sentences.`)
    }
    /** @type {unknown[]} */
    const noteList = notes

    return {
      version,
      date,
      title,
      notes: noteList.map((note, n) => requireString(`${where}.notes[${n}]`, note)),
    }
  })

  const seen = new Set()
  releases.forEach((release, index) => {
    if (seen.has(release.version)) {
      throw new ContentError(`${path}: version ${release.version} is listed twice.`)
    }
    seen.add(release.version)

    const previous = releases[index - 1]
    if (previous && compareVersions(previous.version, release.version) <= 0) {
      throw new ContentError(
        `${path}: releases must be newest first (${previous.version} is listed before ${release.version}).`,
      )
    }
  })

  return releases
}

/**
 * The installer and the release notes must tell the same story: the version
 * offered for download has notes, and those notes say it has been released.
 *
 * @param {Installer | null} installer
 * @param {readonly Release[]} releases
 */
export function checkConsistency(installer, releases) {
  if (installer === null) return

  const notes = releases.find((release) => release.version === installer.version)
  if (!notes) {
    throw new ContentError(
      `release.json offers ${installer.version}, but releases.json has no notes for it.`,
    )
  }
  if (notes.date === null) {
    throw new ContentError(
      `release.json offers ${installer.version}, but releases.json still lists it as not released (date: null).`,
    )
  }
}

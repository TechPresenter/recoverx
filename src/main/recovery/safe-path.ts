/**
 * Building safe destination paths from recovered names.
 *
 * **Every name handled here is untrusted.** It was read off a damaged
 * filesystem, possibly from a partially overwritten record, possibly from a
 * disk image an attacker supplied. A name like `..\..\Windows\System32\x.dll`
 * is not hypothetical — it is what a corrupted `$FILE_NAME` attribute can
 * decode to, and writing it verbatim would place a file outside the
 * destination the user chose.
 *
 * So the rule is absolute: a recovered file is written inside the destination
 * folder or it is not written at all. Sanitisation happens per path segment,
 * and the result is re-checked against the destination root before any handle
 * is opened.
 */

/** Characters Windows forbids in a file name. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be stripped
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/gu

/**
 * Device names Windows reserves at every directory level.
 *
 * A file called `CON` cannot be created even inside a deep folder, and the
 * failure is an obscure OS error rather than anything the user could act on.
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

/** Windows caps a single path component at 255 characters. */
const MAX_SEGMENT_LENGTH = 255

/** Used when a name sanitises away to nothing. */
export const FALLBACK_NAME = 'unnamed'

/**
 * Make one path segment safe to create on Windows.
 *
 * Returns an empty string for a segment that carries no usable content — `.`,
 * `..` and anything that reduces to nothing — so the caller can drop it rather
 * than substituting a placeholder folder into the user's tree.
 */
export function sanitizeSegment(segment: string): string {
  const stripped = segment.replace(ILLEGAL_CHARACTERS, '_')

  // Windows silently drops trailing dots and spaces, which turns "report." into
  // "report" and can collide two distinct recovered files into one.
  const trimmed = stripped.replace(/[. ]+$/u, '').trim()

  if (trimmed.length === 0) return ''
  // Relative components must never survive: they are the traversal vector.
  if (trimmed === '.' || trimmed === '..') return ''

  const [base = '', ...rest] = trimmed.split('.')
  const extension = rest.length > 0 ? `.${rest.join('.')}` : ''

  // A reserved device name is rejected by the OS even with an extension, so the
  // base is prefixed rather than replaced — the user still recognises the file.
  const safeBase = RESERVED_NAMES.has(base.toLowerCase()) ? `_${base}` : base
  const rebuilt = `${safeBase}${extension}`

  return rebuilt.length > MAX_SEGMENT_LENGTH ? truncatePreservingExtension(rebuilt) : rebuilt
}

/**
 * Shorten an over-long name without losing its extension.
 *
 * The extension is what decides whether the recovered file opens in the right
 * application, so it survives at the cost of the base name.
 */
function truncatePreservingExtension(name: string): string {
  const dot = name.lastIndexOf('.')

  if (dot <= 0 || name.length - dot > 16) {
    return name.slice(0, MAX_SEGMENT_LENGTH)
  }

  const extension = name.slice(dot)
  return name.slice(0, MAX_SEGMENT_LENGTH - extension.length) + extension
}

/**
 * Sanitise a recovered folder path into segments safe to create.
 *
 * Traversal components are dropped, not escaped: there is no legitimate reason
 * for a recovered path to climb above the destination, and preserving one would
 * defeat the whole guard.
 */
export function sanitizeRelativePath(path: string): string[] {
  if (path.length === 0) return []

  return path
    .split(/[\\/]/u)
    .map(sanitizeSegment)
    .filter((segment) => segment.length > 0)
}

export interface TargetPathOptions {
  /** Recreate the folder hierarchy the file came from. */
  readonly restoreFolderStructure: boolean
  /** Group by file category instead, e.g. `Images/`, `Documents/`. */
  readonly groupByCategory?: string | undefined
}

/**
 * Build the relative path a recovered file should be written to.
 *
 * Returns segments rather than a joined string so the caller can create each
 * directory level and re-verify containment without re-parsing.
 */
export function buildTargetSegments(
  fileName: string,
  folderPath: string,
  options: TargetPathOptions,
): string[] {
  const name = sanitizeSegment(fileName)
  const safeName = name.length === 0 ? FALLBACK_NAME : name

  const prefix: string[] = []

  if (options.groupByCategory !== undefined) {
    const category = sanitizeSegment(options.groupByCategory)
    if (category.length > 0) prefix.push(category)
  }

  if (options.restoreFolderStructure) {
    prefix.push(...sanitizeRelativePath(folderPath))
  }

  return [...prefix, safeName]
}

/**
 * Resolve a name that does not collide with one already used.
 *
 * Two deleted files genuinely can share a name and path — a file created,
 * deleted, and created again leaves two records. Overwriting the first with the
 * second would silently lose one of them, so the second is suffixed in the
 * style Windows uses.
 */
export function uniqueName(taken: ReadonlySet<string>, name: string): string {
  const key = name.toLowerCase()
  if (!taken.has(key)) return name

  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''

  // Bounded: a pathological scan could otherwise spin here forever.
  for (let counter = 2; counter < 100_000; counter += 1) {
    const candidate = `${base} (${counter})${extension}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }

  return `${base} (${Date.now()})${extension}`
}

/**
 * Final containment check.
 *
 * Belt and braces over the segment sanitiser: even if a future change let a
 * traversal component through, nothing is written unless the resolved path is
 * genuinely inside the destination root.
 *
 * Both paths must already be absolute and normalised by the caller.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const normalisedRoot = normaliseForComparison(root)
  const normalisedCandidate = normaliseForComparison(candidate)

  if (normalisedCandidate === normalisedRoot) return false

  // The separator matters: without it, "C:\Recovered" would be considered to
  // contain "C:\RecoveredElsewhere".
  return normalisedCandidate.startsWith(
    normalisedRoot.endsWith('\\') ? normalisedRoot : `${normalisedRoot}\\`,
  )
}

/** Windows paths are case-insensitive and accept either separator. */
function normaliseForComparison(path: string): string {
  return path.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

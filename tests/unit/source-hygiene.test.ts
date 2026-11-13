import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source hygiene.
 *
 * A literal control character inside a source file is invisible in every
 * editor, turns the file "binary" for grep and ripgrep, and silently changes
 * what the code does — a NUL where a space belongs makes a path invalid, and a
 * Cyrillic homoglyph in an identifier makes an import fail with a message that
 * points nowhere useful.
 *
 * Both have happened in this codebase. The rule is enforced here rather than
 * left to review, because neither is visible to a reviewer.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const SCANNED_ROOTS = ['src', 'tests']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.json', '.css', '.html']

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'out', 'dist', 'release', 'coverage'])

function collectSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue

    const full = join(directory, entry)

    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, found)
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      found.push(full)
    }
  }

  return found
}

const SOURCE_FILES = SCANNED_ROOTS.flatMap((directory) => collectSourceFiles(join(ROOT, directory)))

describe('source hygiene', () => {
  it('scans a meaningful number of files', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(SOURCE_FILES.length).toBeGreaterThan(50)
  })

  it('contains no literal control characters', () => {
    const offenders: string[] = []

    for (const file of SOURCE_FILES) {
      const bytes = readFileSync(file)

      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index] ?? 0
        // Tab (0x09), LF (0x0A) and CR (0x0D) are the only legitimate ones.
        const isAllowed = byte === 0x09 || byte === 0x0a || byte === 0x0d

        if (byte < 0x20 && !isAllowed) {
          offenders.push(`${relative(ROOT, file)} offset ${index}: 0x${byte.toString(16)}`)
          break
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('uses no homoglyph characters inside identifiers', () => {
    // A Cyrillic "С" reads as a Latin "C" and breaks the import it appears in.
    const identifierWithHomoglyph = /[A-Za-z_$][A-Za-z0-9_$]*[Ͱ-ӿ][A-Za-z0-9_$]*/u
    const offenders: string[] = []

    for (const file of SOURCE_FILES) {
      const lines = readFileSync(file, 'utf8').split('\n')

      lines.forEach((line, index) => {
        const match = identifierWithHomoglyph.exec(line)
        if (match !== null) {
          offenders.push(`${relative(ROOT, file)}:${index + 1}: ${match[0]}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })

  it('has no byte-order mark, which breaks tooling that expects plain UTF-8', () => {
    const offenders = SOURCE_FILES.filter((file) => {
      const head = readFileSync(file).subarray(0, 3)
      return head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
    }).map((file) => relative(ROOT, file))

    expect(offenders).toEqual([])
  })
})

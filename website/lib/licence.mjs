import { escapeHtml, trusted } from './html.mjs'
import { renderInline, renderMarkdown, slugify } from './markdown.mjs'

/**
 * The licence terms, rendered from the repository's `LICENSE`.
 *
 * `LICENSE` is the end-user licence agreement the installer shows, and NSIS
 * shows it as plain text — so it is written as plain text, hard-wrapped, with
 * numbered upper-case section headings and an indented, column-aligned table
 * of editions. Run through a markdown converter it would come out as one
 * paragraph per section with the table collapsed into a sentence, which is
 * worse than useless for a legal text. This reads that layout instead:
 *
 *  - the first line is the title;
 *  - a line at the left margin that starts with a section number ("1.",
 *    "2.1") and does not end like a sentence is a section heading;
 *  - an indented block whose lines share a second column ("Free        …")
 *    is a two-column list of terms;
 *  - lines starting "-", "*", "•", "(a)" or "a)" are list items;
 *  - anything else is a paragraph, and its hard-wrapped lines are rejoined.
 *
 * Text is escaped; URLs and email addresses become links, and nothing else
 * is interpreted — an asterisk in a licence is an asterisk.
 *
 * Should `LICENSE` ever be rewritten in markdown (its first line a `#`
 * heading), it is handed to the markdown converter instead.
 */

/** @typedef {import('./markdown.mjs').RenderedDocument} RenderedDocument */
/** @typedef {import('./markdown.mjs').Heading} Heading */

const SECTION_HEADING = /^(\d+(?:\.\d+)*)\.?\s+(\S.*)$/u

/** Widest first column an aligned block may have and still be read as terms. */
const MAX_TERM_WIDTH = 24
const LIST_MARKER = /^(?:[-*•]|\([a-z0-9]{1,4}\)|[a-z]\))\s+/iu

/**
 * Is this line a section heading? It must sit at the left margin, start with
 * a section number, be short, and not read as a sentence: "5. NO WARRANTY" is
 * a heading, "5. You may not sublicense the Software." is a numbered clause.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isSectionHeading(line) {
  if (line.startsWith(' ')) return false
  const match = SECTION_HEADING.exec(line)
  if (!match) return false
  const title = (match[2] ?? '').trim()
  return title.length <= 80 && !/[.;,:]$/u.test(title)
}

/**
 * Count the section headings in the plain-text licence, independently of the
 * renderer, so the build can prove that none was dropped.
 *
 * @param {string} source
 * @returns {number}
 */
export function countLicenceSections(source) {
  return source
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .filter((line) => isSectionHeading(line)).length
}

/**
 * Is this licence written in markdown rather than plain text?
 *
 * @param {string} source
 * @returns {boolean}
 */
export function isMarkdownLicence(source) {
  const first =
    source
      .replace(/^\uFEFF/u, '')
      .trimStart()
      .split('\n')[0] ?? ''
  return /^#\s/u.test(first)
}

/**
 * @param {string} text
 * @returns {string}
 */
function inline(text) {
  return renderInline(text, { emphasis: false })
}

/**
 * Read an indented, column-aligned block as rows of term and description, or
 * return `null` if the block is not one.
 *
 * The second column is where most lines resume after a gap of two or more
 * spaces. Each line is split at the first gap that reaches that column, which
 * also handles a term that fills its column and leaves a single space —
 * "Professional Unlimited…" — as long as it overruns by no more than two
 * characters. A line blank up to the column continues the row above it.
 *
 * @param {readonly string[]} lines
 * @returns {Array<{ term: string, description: string }> | null}
 */
function splitAligned(lines) {
  if (lines.length < 2) return null
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length))
  if (indent < 2) return null

  /** @type {Map<number, number>} */
  const votes = new Map()
  for (const line of lines) {
    const gap = /^(\s*\S.*?)( {2,})\S/u.exec(line)
    if (gap) {
      const column = (gap[1] ?? '').length + (gap[2] ?? '').length
      votes.set(column, (votes.get(column) ?? 0) + 1)
    }
  }

  // At least two rows must agree, and the term column must be narrow: a
  // paragraph with a double space after a full stop is not a table.
  const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1])
  if (best === undefined || best[1] < Math.max(2, Math.ceil(lines.length / 2))) return null
  const column = best[0]
  if (column - indent > MAX_TERM_WIDTH) return null

  /** @type {Array<{ term: string, description: string }>} */
  const rows = []

  for (const line of lines) {
    let split = -1
    for (const gap of line.matchAll(/ +/gu)) {
      const start = gap.index
      const end = start + gap[0].length
      if (start < indent) {
        // The leading indent: a continuation line if it reaches the column.
        if (end >= column) {
          split = end
          break
        }
        continue
      }
      if (end >= column && start <= column + 2) {
        split = end
        break
      }
      if (start > column + 2) break
    }
    if (split === -1 || split >= line.length) return null

    const term = line.slice(0, split).trim()
    const description = line.slice(split).trim()
    const last = rows[rows.length - 1]
    if (term === '') {
      if (!last) return null
      last.description += ` ${description}`
    } else {
      rows.push({ term, description })
    }
  }

  return rows
}

/**
 * @param {ReadonlyArray<{ term: string, description: string }>} rows
 * @returns {string}
 */
function renderTermList(rows) {
  const items = rows
    .map((row) => `<div><dt>${inline(row.term)}</dt><dd>${inline(row.description)}</dd></div>`)
    .join('\n')

  return `<dl class="term-list">\n${items}\n</dl>`
}

/**
 * @param {ReadonlyArray<readonly string[]>} items Each item's lines, trimmed.
 * @returns {string}
 */
function renderList(items) {
  // "(a)" and "a)" markers are part of the clause's text — a contract cites
  // them — so they stay visible; bullets are replaced by the list's own.
  const rendered = items
    .map((parts) => `<li>${inline(parts.join(' ').replace(/^[-*•]\s+/u, ''))}</li>`)
    .join('\n')
  const bulleted = items.every((parts) => /^[-*•]\s/u.test(parts[0] ?? ''))

  return bulleted ? `<ul>\n${rendered}\n</ul>` : `<ul class="clauses">\n${rendered}\n</ul>`
}

/**
 * Render one blank-line-separated block: a term table, or a run of
 * paragraphs and lists.
 *
 * A list item starts at a line with a marker and owns the lines after it
 * that are indented further than the marker; the first line that is not
 * ends the list and starts a paragraph again. So "You may not:" followed by
 * "(a) …" and "(b) …" is a sentence and a list, as it reads.
 *
 * @param {readonly string[]} lines
 * @returns {string}
 */
function renderBlock(lines) {
  const rows = splitAligned(lines)
  if (rows !== null) return renderTermList(rows)

  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  let paragraph = []
  /** @type {string[][]} */
  let items = []
  let markerIndent = -1

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (items.length > 0) out.push(renderList(items))
    items = []
    markerIndent = -1
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const indent = line.length - line.trimStart().length
    const current = items[items.length - 1]

    if (LIST_MARKER.test(trimmed)) {
      flushParagraph()
      items.push([trimmed])
      markerIndent = indent
    } else if (current !== undefined && indent > markerIndent) {
      current.push(trimmed)
    } else {
      flushList()
      paragraph.push(trimmed)
    }
  }

  flushParagraph()
  flushList()
  return out.join('\n')
}

/**
 * Render the licence.
 *
 * @param {string} source
 * @returns {RenderedDocument}
 */
export function renderLicence(source) {
  if (isMarkdownLicence(source)) return renderMarkdown(source)

  const lines = source
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '    ')
    .replace(/[ ]+$/gmu, '')
    .split('\n')

  /** @type {Heading[]} */
  const headings = []
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  let block = []
  /** @type {Set<string>} */
  const ids = new Set()

  const flush = () => {
    if (block.length > 0) out.push(renderBlock(block))
    block = []
  }

  /** @param {string} base */
  const uniqueId = (base) => {
    let id = base
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}-${suffix}`
    ids.add(id)
    return id
  }

  let titled = false

  for (const line of lines) {
    if (line.trim() === '') {
      flush()
      continue
    }

    if (!titled) {
      const text = line.trim()
      const id = uniqueId(slugify(text))
      headings.push({ level: 1, text, id })
      out.push(`<h1 id="${id}">${escapeHtml(text)}</h1>`)
      titled = true
      continue
    }

    if (isSectionHeading(line)) {
      flush()
      const match = SECTION_HEADING.exec(line)
      const number = match?.[1] ?? ''
      const title = (match?.[2] ?? '').trim()
      const level = number.includes('.') ? 3 : 2
      const id = uniqueId(`section-${number.replace(/\./gu, '-')}`)
      // Upper-case headings are shown in the case they were written in; the
      // stylesheet does not shout them any louder than the installer does.
      const text = `${number}. ${title}`
      headings.push({ level, text, id })
      out.push(`<h${level} id="${id}">${escapeHtml(text)}</h${level}>`)
      continue
    }

    block.push(line)
  }

  flush()

  return { html: trusted(out.join('\n')), headings }
}

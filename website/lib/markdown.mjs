import { escapeHtml, trusted } from './html.mjs'

/**
 * A small, safe markdown-to-HTML converter.
 *
 * The privacy policy is written once, in `docs/store/privacy-policy.md`, and
 * the website publishes that file rather than a copy of it: two copies of a
 * legal text drift, and the one that drifts is the one customers read. This
 * converter is what makes that possible without a dependency.
 *
 * It covers what the documents in this repository actually use — ATX headings,
 * paragraphs, bullet and numbered lists (nested by indentation), pipe tables,
 * blockquotes, fenced code, rules, and inline bold, italic, strikethrough,
 * code, links and autolinks — and nothing else. Anything it does not
 * understand is shown as text, because **everything is escaped**: raw HTML in
 * a document is printed, not interpreted, and a link is only made for
 * `https:`, `http:`, `mailto:` and site-relative targets. A document can make
 * the page look wrong; it cannot make the page do anything.
 *
 * Two deliberate departures from CommonMark, both because of how the
 * repository writes markdown (Prettier with `proseWrap: preserve`, so a
 * paragraph is one line and a line break inside one is meant):
 *
 *  - a line break inside a paragraph is kept as `<br>`, so "Effective date"
 *    and "Last updated" on consecutive lines stay on separate lines;
 *  - setext headings (text underlined with `===`) are not recognised.
 *
 * HTML comments are removed before parsing, as GitHub hides them too: a
 * comment in a published document is a note to its editors.
 */

/**
 * @typedef {object} Heading
 * @property {number} level 1–6.
 * @property {string} text Plain text, for a table of contents.
 * @property {string} id Unique within the document.
 */

/**
 * @typedef {object} RenderedDocument
 * @property {import('./html.mjs').Html} html
 * @property {Heading[]} headings Every heading, in order.
 */

/**
 * State shared by one conversion: heading ids must be unique across the
 * whole document, and a table is labelled by the heading above it.
 *
 * @typedef {object} Context
 * @property {Heading[]} headings
 * @property {Map<string, number>} ids
 * @property {string | null} lastHeadingId
 */

// --- Block level -------------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u
const ATX_HEADING = /^\s{0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/u
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u
const BLOCKQUOTE = /^\s{0,3}>/u
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/u
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u

/**
 * Convert a markdown document.
 *
 * @param {string} source
 * @returns {RenderedDocument}
 */
export function renderMarkdown(source) {
  /** @type {Context} */
  const context = { headings: [], ids: new Map(), lastHeadingId: null }
  const lines = stripComments(normalise(source)).split('\n')
  const html = renderBlocks(lines, context, false)
  return { html: trusted(html), headings: context.headings }
}

/**
 * Count the headings a markdown source contains, independently of the
 * converter, so the build can prove that none was dropped.
 *
 * @param {string} source
 * @returns {number}
 */
export function countMarkdownHeadings(source) {
  let inFence = false
  let count = 0

  for (const line of stripComments(normalise(source)).split('\n')) {
    if (FENCE.test(line)) inFence = !inFence
    else if (!inFence && /^\s{0,3}#{1,6}\s+\S/u.test(line)) count += 1
  }

  return count
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalise(text) {
  // Private-use characters are the converter's own placeholders (see
  // `renderInline`); one arriving in a document must not be able to forge one.
  return text
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '    ')
    .replace(/[-]/gu, '')
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/gu, '')
}

/**
 * Does this line begin a block that ends the paragraph above it?
 *
 * @param {readonly string[]} lines
 * @param {number} index
 * @returns {boolean}
 */
function startsBlock(lines, index) {
  const line = lines[index] ?? ''
  return (
    FENCE.test(line) ||
    ATX_HEADING.test(line) ||
    RULE.test(line) ||
    BLOCKQUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, index)
  )
}

/**
 * @param {readonly string[]} lines
 * @param {number} index
 * @returns {boolean}
 */
function isTableStart(lines, index) {
  const line = lines[index] ?? ''
  const next = lines[index + 1]
  return line.includes('|') && next !== undefined && TABLE_DELIMITER.test(next)
}

/**
 * Render a run of lines as blocks.
 *
 * `tight` is set for the content of a list item in a list with no blank lines
 * between items: its paragraphs are rendered without `<p>`, as browsers and
 * every markdown renderer show tight lists.
 *
 * @param {readonly string[]} lines
 * @param {Context} context
 * @param {boolean} tight
 * @returns {string}
 */
function renderBlocks(lines, context, tight) {
  /** @type {string[]} */
  const out = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      /** @type {string[]} */
      const code = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        code.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading) {
      out.push(renderHeading((heading[1] ?? '#').length, heading[2] ?? '', context))
      index += 1
      continue
    }

    if (RULE.test(line)) {
      out.push('<hr>')
      index += 1
      continue
    }

    if (BLOCKQUOTE.test(line)) {
      /** @type {string[]} */
      const quoted = []
      while (index < lines.length && BLOCKQUOTE.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^\s{0,3}> ?/u, ''))
        index += 1
      }
      out.push(`<blockquote>\n${renderBlocks(quoted, context, false)}\n</blockquote>`)
      continue
    }

    if (isTableStart(lines, index)) {
      const end = findTableEnd(lines, index + 2)
      out.push(renderTable(lines.slice(index, end), context))
      index = end
      continue
    }

    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, index, context)
      out.push(list.html)
      index = list.next
      continue
    }

    /** @type {string[]} */
    const paragraph = [line.trim()]
    index += 1
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() !== '' &&
      !startsBlock(lines, index)
    ) {
      paragraph.push((lines[index] ?? '').trim())
      index += 1
    }

    const content = paragraph.map((part) => renderInline(part)).join('<br>\n')
    out.push(tight ? content : `<p>${content}</p>`)
  }

  return out.join('\n')
}

/**
 * @param {number} level
 * @param {string} raw
 * @param {Context} context
 * @returns {string}
 */
function renderHeading(level, raw, context) {
  const text = plainText(raw)
  const id = uniqueId(slugify(text), context)
  context.headings.push({ level, text, id })
  context.lastHeadingId = id
  return `<h${level} id="${id}">${renderInline(raw)}</h${level}>`
}

/**
 * A heading's text without its inline markup, for ids and tables of contents.
 *
 * @param {string} raw
 * @returns {string}
 */
export function plainText(raw) {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`~]/gu, '')
    .replace(/\\(.)/gu, '$1')
    .trim()
}

/**
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return slug === '' ? 'section' : slug
}

/**
 * @param {string} base
 * @param {Context} context
 * @returns {string}
 */
function uniqueId(base, context) {
  const seen = context.ids.get(base) ?? 0
  context.ids.set(base, seen + 1)
  return seen === 0 ? base : `${base}-${seen + 1}`
}

// --- Tables ------------------------------------------------------------------

/**
 * @param {readonly string[]} lines
 * @param {number} from
 * @returns {number}
 */
function findTableEnd(lines, from) {
  let index = from
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || !line.includes('|')) break
    index += 1
  }
  return index
}

/**
 * Split a table row into cells, honouring `\|` as a literal pipe.
 *
 * @param {string} row
 * @returns {string[]}
 */
function splitRow(row) {
  const trimmed = row
    .trim()
    .replace(/^\|/u, '')
    .replace(/(?<!\\)\|$/u, '')
  return trimmed.split(/(?<!\\)\|/u).map((cell) => cell.trim())
}

/**
 * @param {readonly string[]} rows
 * @param {Context} context
 * @returns {string}
 */
function renderTable(rows, context) {
  const header = splitRow(rows[0] ?? '')
  const alignments = splitRow(rows[1] ?? '').map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return ' class="align-center"'
    if (right) return ' class="align-right"'
    return ''
  })

  const head = header
    .map((cell, column) => `<th scope="col"${alignments[column] ?? ''}>${renderInline(cell)}</th>`)
    .join('')

  const body = rows
    .slice(2)
    .map((row) => {
      const cells = splitRow(row)
      // A short row is padded and a long one truncated, as GitHub does, so a
      // missing pipe cannot shift every later cell into the wrong column.
      const padded = header.map((_, column) => cells[column] ?? '')
      return `<tr>${padded
        .map((cell, column) => `<td${alignments[column] ?? ''}>${renderInline(cell)}</td>`)
        .join('')}</tr>`
    })
    .join('\n')

  // Wide tables scroll inside their own box on a phone instead of widening
  // the page. The box is focusable so the scroll is reachable by keyboard,
  // and named after the section it sits in so a screen reader can tell
  // several apart.
  const label =
    context.lastHeadingId === null
      ? ' aria-label="Table"'
      : ` aria-labelledby="${context.lastHeadingId}"`

  return (
    `<div class="table-scroll" role="region" tabindex="0"${label}>\n` +
    `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>\n</div>`
  )
}

// --- Lists -------------------------------------------------------------------

/**
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * Render the list that starts at `start`, with any lists nested inside it.
 *
 * An item owns every following line indented past its marker; a blank line
 * ends the list unless the next line continues an item or starts a sibling.
 * Lines that are not indented and follow an item directly are "lazy"
 * continuations of its text, as in CommonMark.
 *
 * @param {readonly string[]} lines
 * @param {number} start
 * @param {Context} context
 * @returns {{ html: string, next: number }}
 */
function renderList(lines, start, context) {
  const first = LIST_ITEM.exec(lines[start] ?? '')
  const baseIndent = (first?.[1] ?? '').length
  const ordered = /\d/u.test(first?.[2] ?? '')
  const startNumber = ordered ? Number.parseInt(first?.[2] ?? '1', 10) : 1

  /** @type {string[][]} */
  const items = []
  let loose = false
  let index = start

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const item = LIST_ITEM.exec(line)

    if (item && (item[1] ?? '').length === baseIndent) {
      if (/\d/u.test(item[2] ?? '') !== ordered) break
      const contentIndent = baseIndent + (item[2] ?? '').length + (item[3] ?? ' ').length
      /** @type {string[]} */
      const body = [item[4] ?? '']
      index += 1

      while (index < lines.length) {
        const next = lines[index] ?? ''

        if (next.trim() === '') {
          const following = lines[index + 1] ?? ''
          const continues = following.trim() !== '' && indentOf(following) > baseIndent
          const sibling = LIST_ITEM.exec(following)
          const siblingContinues =
            sibling !== null &&
            (sibling[1] ?? '').length === baseIndent &&
            /\d/u.test(sibling[2] ?? '') === ordered
          if (continues || siblingContinues) loose = true
          if (!continues) break
          body.push('')
          index += 1
          continue
        }

        if (indentOf(next) > baseIndent) {
          body.push(next.slice(Math.min(indentOf(next), contentIndent)))
          index += 1
          continue
        }

        if (LIST_ITEM.test(next) || startsBlock(lines, index)) break

        // Lazy continuation of the item's first paragraph.
        body.push(next.trim())
        index += 1
      }

      items.push(body)
      continue
    }

    if (line.trim() === '') {
      index += 1
      continue
    }

    break
  }

  const tag = ordered ? 'ol' : 'ul'
  const startAttribute = ordered && startNumber !== 1 ? ` start="${startNumber}"` : ''
  const rendered = items.map((body) => `<li>${renderBlocks(body, context, !loose)}</li>`).join('\n')

  return { html: `<${tag}${startAttribute}>\n${rendered}\n</${tag}>`, next: index }
}

// --- Inline level ------------------------------------------------------------

/**
 * Is this a link target the site is willing to make?
 *
 * Allowed: https, http and mailto, and references within the site. Refused:
 * everything else, notably `javascript:` and `data:`. A refused link keeps its
 * text and loses its target.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeUrl(url) {
  if (/^(?:https?:\/\/|mailto:)/iu.test(url)) return true
  // No scheme at all: a path, a query or a fragment. `//host` is refused
  // because it is a cross-origin link that looks like a path.
  return !/^[a-z][a-z0-9+.-]*:/iu.test(url) && !url.startsWith('//')
}

/**
 * @param {string} href
 * @param {string} innerHtml
 * @returns {string}
 */
function anchor(href, innerHtml) {
  return `<a href="${escapeHtml(href)}">${innerHtml}</a>`
}

/** Characters that may end a bare URL in prose but are not part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"*_]+$/u

/**
 * Split a bare URL from the punctuation of the sentence it ends.
 *
 * A closing parenthesis is kept only when the URL also contains an opening
 * one, so "(see https://example.com/a)" links to /a, not to "/a)".
 *
 * @param {string} candidate
 * @returns {{ url: string, rest: string }}
 */
function trimUrl(candidate) {
  let url = candidate
  let rest = ''

  for (;;) {
    const punctuation = TRAILING_PUNCTUATION.exec(url)
    if (punctuation) {
      rest = punctuation[0] + rest
      url = url.slice(0, -punctuation[0].length)
      continue
    }
    if (url.endsWith(')') && (url.match(/\(/gu) ?? []).length < (url.match(/\)/gu) ?? []).length) {
      rest = `)${rest}`
      url = url.slice(0, -1)
      continue
    }
    return { url, rest }
  }
}

const PLACEHOLDER = /(\d+)/gu

/**
 * Render one line of inline markdown to HTML.
 *
 * Constructs whose content must not be touched again — code spans, links,
 * escaped characters — are swapped for numbered placeholders as they are
 * found, the remaining text is escaped and given emphasis, and the
 * placeholders are put back last. Escaping happens exactly once, in one
 * place, which is what keeps this safe.
 *
 * @param {string} source
 * @param {{ links?: boolean, emphasis?: boolean }} [options]
 *   `links: false` inside link text (a link cannot contain a link);
 *   `emphasis: false` for plain text such as the licence, where `*` is just
 *   a character.
 * @returns {string}
 */
export function renderInline(source, options = {}) {
  const allowLinks = options.links ?? true
  const allowEmphasis = options.emphasis ?? true

  /** @type {string[]} */
  const held = []
  /** @param {string} html */
  const hold = (html) => `${held.push(html) - 1}`

  let text = source.replace(/[-]/gu, '')

  if (allowEmphasis) {
    // Code spans: content is literal, including backslashes.
    text = text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/gu, (_, _ticks, content) => {
      const inner = String(content)
      // One space of padding on both sides is stripped, as in CommonMark, so
      // `` `x` `` and `` ` x ` `` mean the same.
      const trimmed = /^ [\s\S]*\S[\s\S]* $/u.test(inner) ? inner.slice(1, -1) : inner
      return hold(`<code>${escapeHtml(trimmed)}</code>`)
    })

    // Backslash escapes.
    text = text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/gu, (_, character) =>
      hold(escapeHtml(String(character))),
    )
  }

  if (allowLinks) {
    if (allowEmphasis) {
      // [text](target "optional title") — the title is accepted and ignored.
      // The target may contain one level of balanced parentheses, as in
      // CommonMark, so a ")" inside it does not end the link early.
      text = text.replace(
        /\[([^\]]+)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+"[^"]*")?\s*\)/gu,
        (_, label, target) => {
          const inner = renderInline(String(label), { links: false })
          const href = String(target)
          return hold(isSafeUrl(href) ? anchor(href, inner) : inner)
        },
      )

      // <https://…> and <someone@example.com>
      text = text.replace(/<(https?:\/\/[^\s<>]+)>/gu, (_, url) =>
        hold(anchor(String(url), escapeHtml(String(url)))),
      )
      text = text.replace(/<([^\s<>@]+@[^\s<>@]+\.[a-z]{2,})>/giu, (_, address) =>
        hold(anchor(`mailto:${String(address)}`, escapeHtml(String(address)))),
      )
    }

    // Bare URLs, then bare email addresses.
    text = text.replace(/\bhttps?:\/\/[^\s<>"]+/gu, (match) => {
      const { url, rest } = trimUrl(match)
      return hold(anchor(url, escapeHtml(url))) + rest
    })
    text = text.replace(
      /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gu,
      (address) => hold(anchor(`mailto:${address}`, escapeHtml(address))),
    )
  }

  let html = escapeHtml(text)

  if (allowEmphasis) {
    const word = String.raw`[\p{L}\p{N}_]`
    html = html
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/gu, '<strong>$1</strong>')
      .replace(
        new RegExp(String.raw`(?<!${word})__(?=\S)([\s\S]*?\S)__(?!${word})`, 'gu'),
        '<strong>$1</strong>',
      )
      .replace(/(?<!\*)\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/gu, '<em>$1</em>')
      .replace(
        new RegExp(String.raw`(?<!${word})_(?=\S)([\s\S]*?\S)_(?!${word})`, 'gu'),
        '<em>$1</em>',
      )
      .replace(/~~(?=\S)([\s\S]*?\S)~~/gu, '<del>$1</del>')
  }

  // Held fragments can contain placeholders of their own only if they were
  // built from text that already held some, which the order above prevents;
  // one pass restores everything.
  return html.replace(PLACEHOLDER, (_, number) => held[Number(number)] ?? '')
}

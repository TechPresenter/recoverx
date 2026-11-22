import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { URL } from 'node:url'

/**
 * Checks run on the finished site, on the files as written.
 *
 * Nobody reviews generated HTML, so the build does: a page that is not
 * well-formed renders differently in each browser, a link to a page that does
 * not exist is a dead end for a customer who needed help, and a file written
 * into a path the licence server owns would shadow it on the live host. Any
 * of these fails the build.
 *
 * The HTML check is not a validator. It catches the mistakes templates make —
 * an unclosed or misnested element, a stray `<` or `&`, a duplicate id or
 * attribute, a block element inside a paragraph, a skipped heading level —
 * on markup that is always written with explicit end tags.
 */

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

/** Elements a browser will not keep inside a `<p>`: it closes the paragraph first. */
const CLOSES_PARAGRAPH = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
])

/**
 * Paths the website must never write to. `/v1/`, `/admin/`, `/setup/`,
 * `/order/`, `/healthz` and the root `.htaccess` belong to the PHP licence server in the
 * same public_html; `/downloads/` and `/updates/` hold release files that are
 * uploaded on their own and must never be replaced by a site upload.
 */
export const RESERVED_PATHS = [
  'v1/',
  'admin/',
  'setup/',
  'order/',
  'downloads/',
  'updates/',
  'healthz',
  '.htaccess',
]

/**
 * Links into paths that are published separately from the site (see
 * website/README.md). They cannot be checked against the build output.
 */
export const SEPARATELY_PUBLISHED = ['/downloads/', '/updates/']

const TOKEN =
  /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|<|&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/giu

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu

/**
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) =>
      String.fromCodePoint(Number.parseInt(String(hex), 16)),
    )
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
}

/**
 * @typedef {object} Element
 * @property {string} name
 * @property {Map<string, string>} attributes
 */

/**
 * Walk a document's tags, reporting structural problems. Calls `onElement`
 * for every start tag, with its attributes decoded.
 *
 * @param {string} html
 * @param {(element: Element) => void} [onElement]
 * @returns {string[]}
 */
export function checkWellFormed(html, onElement) {
  /** @type {string[]} */
  const problems = []
  /** @type {string[]} */
  const stack = []
  /** @type {Set<string>} */
  const ids = new Set()
  let headings = 0
  let lastHeading = 0
  let titles = 0
  let mains = 0
  let h1s = 0

  if (!/^<!doctype html>/iu.test(html)) problems.push('does not start with <!doctype html>')

  for (const match of html.matchAll(TOKEN)) {
    const [whole, closing, rawName, rawAttributes, selfClosing] = match
    const line = html.slice(0, match.index).split('\n').length

    if (whole === '<') {
      problems.push(`line ${line}: a "<" that does not start a tag (escape it as &lt;)`)
      continue
    }
    if (whole === '&') {
      problems.push(`line ${line}: a bare "&" (escape it as &amp;)`)
      continue
    }
    if (rawName === undefined) continue // comment or doctype

    const name = rawName.toLowerCase()
    const inSvg = stack.includes('svg') || name === 'svg'

    if (closing === '/') {
      if (VOID_ELEMENTS.has(name)) {
        problems.push(`line ${line}: </${name}> closes a void element`)
        continue
      }
      const open = stack.pop()
      if (open !== name) {
        problems.push(`line ${line}: </${name}> closes <${open ?? 'nothing'}>`)
        if (open !== undefined) stack.push(open)
      }
      continue
    }

    /** @type {Map<string, string>} */
    const attributes = new Map()
    for (const attribute of (rawAttributes ?? '').matchAll(ATTRIBUTE)) {
      const key = (attribute[1] ?? '').toLowerCase()
      if (attributes.has(key)) problems.push(`line ${line}: <${name}> repeats ${key}=`)
      const raw = attribute[2] ?? attribute[3] ?? attribute[4] ?? ''
      if (/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/u.test(raw)) {
        problems.push(`line ${line}: a bare "&" in ${key}= (escape it as &amp;)`)
      }
      attributes.set(key, decodeEntities(raw))
    }

    const id = attributes.get('id')
    if (id !== undefined) {
      if (ids.has(id)) problems.push(`line ${line}: duplicate id="${id}"`)
      ids.add(id)
    }

    if (stack[stack.length - 1] === 'p' && CLOSES_PARAGRAPH.has(name)) {
      problems.push(`line ${line}: <${name}> inside <p> (the browser would close the paragraph)`)
    }
    if (name === 'a' && stack.includes('a')) problems.push(`line ${line}: a link inside a link`)

    // The pages' Content-Security-Policy (lib/layout.mjs) allows the site's
    // own stylesheet and images and nothing else. A browser drops anything
    // more without a word — an inline style, a <style> or <script> element,
    // an onclick — so a page that relies on one looks right in the template
    // and broken on the site. Catch it here instead.
    if (name === 'script' || name === 'style') {
      problems.push(`line ${line}: <${name}> (the Content-Security-Policy blocks it)`)
    }
    for (const key of attributes.keys()) {
      if (key === 'style' || key.startsWith('on')) {
        problems.push(`line ${line}: <${name}> has ${key}= (the Content-Security-Policy blocks it)`)
      }
    }

    const heading = /^h([1-6])$/u.exec(name)
    if (heading) {
      const level = Number(heading[1])
      if (headings > 0 && level > lastHeading + 1) {
        problems.push(
          `line ${line}: <${name}> follows <h${lastHeading}> (a heading level is skipped)`,
        )
      }
      if (headings === 0 && level !== 1)
        problems.push(`line ${line}: the first heading is not an <h1>`)
      if (level === 1) h1s += 1
      headings += 1
      lastHeading = level
    }
    // An SVG's <title> names the drawing, not the page.
    if (name === 'title' && !inSvg) titles += 1
    if (name === 'main') mains += 1
    if (name === 'html' && !attributes.has('lang')) problems.push('<html> has no lang attribute')

    onElement?.({ name, attributes })

    if (selfClosing === '/') {
      if (!inSvg && !VOID_ELEMENTS.has(name)) {
        problems.push(`line ${line}: <${name}/> is not a void element`)
      }
      continue
    }
    if (!VOID_ELEMENTS.has(name)) stack.push(name)
  }

  if (stack.length > 0) problems.push(`unclosed at the end: <${stack.join('> <')}>`)
  if (titles !== 1) problems.push(`has ${titles} <title> elements`)
  if (mains !== 1) problems.push(`has ${mains} <main> elements`)
  if (h1s !== 1) problems.push(`has ${h1s} <h1> elements`)

  return problems
}

/**
 * @param {string} directory
 * @param {string[]} [found]
 * @returns {string[]}
 */
function walk(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) walk(full, found)
    else found.push(full)
  }
  return found
}

/**
 * @typedef {object} SiteReport
 * @property {string[]} problems Each one fails the build.
 * @property {string[]} external External links, for the record.
 * @property {number} internalLinks
 * @property {string[]} pages Root-relative URL of every page.
 */

/**
 * Check the built site in `outDir`.
 *
 * @param {string} outDir
 * @param {string} origin The site's own scheme and host.
 * @returns {SiteReport}
 */
export function verifySite(outDir, origin) {
  /** @type {string[]} */
  const problems = []
  /** @type {Set<string>} */
  const external = new Set()
  /** @type {Map<string, Set<string>>} file → ids */
  const idsByFile = new Map()
  /** @type {Array<{ from: string, url: string }>} */
  const links = []

  const files = walk(outDir).map((file) => relative(outDir, file).split(sep).join('/'))

  for (const file of files) {
    const reserved = RESERVED_PATHS.find((path) =>
      path.endsWith('/') ? file.startsWith(path) : file === path,
    )
    if (reserved !== undefined) problems.push(`${file}: written into reserved path /${reserved}`)
  }

  const htmlFiles = files.filter((file) => file.endsWith('.html'))
  /** @type {string[]} */
  const pages = []
  /** Pages that ask search engines to stay away: they must not be in the sitemap. @type {Set<string>} */
  const noindex = new Set()

  for (const file of htmlFiles) {
    const html = readFileSync(join(outDir, file), 'utf8')
    /** @type {Set<string>} */
    const ids = new Set()
    const pagePath =
      file === 'index.html'
        ? '/'
        : file.endsWith('/index.html')
          ? `/${file.slice(0, -'index.html'.length)}`
          : `/${file}`
    pages.push(pagePath)

    const structural = checkWellFormed(html, (element) => {
      const id = element.attributes.get('id')
      if (id !== undefined) ids.add(id)

      for (const attribute of ['href', 'src']) {
        const value = element.attributes.get(attribute)
        if (value !== undefined) links.push({ from: pagePath, url: value })
      }
      // Absolute URLs of this site in metadata: canonical and Open Graph.
      const content = element.attributes.get('content')
      if (element.name === 'meta' && element.attributes.get('name') === 'robots' && /\bnoindex\b/u.test(content ?? '')) {
        noindex.add(pagePath)
      }
      if (element.name === 'meta' && content?.startsWith(`${origin}/`)) {
        links.push({ from: pagePath, url: content })
      }
    })

    problems.push(...structural.map((problem) => `${file}: ${problem}`))
    idsByFile.set(pagePath, ids)
  }

  // The sitemap and robots.txt are links too.
  const sitemapPath = join(outDir, 'sitemap.xml')
  /** @type {string[]} */
  const sitemapUrls = []
  if (existsSync(sitemapPath)) {
    for (const match of readFileSync(sitemapPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/gu)) {
      const url = decodeEntities(match[1] ?? '')
      sitemapUrls.push(url)
      links.push({ from: '/sitemap.xml', url })
    }
  } else {
    problems.push('sitemap.xml is missing')
  }

  const robotsPath = join(outDir, 'robots.txt')
  if (existsSync(robotsPath)) {
    for (const match of readFileSync(robotsPath, 'utf8').matchAll(/^Sitemap:\s*(\S+)/gmu)) {
      links.push({ from: '/robots.txt', url: match[1] ?? '' })
    }
  } else {
    problems.push('robots.txt is missing')
  }

  let internalLinks = 0

  for (const { from, url } of links) {
    if (url.startsWith('mailto:')) continue

    /** @type {URL} */
    let resolved
    try {
      resolved = new URL(url, `${origin}${from}`)
    } catch {
      problems.push(`${from}: unreadable link "${url}"`)
      continue
    }

    if (resolved.origin !== origin) {
      if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
        problems.push(`${from}: link with a ${resolved.protocol} target: "${url}"`)
      } else {
        if (resolved.protocol === 'http:') problems.push(`${from}: insecure http link "${url}"`)
        external.add(resolved.href)
      }
      continue
    }

    internalLinks += 1
    const path = decodeURIComponent(resolved.pathname)

    if (SEPARATELY_PUBLISHED.some((prefix) => path.startsWith(prefix))) continue

    /** @type {string} */
    let target
    if (path.endsWith('/')) {
      target = `${path}index.html`
    } else if (/\.[a-z0-9]+$/iu.test(path.split('/').pop() ?? '')) {
      target = path
    } else {
      // Apache answers /buy with a redirect to /buy/; a link should not cost
      // the visitor a round trip, and the canonical form is the one indexed.
      problems.push(`${from}: "${url}" should end with "/"`)
      continue
    }

    if (!existsSync(join(outDir, target.slice(1)))) {
      problems.push(`${from}: "${url}" leads nowhere (no ${target.slice(1)} in the build)`)
      continue
    }

    const fragment = decodeURIComponent(resolved.hash.slice(1))
    if (fragment !== '') {
      const ids = idsByFile.get(path)
      if (ids !== undefined && !ids.has(fragment)) {
        problems.push(`${from}: "${url}" points to #${fragment}, which ${path} does not have`)
      }
    }
  }

  // Every indexable page is in the sitemap; a noindex page (the 404, the order
  // form's outcome pages) is not.
  for (const page of pages) {
    const listed = sitemapUrls.includes(`${origin}${page}`)
    if (noindex.has(page) && listed) problems.push(`sitemap.xml lists ${page}, which is noindex`)
    if (!noindex.has(page) && !listed) problems.push(`sitemap.xml does not list ${page}`)
  }

  return { problems, external: [...external].sort(), internalLinks, pages: pages.sort() }
}

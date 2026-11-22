#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { verifySite } from './lib/checks.mjs'
import { ContentError, checkConsistency, readInstaller, readReleases } from './lib/content.mjs'
import { renderPage } from './lib/layout.mjs'
import { countLicenceSections, isMarkdownLicence, renderLicence } from './lib/licence.mjs'
import { faviconSvg, openGraphPng, touchIconPng } from './lib/logo.mjs'
import { countMarkdownHeadings, renderMarkdown } from './lib/markdown.mjs'
import {
  buyPage,
  downloadPage,
  homePage,
  notFoundPage,
  orderErrorPage,
  orderSentPage,
  privacyPage,
  releasesPage,
  supportPage,
  termsPage,
} from './lib/pages.mjs'
import { site } from './site.config.mjs'

/**
 * Build the public website into `dist/website/`.
 *
 *     npm run website:build                 build, then check every page and link
 *     node website/build.mjs --out <dir>    build somewhere else (a preview)
 *     node website/build.mjs --content <dir>
 *                                           read release.json and releases.json from
 *                                           another directory (a preview of a release
 *                                           before its content is committed)
 *     node website/build.mjs --allow-draft  build even though a legal document
 *                                           still reads as a draft — never upload
 *                                           what this produces
 *
 * The output is plain files for the web server's public_html: no server code, no
 * scripts, nothing fetched from anywhere else at run time. What to upload, and
 * where, is in website/README.md.
 *
 * Two pages are not written here but generated from the repository's own
 * documents, so the site can never publish a different text from the one the
 * product ships: /privacy/ from docs/store/privacy-policy.md and /terms/ from
 * LICENSE. Because publishing them makes them binding, the build refuses a
 * document that still carries draft markers or unfilled placeholders.
 *
 * Exit status: 0 when the site was built and every check passed, 1 otherwise.
 */

const WEBSITE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(WEBSITE_DIR)
const DEFAULT_OUT = join(REPO_ROOT, 'dist', 'website')

const PRIVACY_SOURCE = join(REPO_ROOT, 'docs', 'store', 'privacy-policy.md')
const LICENCE_SOURCE = join(REPO_ROOT, 'LICENSE')

/** A problem that stops the build, with the sentence that explains it. */
class BuildError extends Error {}

// --- Arguments -------------------------------------------------------------------

/**
 * @typedef {object} Options
 * @property {string} out
 * @property {string} content Directory holding release.json and releases.json.
 * @property {boolean} allowDraft
 */

/**
 * @param {readonly string[]} argv
 * @returns {Options}
 */
function parseArguments(argv) {
  /** @type {Options} */
  const options = {
    out: DEFAULT_OUT,
    content: join(WEBSITE_DIR, 'content'),
    allowDraft: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]

    if (argument === '--allow-draft') {
      options.allowDraft = true
    } else if ((argument === '--out' || argument === '--content') && value !== undefined) {
      options[argument === '--out' ? 'out' : 'content'] = resolve(value)
      index += 1
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write(
        'Usage: node website/build.mjs [--out <dir>] [--content <dir>] [--allow-draft]\n',
      )
      process.exit(0)
    } else {
      throw new BuildError(`Unknown argument: ${argument ?? ''}. Try --help.`)
    }
  }

  return options
}

// --- Configuration -----------------------------------------------------------------

/**
 * The few things in site.config.mjs that would publish something broken.
 */
function checkConfig() {
  if (!/^https:\/\/[a-z0-9.-]+$/u.test(site.origin)) {
    throw new BuildError(
      `site.origin must be https://host with no trailing slash (got ${site.origin}).`,
    )
  }
  for (const [name, value] of /** @type {const} */ ([
    ['paymentLinkUrl', site.paymentLinkUrl],
    ['storeUrl', site.storeUrl],
  ])) {
    if (value !== null && !/^https:\/\/\S+$/u.test(value)) {
      throw new BuildError(`site.${name} must be an https:// URL or null (got ${value}).`)
    }
  }
  const ids = site.editions.map((edition) => edition.id)
  if (new Set(ids).size !== ids.length) throw new BuildError('site.editions repeats an edition.')
}

// --- Legal documents -----------------------------------------------------------------

/**
 * Refuse to publish a legal document that is not finished.
 *
 * The privacy policy was drafted with `[[…]]` placeholders, a "DRAFT — NOT
 * YET IN FORCE" banner and engineering notes for the reviewer; the Store
 * texts use `{{…}}`. Any of those on the live site would be a published
 * promise nobody made. A link to the domain the product used before
 * recoverx.snapkio.com is refused too: that domain is not the vendor's, and
 * the site must never send a customer there.
 *
 * @param {string} name
 * @param {string} text
 * @returns {string[]}
 */
function draftMarkers(name, text) {
  /** @type {Array<[RegExp, string]>} */
  const markers = [
    [/\[\[[^\]]*\]\]/u, 'an unfilled [[…]] placeholder'],
    [/\{\{[^}]*\}\}/u, 'an unfilled {{…}} placeholder'],
    [/\bDRAFT\b/u, 'the word DRAFT'],
    [/NOT YET IN FORCE/iu, '"not yet in force"'],
    [/Engineering note/iu, 'an engineering note'],
    [/recoverx\.ai\b/iu, 'the product’s former domain, which is not the vendor’s'],
  ]

  return markers.flatMap(([pattern, description]) => {
    const match = pattern.exec(text)
    if (!match) return []
    const line = text.slice(0, match.index).split('\n').length
    return [`${name} line ${line}: ${description} ("${match[0].slice(0, 60)}")`]
  })
}

/**
 * Text that should have been converted but was printed: emphasis markers, a
 * link's brackets. Run on the visible text of the generated page.
 *
 * @param {string} name
 * @param {string} html
 * @returns {string[]}
 */
function leftoverMarkdown(name, html) {
  const text = html
    .replace(/<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/gu, '')
    .replace(/<[^>]+>/gu, ' ')
  /** @type {Array<[RegExp, string]>} */
  const patterns = [
    [/\*\*\S/u, 'unconverted **bold**'],
    [/\]\(/u, 'an unconverted [link](…)'],
    [/^\s*#{1,6}\s/mu, 'an unconverted # heading'],
  ]
  return patterns.flatMap(([pattern, description]) =>
    pattern.test(text) ? [`${name}: ${description} in the generated page`] : [],
  )
}

// --- Output ----------------------------------------------------------------------------

/**
 * Empty the output directory, carefully.
 *
 * `--out` takes any path, and the build deletes what is there. It will only
 * delete the default directory, an empty one, or one that holds a previous
 * build of this site — never, say, a home directory passed by mistake.
 *
 * @param {string} out
 */
function prepareOutput(out) {
  const insideRepo = relative(REPO_ROOT, out)
  if (out === REPO_ROOT || insideRepo === '' || REPO_ROOT.startsWith(out + sep)) {
    throw new BuildError(`Refusing to build into ${out}: it contains the repository.`)
  }
  if (out === WEBSITE_DIR || out.startsWith(WEBSITE_DIR + sep)) {
    throw new BuildError(`Refusing to build into ${out}: that is the website's source.`)
  }

  if (existsSync(out)) {
    const entries = readdirSync(out)
    const previousBuild = entries.includes('index.html') && entries.includes('sitemap.xml')
    if (out !== DEFAULT_OUT && entries.length > 0 && !previousBuild) {
      throw new BuildError(
        `Refusing to empty ${out}: it is not empty and does not look like a previous build of this site.`,
      )
    }
    rmSync(out, { recursive: true, force: true })
  }
  mkdirSync(out, { recursive: true })
}

/**
 * @param {string} out
 * @param {string} file Relative, with forward slashes.
 * @param {string | Buffer} content
 */
function write(out, file, content) {
  const target = join(out, ...file.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

// --- Build ---------------------------------------------------------------------------------

/**
 * @param {Options} options
 */
function build(options) {
  checkConfig()

  const installer = readInstaller(join(options.content, 'release.json'))
  const releases = readReleases(join(options.content, 'releases.json'))
  checkConsistency(installer, releases)

  // --- The two generated documents.
  const privacySource = readFileSync(PRIVACY_SOURCE, 'utf8')
  const licenceSource = readFileSync(LICENCE_SOURCE, 'utf8')

  const drafts = [
    ...draftMarkers('docs/store/privacy-policy.md', privacySource),
    ...draftMarkers('LICENSE', licenceSource),
  ]
  if (drafts.length > 0) {
    const report = drafts.map((line) => `  - ${line}`).join('\n')
    if (!options.allowDraft) {
      throw new BuildError(
        `A legal document is not ready to publish:\n${report}\nFinish it, or preview with --allow-draft (and do not upload that build).`,
      )
    }
    process.stderr.write(
      `WARNING — draft text is being built (--allow-draft). Do not upload:\n${report}\n`,
    )
  }

  const privacy = renderMarkdown(privacySource)
  const licence = renderLicence(licenceSource)

  // "Renders all sections": count the headings in the source independently
  // of the converter, and compare.
  const privacyExpected = countMarkdownHeadings(privacySource)
  if (privacy.headings.length !== privacyExpected) {
    throw new BuildError(
      `privacy policy: the source has ${privacyExpected} headings but ${privacy.headings.length} were rendered.`,
    )
  }
  const licenceExpected = isMarkdownLicence(licenceSource)
    ? countMarkdownHeadings(licenceSource)
    : countLicenceSections(licenceSource) + 1 // + the title
  if (licence.headings.length !== licenceExpected) {
    throw new BuildError(
      `LICENSE: the source has ${licenceExpected} headings (title included) but ${licence.headings.length} were rendered.`,
    )
  }
  for (const [name, document] of /** @type {const} */ ([
    ['privacy policy', privacy],
    ['LICENSE', licence],
  ])) {
    if (document.headings.filter((heading) => heading.level === 1).length !== 1) {
      throw new BuildError(`${name}: must have exactly one top-level title.`)
    }
  }

  // --- Assets. The stylesheet's name carries a hash of its content, so a
  // changed stylesheet is a new URL and no CDN or browser cache can serve a
  // page with yesterday's styles.
  const css = readFileSync(join(WEBSITE_DIR, 'assets', 'site.css'))
  const cssName = `assets/site.${createHash('sha256').update(css).digest('hex').slice(0, 10)}.css`
  const assets = { stylesheet: `/${cssName}` }

  const pages = [
    homePage(site, installer),
    downloadPage(site, installer),
    buyPage(site, installer),
    orderSentPage(site, installer),
    orderErrorPage(site),
    supportPage(site),
    releasesPage(site, releases, installer),
    privacyPage(site, privacy),
    termsPage(site, licence),
    notFoundPage(site),
  ]

  prepareOutput(options.out)

  for (const page of pages) {
    write(options.out, page.file, renderPage(page, site, assets, installer))
  }

  write(options.out, cssName, css)
  write(options.out, 'favicon.svg', faviconSvg())
  write(options.out, 'apple-touch-icon.png', touchIconPng())
  write(options.out, 'og-image.png', openGraphPng())

  write(
    options.out,
    'robots.txt',
    [
      `# ${site.productName} — ${site.origin}/`,
      'User-agent: *',
      // The licence API and the update feed are for the app, not for search.
      'Disallow: /v1/',
      'Disallow: /updates/',
      '',
      `Sitemap: ${site.origin}/sitemap.xml`,
      '',
    ].join('\n'),
  )

  const indexable = pages.filter((page) => page.noindex !== true)
  write(
    options.out,
    'sitemap.xml',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...indexable.map((page) => `  <url><loc>${site.origin}${page.path}</loc></url>`),
      '</urlset>',
      '',
    ].join('\n'),
  )

  // --- Checks, on the files as written.
  const report = verifySite(options.out, site.origin)
  const problems = [
    ...report.problems,
    ...leftoverMarkdown(
      'privacy/index.html',
      readFileSync(join(options.out, 'privacy', 'index.html'), 'utf8'),
    ),
    ...leftoverMarkdown(
      'terms/index.html',
      readFileSync(join(options.out, 'terms', 'index.html'), 'utf8'),
    ),
  ]

  if (problems.length > 0) {
    throw new BuildError(
      `The built site has ${problems.length} problem(s):\n${problems.map((line) => `  - ${line}`).join('\n')}`,
    )
  }

  const shown = relative(process.cwd(), options.out) || '.'
  process.stdout.write(
    [
      `Built ${pages.length} pages into ${shown}`,
      `  pages:     ${report.pages.join('  ')}`,
      `  privacy:   ${privacy.headings.length} headings from docs/store/privacy-policy.md`,
      `  terms:     ${licence.headings.length} headings from LICENSE`,
      `  download:  ${installer === null ? 'no installer published yet (release.json)' : `${installer.version} — ${installer.fileName}`}`,
      `  store:     ${site.storeUrl ?? 'coming soon (storeUrl is null)'}`,
      `  payment:   ${site.paymentLinkUrl ?? 'order form and email (paymentLinkUrl is null)'}`,
      `  checked:   well-formed HTML, ${report.internalLinks} internal links, reserved paths untouched`,
      `  external:  ${report.external.length === 0 ? 'none' : report.external.join('  ')}`,
      '',
    ].join('\n'),
  )
}

try {
  build(parseArguments(process.argv.slice(2)))
} catch (error) {
  if (error instanceof BuildError || error instanceof ContentError) {
    process.stderr.write(`website build failed: ${error.message}\n`)
    process.exit(1)
  }
  throw error
}

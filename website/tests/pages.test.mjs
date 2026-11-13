/* eslint-disable @typescript-eslint/no-floating-promises -- node:test's describe() and it() return promises that the test runner itself awaits. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkWellFormed } from '../lib/checks.mjs'
import { renderPage } from '../lib/layout.mjs'
import { renderMarkdown } from '../lib/markdown.mjs'
import {
  buyPage,
  downloadPage,
  homePage,
  notFoundPage,
  privacyPage,
  releasesPage,
  supportPage,
} from '../lib/pages.mjs'
import { site } from '../site.config.mjs'

/**
 * The page templates, in the states the live configuration cannot show yet:
 * an installer published, the Store listing live, a payment link set. Each
 * one is rendered through the real layout and must pass the same structural
 * checks the build runs, and say what the design says it says.
 */

/** @typedef {import('../lib/content.mjs').Installer} Installer */
/** @typedef {import('../site.config.mjs').SiteConfig} SiteConfig */
/** @typedef {import('../lib/layout.mjs').Page} Page */

/** @type {Installer} */
const INSTALLER = {
  version: '1.2.0',
  fileName: 'RecoverX-Setup-1.2.0-x64.exe',
  sha256: 'a'.repeat(64),
  size: 96_808_960,
  date: '2026-12-01',
}

const ASSETS = { stylesheet: '/assets/site.test.css' }

/** @type {SiteConfig} */
const LIVE = {
  ...site,
  storeUrl: 'https://apps.microsoft.com/detail/xp0000000000',
  paymentLinkUrl: 'https://rzp.io/l/recoverx',
}

/**
 * @param {Page} page
 * @param {SiteConfig} config
 * @param {Installer | null} installer
 */
function render(page, config, installer) {
  const html = renderPage(page, config, ASSETS, installer)
  assert.deepEqual(checkWellFormed(html), [], `${page.path} is not well-formed`)
  return html
}

describe('pages before the first release', () => {
  it('never offers a download that does not exist', () => {
    const home = render(homePage(site, null), site, null)
    assert.match(home, /Download — coming soon/u)
    assert.doesNotMatch(home, />Download free</u)
    assert.match(home, /class="btn btn-primary btn-sm" href="\/download\/">.*Coming soon<\/a>/u)

    const download = render(downloadPage(site, null), site, null)
    assert.match(download, /The first release is being prepared/u)
    assert.doesNotMatch(download, /\/downloads\/win\//u)
  })

  it('announces the Store and sells by email only', () => {
    const buy = render(buyPage(site, null), site, null)
    assert.match(buy, /Microsoft Store: coming soon/u)
    assert.doesNotMatch(buy, /Pay online/u)
    assert.equal((buy.match(/<\/svg>Buy by email<\/a>/gu) ?? []).length, 3)
  })
})

describe('pages once everything is live', () => {
  it('links the installer, its size and its checksum', () => {
    const download = render(downloadPage(LIVE, INSTALLER), LIVE, INSTALLER)
    assert.match(download, /href="\/downloads\/win\/1\.2\.0\/RecoverX-Setup-1\.2\.0-x64\.exe"/u)
    assert.match(download, /Download for Windows · v1\.2\.0 · 92\.3 MB/u)
    assert.match(download, new RegExp(INSTALLER.sha256, 'u'))
    assert.match(download, /Get it from the Microsoft Store/u)
    assert.doesNotMatch(download, /Coming soon to the Microsoft Store/u)

    const home = render(homePage(LIVE, INSTALLER), LIVE, INSTALLER)
    assert.match(home, />Download free</u)
    assert.match(home, /href="https:\/\/apps\.microsoft\.com\/detail\/xp0000000000"/u)
  })

  it('offers the payment link on /buy/ only, with email as the fallback', () => {
    const buy = render(buyPage(LIVE, INSTALLER), LIVE, INSTALLER)
    assert.equal((buy.match(/href="https:\/\/rzp\.io\/l\/recoverx"/gu) ?? []).length, 4)
    assert.equal((buy.match(/class="alt-link"[^>]*>Buy by email</gu) ?? []).length, 3)

    const home = render(homePage(LIVE, INSTALLER), LIVE, INSTALLER)
    assert.doesNotMatch(home, /rzp\.io/u)
  })

  it('marks the published version on the release notes', () => {
    const releases = [
      { version: '1.2.0', date: '2026-12-01', title: 'Second', notes: ['A note.'] },
      { version: '1.1.0', date: '2026-11-20', title: 'First', notes: ['Another note.'] },
    ]
    const html = render(releasesPage(LIVE, releases, INSTALLER), LIVE, INSTALLER)
    assert.equal((html.match(/class="release pick"/gu) ?? []).length, 1)
    assert.match(html, /Download v1\.2\.0/u)
  })
})

describe('every page', () => {
  it('builds its pricing cards from the configuration', () => {
    const home = render(homePage(site, null), site, null)
    for (const edition of site.editions) {
      if (edition.priceInr !== null && edition.priceInr > 0) {
        assert.match(home, new RegExp(`₹${edition.priceInr.toLocaleString('en-IN')}`, 'u'))
      }
    }
    assert.match(home, new RegExp(`${site.moveAllowance.limit}× a year`, 'u'))
  })

  it('names the product without "AI", and marks one current page', () => {
    const privacy = renderMarkdown(
      '# Policy\n\n**Last updated:** 1 January 2026\n\n## One\n\nText.',
    )
    for (const [page, current] of /** @type {const} */ ([
      [homePage(site, null), null],
      [buyPage(site, null), 'Pricing'],
      [supportPage(site), 'Support'],
      [privacyPage(site, privacy), null],
      [notFoundPage(site), null],
    ])) {
      const html = render(page, site, null)
      // "AI" as a word anywhere in the text — the product name included.
      assert.doesNotMatch(html, /\bAI\b(?![^<]*")/u, page.path)
      const marked = [...html.matchAll(/<a href="[^"]*" aria-current="page">([^<]*)</gu)].map(
        (match) => match[1],
      )
      if (current !== null) assert.ok(marked.includes(current), `${page.path}: ${marked.join(',')}`)
    }
  })

  it('lifts a legal document’s title and date into the hero', () => {
    const privacy = renderMarkdown(
      '# Policy\n\n**Last updated:** 1 January 2026\n\n## One\n\nText.',
    )
    const html = render(privacyPage(site, privacy), site, null)
    assert.equal((html.match(/<h1\b/gu) ?? []).length, 1)
    assert.match(html, /<h1 id="policy">Policy<\/h1>/u)
    assert.match(html, /Last updated 1 January 2026/u)
    assert.doesNotMatch(html, /<strong>Last updated:<\/strong>/u)
  })
})

/* eslint-disable @typescript-eslint/no-floating-promises -- node:test's describe() and it() return promises that the test runner itself awaits. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { URL, fileURLToPath } from 'node:url'
import { checkWellFormed } from '../lib/checks.mjs'
import { readJson } from '../lib/content.mjs'
import { renderPage } from '../lib/layout.mjs'
import { renderMarkdown } from '../lib/markdown.mjs'
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

/** Nothing published yet, whatever the live configuration says today. @type {SiteConfig} */
const BEFORE = {
  ...site,
  storeUrl: null,
  paymentLinkUrl: null,
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
    const home = render(homePage(BEFORE, null), BEFORE, null)
    assert.match(home, /Download — coming soon/u)
    assert.doesNotMatch(home, />Download free</u)
    assert.match(home, /class="btn btn-primary btn-sm" href="\/download\/">.*Coming soon<\/a>/u)

    const download = render(downloadPage(BEFORE, null), BEFORE, null)
    assert.match(download, /The first release is being prepared/u)
    assert.doesNotMatch(download, /\/downloads\/win\//u)
  })

  it('announces the Store and sells by email only', () => {
    const buy = render(buyPage(BEFORE, null), BEFORE, null)
    assert.match(buy, /Microsoft Store: coming soon/u)
    assert.doesNotMatch(buy, /Pay online/u)
    assert.equal(
      (
        buy.match(
          /href="\/buy\/#order"><svg[^>]*><use href="#i-arrow"\/?><\/use>?<\/svg>Order<\/a>|href="\/buy\/#order"><svg[^>]*>.*?<\/svg>Order<\/a>/gu,
        ) ?? []
      ).length,
      3,
    )
    assert.doesNotMatch(buy, /Buy by email/u)
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
    // While the installer is unsigned, the SmartScreen note offers the Store copy, which Microsoft signs.
    assert.match(
      download,
      /Or install RecoverX from the <a href="https:\/\/apps\.microsoft\.com\/detail\/xp0000000000">Microsoft Store<\/a> instead/u,
    )
    const signed = render(
      downloadPage({ ...LIVE, installerCodeSigned: true }, INSTALLER),
      { ...LIVE, installerCodeSigned: true },
      INSTALLER,
    )
    assert.doesNotMatch(signed, /SmartScreen/u)

    const home = render(homePage(LIVE, INSTALLER), LIVE, INSTALLER)
    assert.match(home, />Download free</u)
    assert.match(home, /href="https:\/\/apps\.microsoft\.com\/detail\/xp0000000000"/u)
  })

  it('offers the payment link on /buy/ only, with email as the fallback', () => {
    const buy = render(buyPage(LIVE, INSTALLER), LIVE, INSTALLER)
    assert.equal((buy.match(/href="https:\/\/rzp\.io\/l\/recoverx"/gu) ?? []).length, 4)
    assert.equal((buy.match(/class="alt-link"[^>]*>Order with the form</gu) ?? []).length, 3)

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

/** The licence server's list of calling codes, which the form must offer exactly. */
const CALLING_CODES = /** @type {Record<string, string>} */ (
  readJson(
    fileURLToPath(new URL('../../server-php/app/src/Order/calling-codes.json', import.meta.url)),
  )
)

/**
 * The start tag of the one form control with this name.
 *
 * @param {string} html
 * @param {string} name
 */
function control(html, name) {
  const tags =
    html.match(new RegExp(`<(?:input|select|textarea)\\b[^>]*\\bname="${name}"[^>]*>`, 'gu')) ?? []
  assert.equal(tags.length, 1, `one control named ${name}`)
  return /** @type {string} */ (tags[0])
}

/** @param {string} text */
function unescapeHtml(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

describe('the order form', () => {
  it('posts every field the licence server expects to /order/, with a hidden trap field', () => {
    const buy = render(buyPage(site, null), site, null)
    assert.match(buy, /<form class="order-form" method="post" action="\/order\/"/u)
    for (const name of [
      'edition',
      'quantity',
      'name',
      'email',
      'phoneCountry',
      'phone',
      'registerTo',
      'gstin',
      'message',
      'nectar',
    ]) {
      assert.match(buy, new RegExp(`name="${name}"`, 'u'), `field ${name}`)
    }
    for (const id of ['professional', 'business', 'technician', 'enterprise']) {
      assert.match(buy, new RegExp(`name="edition" value="${id}"`, 'u'), `edition ${id}`)
    }
    assert.doesNotMatch(buy, /name="edition" value="free"/u)
    assert.match(buy, /<div class="order-trap" aria-hidden="true">/u)
    assert.match(buy, /id="order"/u)
  })

  it('requires the name, the email and the mobile number with its country code', () => {
    const buy = render(buyPage(site, null), site, null)
    for (const name of ['name', 'email', 'phoneCountry', 'phone']) {
      assert.match(control(buy, name), /\srequired[\s>]/u, `${name} is required`)
    }
    for (const name of ['registerTo', 'gstin', 'message']) {
      assert.doesNotMatch(control(buy, name), /\srequired[\s>]/u, `${name} is optional`)
    }

    const phone = control(buy, 'phone')
    assert.match(phone, /\stype="tel"/u)
    assert.match(phone, /\sautocomplete="tel-national"/u)
    assert.match(phone, /\smaxlength="20"/u)
    // The visible label names the number; the list has a label of its own.
    assert.match(buy, /<label for="order-phone">Mobile number<\/label>/u)
    assert.match(buy, /<label class="sr-only" for="order-phone-country">Country code<\/label>/u)
    assert.match(control(buy, 'phoneCountry'), /\sid="order-phone-country"/u)
    assert.doesNotMatch(buy, /Phone <span class="opt">/u)
  })

  it('offers every country in the licence server’s list, with India selected', () => {
    const buy = render(buyPage(site, null), site, null)
    const select = /<select\b[^>]*\bname="phoneCountry"[^>]*>([\s\S]*?)<\/select>/u.exec(buy)
    assert.ok(select, 'the country code list')
    const options = [
      ...(select[1] ?? '').matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/gu),
    ]
    assert.equal(
      (select[1] ?? '').match(/<option\b/gu)?.length,
      options.length,
      'every option is plain',
    )

    const values = options.map((option) => option[1] ?? '')
    assert.deepEqual([...values].sort(), Object.keys(CALLING_CODES).sort())
    assert.equal(new Set(values).size, values.length, 'no country twice')

    const selected = options.filter((option) => option[2] !== undefined).map((option) => option[1])
    assert.deepEqual(selected, ['IN'])

    const labels = options.map((option) => unescapeHtml(option[3] ?? ''))
    options.forEach((option, index) => {
      const code = CALLING_CODES[option[1] ?? '']
      assert.ok(labels[index]?.endsWith(` (+${code})`), `${option[1]}: ${labels[index]}`)
    })
    assert.ok(labels.includes('India (+91)'))
    const names = labels.map((label) => label.replace(/ \(\+[0-9]+\)$/u, ''))
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b, 'en')),
      'sorted by name',
    )
  })

  it('checks the number the way the licence server does, in the browser’s own regex mode', () => {
    const buy = render(buyPage(site, null), site, null)
    const pattern = /\spattern="([^"]*)"/u.exec(control(buy, 'phone'))?.[1]
    assert.ok(pattern !== undefined, 'the phone field has a pattern')
    // Browsers compile `pattern` as ^(?:…)$ with the v flag; a pattern that does not compile is ignored.
    const check = new RegExp(`^(?:${unescapeHtml(pattern)})$`, 'v')
    for (const good of ['98765 43210', '(020) 7946-0958', '9876543210', '1234']) {
      assert.ok(check.test(good), `accepts ${good}`)
    }
    for (const bad of ['+91 98765', 'abc', '123', '1'.repeat(21), '98765\t43210']) {
      assert.ok(!check.test(bad), `rejects ${bad}`)
    }
  })

  it('lets pages post a form to their own origin only', () => {
    const buy = render(buyPage(site, null), site, null)
    assert.match(buy, /form-action &#39;self&#39;/u)
  })

  it('renders the two outcome pages, kept out of search', () => {
    for (const page of [orderSentPage(site, INSTALLER), orderErrorPage(site)]) {
      const html = render(page, site, INSTALLER)
      assert.match(html, /<meta name="robots" content="noindex">/u)
    }
    assert.match(render(orderErrorPage(site), site, null), /href="\/buy\/#order"/u)
  })
})

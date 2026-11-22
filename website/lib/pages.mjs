import { DEFAULT_PHONE_COUNTRY, PHONE_PATTERN, phoneCountries } from './calling-codes.mjs'
import { markup, trusted } from './html.mjs'
import { installerPath } from './content.mjs'
import { icon } from './layout.mjs'
import { inlineLogo } from './logo.mjs'

/**
 * The pages, as content.
 *
 * Every statement about what RecoverX does is something the code does,
 * checked against docs/store/listing.en-US.md (which was itself checked
 * against the code) and against the modules named beside each section. Store
 * Policy 10.1.1 forbids claiming what the product does not do, and the same
 * standard applies here, because this site is where the Store listing sends
 * people. In particular: nothing in the product is machine learning, so no
 * page claims an "AI" feature; and no page promises that a file can be
 * recovered. No testimonials, ratings, download counts or "most popular"
 * either — there are none to report.
 *
 * The look is the approved "Night & Paper" design: each page opens on a dark
 * night hero and continues on paper that follows the visitor's colour scheme.
 * The class names are the design's (assets/site.css).
 *
 * When a feature changes, change the claim here in the same commit.
 */

/** @typedef {import('./html.mjs').Html} Html */
/** @typedef {import('./layout.mjs').Page} Page */
/** @typedef {import('../site.config.mjs').SiteConfig} SiteConfig */
/** @typedef {import('../site.config.mjs').Edition} Edition */
/** @typedef {import('./content.mjs').Installer} Installer */
/** @typedef {import('./content.mjs').Release} Release */
/** @typedef {import('./markdown.mjs').RenderedDocument} RenderedDocument */

// --- Formatting -----------------------------------------------------------------

const RUPEES = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

/** @param {number} amount */
export function formatInr(amount) {
  return RUPEES.format(amount)
}

const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

/** @param {string} isoDate `YYYY-MM-DD` */
export function formatDate(isoDate) {
  return LONG_DATE.format(new Date(`${isoDate}T00:00:00Z`))
}

/**
 * Sizes in the units Windows Explorer uses (1 MB = 1,048,576 bytes), so the
 * figure on the page is the figure the customer sees in their Downloads
 * folder.
 *
 * @param {number} bytes
 */
export function formatSize(bytes) {
  const megabytes = bytes / (1024 * 1024)
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

/**
 * Where every "Order" button leads: the order form on /buy/, which posts to
 * the licence server's /order/ (server-php/app/src/Order/OrderForm.php).
 */
const ORDER_FORM = '/buy/#order'

/**
 * The order form. No script: the browser checks the fields, the server checks
 * them again, and the answer is a redirect to /buy/sent/ or /buy/error/. The
 * field names, limits and edition ids must match OrderForm.php; the mobile
 * number's country list is the server's own (lib/calling-codes.mjs).
 *
 * @param {SiteConfig} site
 * @returns {Html}
 */
function orderForm(site) {
  const choices = site.editions
    .filter((edition) => edition.id !== 'free')
    .map(
      (edition) => markup`<label class="order-choice">
<input type="radio" name="edition" value="${edition.id}" required>
<span class="order-choice-text"><b>${edition.name}</b><span>${edition.priceInr === null ? 'Price on request' : `${formatInr(edition.priceInr)} / year`} · ${edition.computers}</span></span>
</label>`,
    )

  const countries = phoneCountries().map(
    (country) =>
      markup`<option value="${country.iso}"${country.iso === DEFAULT_PHONE_COUNTRY && markup` selected`}>${country.name} (+${country.dial})</option>`,
  )

  return markup`<form class="order-form" method="post" action="/order/" accept-charset="utf-8">
<fieldset class="order-editions">
<legend>Edition</legend>
${choices}
</fieldset>
<div class="order-grid">
<div class="field"><label for="order-name">Your name</label><input id="order-name" name="name" type="text" maxlength="200" autocomplete="name" required></div>
<div class="field"><label for="order-email">Email for the licence key</label><input id="order-email" name="email" type="email" maxlength="254" autocomplete="email" required></div>
<div class="field"><label for="order-phone">Mobile number</label><div class="phone-row"><label class="sr-only" for="order-phone-country">Country code</label><select id="order-phone-country" name="phoneCountry" required>
${countries}
</select><input id="order-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="20" pattern="${PHONE_PATTERN}" required title="Digits only — choose the country code from the list"></div></div>
<div class="field"><label for="order-quantity">Number of licences</label><input id="order-quantity" name="quantity" type="number" inputmode="numeric" min="1" max="100" value="1" required></div>
<div class="field"><label for="order-register">Register the licence to <span class="opt">(optional)</span></label><input id="order-register" name="registerTo" type="text" maxlength="200" placeholder="You or your organisation"></div>
<div class="field"><label for="order-gstin">GSTIN for the invoice <span class="opt">(optional)</span></label><input id="order-gstin" name="gstin" type="text" maxlength="15" pattern="[0-9A-Za-z]{15}" title="15 letters and digits"></div>
</div>
<div class="field"><label for="order-message">Message <span class="opt">(optional)</span></label><textarea id="order-message" name="message" rows="4" maxlength="2000"></textarea></div>
<div class="order-trap" aria-hidden="true"><label for="order-nectar">Leave this field empty</label><input id="order-nectar" name="nectar" type="text" tabindex="-1" autocomplete="off"></div>
<p class="order-note">We use these details only to send you payment details and your licence — see the <a href="/privacy/">privacy policy</a>.</p>
<button class="btn btn-primary" type="submit">${icon('arrow')}Send order request</button>
</form>
<p class="order-alt">Prefer email? Write to <a href="mailto:${site.email}">${site.email}</a> with the edition and the number of licences.</p>`
}

/**
 * What a button that leads to /download/ may promise. Until an installer is
 * published, the page it leads to says the release is being prepared, and
 * a button saying "Download" would be the first thing on the site that is
 * not true. The button keeps its look and its target either way.
 *
 * @param {Installer | null} installer
 * @param {string} available
 * @param {string} [unavailable] A shorter label, for a narrow button.
 */
function downloadLabel(installer, available, unavailable = 'Download — coming soon') {
  return installer === null ? unavailable : available
}

// --- Shared fragments ---------------------------------------------------------------

/**
 * The night band every page but home opens with.
 *
 * @param {object} options
 * @param {string} options.kicker
 * @param {Html | string} options.title
 * @param {string} [options.titleId]
 * @param {Html | string | null} [options.lead]
 * @param {string | null} [options.meta]
 * @param {Html | null} [options.extra] Buttons, a pill or a contact chip under the lead.
 * @param {boolean} [options.compact] The legal pages' shorter hero.
 * @returns {Html}
 */
function pageHero({ kicker, title, titleId = 'page-title', lead, meta, extra, compact = false }) {
  return markup`<section class="page-hero night${compact ? ' compact' : ''}" aria-labelledby="${titleId}">
<div class="wrap">
<span class="kicker">${kicker}</span>
<h1 id="${titleId}">${title}</h1>
${lead && markup`<p class="lead">${lead}</p>`}
${meta && markup`<p class="hero-meta">${meta}</p>`}
${extra}
</div>
</section>`
}

/**
 * The calm "good to know" panel the disclaimers live in. Never amber or red:
 * these are facts about data recovery, not alarms.
 *
 * @param {object} options
 * @param {string} options.id Id of the panel's heading.
 * @param {2 | 3} options.level Heading level, to fit the page's outline.
 * @param {string} options.title
 * @param {string | null} [options.note] Right-aligned beside the title on wide screens.
 * @param {ReadonlyArray<readonly [string, Html | string]>} options.items Lead-in and sentence.
 * @param {string} [options.panelId] An id for the panel itself, for a table of contents.
 * @returns {Html}
 */
function knowPanel({ id, level, title, note, items, panelId }) {
  return markup`<aside class="know"${panelId === undefined ? null : markup` id="${panelId}"`} aria-labelledby="${id}">
<div class="know-h">${icon('info')}<h${level} id="${id}">${title}</h${level}>${note && markup`<span>${note}</span>`}</div>
<ul class="know-items">
${items.map(([lead, text]) => markup`<li><strong>${lead}</strong><span>${text}</span></li>`)}
</ul>
</aside>`
}

/**
 * The warnings every customer should read before starting, in full. From the
 * Store listing's "Important — please read before you start", which is where
 * the vendor committed to them. The home page carries a shorter four.
 *
 * @param {SiteConfig} site
 * @returns {ReadonlyArray<readonly [string, string]>}
 */
function disclaimers(site) {
  return [
    [
      'Lost files on C:? Install on another PC.',
      `Installing anything on the drive the files were lost from — ${site.productName} included — can overwrite them. If you can, install it on a different computer and connect the drive to it.`,
    ],
    [
      'Results aren’t guaranteed.',
      'No recovery tool can promise a file back. It depends on what has happened to the drive since the file was lost.',
    ],
    [
      'Stop using the drive.',
      'Every file written to it — downloads, updates, even installing software — can overwrite deleted data permanently.',
    ],
    [
      'SSDs are different.',
      'Solid-state drives that support TRIM usually erase deleted data within moments, so recovering deleted files from them is often impossible. Hard disks, USB drives and memory cards give far better odds.',
    ],
    ['Overwritten data is gone.', 'No software can recover data that has been written over.'],
  ]
}

/**
 * The Microsoft Store, linked once Partner Center has published the listing
 * (`storeUrl`), announced until then.
 *
 * @param {SiteConfig} site
 * @param {'paper' | 'night'} surface
 * @returns {Html}
 */
function storeButton(site, surface) {
  if (site.storeUrl === null) {
    return markup`<p class="store-line">${icon('info')}Coming soon to the Microsoft Store</p>`
  }
  return markup`<a class="btn ${surface === 'night' ? 'btn-ghost' : 'btn-outline'}" href="${site.storeUrl}">Get it from the Microsoft Store</a>`
}

/**
 * The same, inside a sentence.
 *
 * @param {SiteConfig} site
 * @param {string} soon
 * @returns {Html | string}
 */
function storeText(site, soon) {
  return site.storeUrl === null
    ? soon
    : markup`<a href="${site.storeUrl}">Get it from the Microsoft Store</a>`
}

/**
 * The Free edition's strip, above the paid cards.
 *
 * @param {Installer | null} installer
 * @returns {Html}
 */
function freeStrip(installer) {
  return markup`<div class="free">
<div class="free-name"><h3>Free</h3><span class="price">${formatInr(0)}</span></div>
<ul>
<li>${icon('check')}Unlimited scanning and preview</li>
<li>${icon('check')}Recover up to 1&nbsp;GB in total</li>
<li>${icon('check')}No key, no account</li>
</ul>
<a class="btn btn-outline" href="/download/">${icon('download')}${downloadLabel(installer, 'Download free', 'Coming soon')}</a>
</div>`
}

/**
 * The paid editions as cards. The rows come from site.config.mjs, so a
 * changed price or allowance changes every page at once.
 *
 * Seats and commercial use: ENTITLEMENTS in src/shared/types/license.ts
 * (Professional is the one paid edition without commercial use; Free has
 * none either, and LICENSE section 1 says the same). Moves: the
 * self-service release cap in src/server/authority.ts, which licences with
 * unlimited computers never reach.
 *
 * @param {SiteConfig} site
 * @param {{ payOnline: boolean }} options `payOnline` only on /buy/, and only
 *   while `paymentLinkUrl` is set.
 * @returns {Html}
 */
function plans(site, { payOnline }) {
  const { limit, windowDays } = site.moveAllowance
  const per = windowDays === 365 ? 'a year' : `in ${windowDays} days`

  const cards = site.editions
    .filter((edition) => edition.id !== 'free')
    .map((edition) => {
      const pick = edition.id === 'professional'
      const enterprise = edition.priceInr === null
      const primary = pick ? 'btn-primary' : 'btn-outline'

      /** @type {Html} */
      let action
      if (enterprise) {
        action = markup`<a class="btn btn-outline btn-block" href="${ORDER_FORM}">${icon('chat')}Ask for a quote</a>`
      } else if (payOnline && site.paymentLinkUrl !== null) {
        action = markup`<a class="btn ${primary} btn-block" href="${site.paymentLinkUrl}">Pay online</a>
<a class="alt-link" href="${ORDER_FORM}">Order with the form</a>`
      } else {
        action = markup`<a class="btn ${primary} btn-block" href="${ORDER_FORM}">${icon('arrow')}Order</a>`
      }

      return markup`<article class="plan${pick ? ' pick' : ''}" aria-labelledby="plan-${edition.id}">
${pick && markup`<span class="badge">Best for most people</span>`}
<h3 id="plan-${edition.id}">${edition.name}</h3>
<p class="for">${edition.tagline}</p>
${
  edition.priceInr === null
    ? markup`<p class="amount req"><b>Custom</b></p>`
    : markup`<p class="amount"><b>${formatInr(edition.priceInr)}</b><span>/ year</span></p>`
}
<dl class="specs">
<div><dt>Computers</dt><dd>${edition.computers.replace(/^Unlimited PCs$/u, 'Unlimited')}</dd></div>
<div><dt>Recovery</dt><dd>Unlimited</dd></div>
<div><dt>Commercial use</dt>${edition.id === 'professional' ? markup`<dd class="no">No</dd>` : markup`<dd>${icon('check')}<span class="sr-only">Yes</span></dd>`}</div>
<div><dt>Move to a new PC</dt><dd>${edition.selfServiceMoves ? `${limit}× ${per}` : 'No limit'}</dd></div>
</dl>
${action}
</article>`
    })

  return markup`<div class="plans">
${cards}
</div>`
}

/** @returns {Html} */
function buySteps() {
  return markup`<ol class="buy-steps" aria-label="How buying works">
<li><span class="n" aria-hidden="true">1</span>Send the order form</li>
<li><span class="n" aria-hidden="true">2</span>We email you how to pay</li>
<li><span class="n" aria-hidden="true">3</span>Your licence key arrives by email</li>
</ol>`
}

/**
 * @param {SiteConfig} site
 * @param {Html} link
 * @returns {Html}
 */
function priceNote(site, link) {
  return markup`<p class="price-note">Prices in Indian rupees, per licence, for one year. ${storeText(site, 'Microsoft Store: coming soon.')} ${link}</p>`
}

/**
 * The closing band: the mark, one line, and the way in.
 *
 * @param {SiteConfig} site
 * @param {Installer | null} installer
 * @param {{ href: string, label: string }} secondary
 * @returns {Html}
 */
function finalCta(site, installer, secondary) {
  return markup`<section class="cta night" aria-labelledby="cta-title">
<div class="wrap">
${inlineLogo('logo-cta', 64, 'cta-mark')}
<h2 id="cta-title">See what can still be saved.</h2>
<p>Scan and preview for free. Recover up to 1&nbsp;GB before you decide on a licence.</p>
<div class="cta-row">
<a class="btn btn-primary" href="/download/">${icon('download')}${downloadLabel(installer, 'Download free')}</a>
<a class="btn btn-ghost" href="${secondary.href}">${secondary.label}</a>
</div>
<small>Windows 10 (21H2+) and Windows 11 · 64-bit · ${storeText(site, 'Coming soon to the Microsoft Store')}</small>
</div>
</section>`
}

/**
 * A page-local table of contents. Rendered twice — a disclosure on phones,
 * a sticky list beside the text on wider screens — and the stylesheet shows
 * one, so neither needs a script.
 *
 * @param {ReadonlyArray<{ id: string, text: string }>} entries
 * @returns {Html}
 */
function tableOfContents(entries) {
  const items = markup`<ol>
${entries.map((entry) => markup`<li><a href="#${entry.id}">${entry.text}</a></li>`)}
</ol>`
  return markup`<details class="toc toc-compact">
<summary>On this page</summary>
<nav aria-label="On this page (compact)">${items}</nav>
</details>
<nav class="toc toc-wide" aria-label="On this page">
<p class="toc-title">On this page</p>
${items}
</nav>`
}

// --- The product window ---------------------------------------------------------------

/**
 * The hero's illustration of the app, drawn in SVG: one drawing for wide
 * screens and a separate, simpler one for phones, so its text stays legible.
 * It is an illustration, labelled as one, not a screenshot — but it shows
 * only what the app really has: the recoverability grades src/main/scan
 * gives (Excellent, Good, Fair, Poor, Unknown), a destination on another
 * drive, and a Free allowance no larger than 1 GB. Keep it that way.
 *
 * Backslashes in the paths are doubled: this is a JavaScript template.
 */
const PRODUCT_WINDOW = markup`<div class="window">
<svg class="win-d" viewBox="0 0 1120 696" role="img" aria-labelledby="win-title">
  <title id="win-title">Illustration of the RecoverX app: a quick scan of an external drive at 64 percent, with found files graded Excellent, Good, Fair, Poor or Unknown, a preview of a photo, and a button to recover 4 files to drive D.</title>
  <defs>
    <linearGradient id="w-grad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4C7DF0"/><stop offset="1" stop-color="#8A5CF0"/></linearGradient>
    <linearGradient id="w-shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="w-logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B6FE0"/><stop offset="1" stop-color="#7C4DE8"/></linearGradient>
    <linearGradient id="w-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B2C7A"/><stop offset=".55" stop-color="#6A3FB5"/><stop offset="1" stop-color="#F2A065"/></linearGradient>
    <clipPath id="w-bar"><rect x="250" y="166" width="540" height="8" rx="4"/></clipPath>
    <clipPath id="w-thumb"><rect x="840" y="244" width="240" height="150" rx="8"/></clipPath>
  </defs>

  <rect x="0" y="0" width="1120" height="44" fill="rgba(255,255,255,.035)"/>
  <rect x="16" y="12" width="20" height="20" rx="4.5" fill="url(#w-logo)"/>
  <path d="M21.6 16H30.4L30.7 19.7A4.7 8.7 0 0 1 26 28.4A4.7 8.7 0 0 1 21.3 19.7Z" fill="#fff"/>
  <text x="46" y="27" font-size="13" font-weight="600" fill="#E6EBFF">RecoverX</text>
  <text x="560" y="27" font-size="12" fill="#8F9BC4" text-anchor="middle">Free edition</text>
  <path d="M1000 22.5h10" stroke="#A9B3D6" stroke-width="1.2"/>
  <rect x="1045.5" y="17.5" width="10" height="10" rx="1.5" fill="none" stroke="#A9B3D6" stroke-width="1.2"/>
  <path d="M1091 17.5l9 9M1100 17.5l-9 9" stroke="#A9B3D6" stroke-width="1.2"/>
  <path d="M0 44.5H1120" stroke="rgba(255,255,255,.08)"/>

  <rect x="0" y="45" width="208" height="651" fill="rgba(255,255,255,.022)"/>
  <path d="M208.5 45V696" stroke="rgba(255,255,255,.07)"/>
  <text x="22" y="76" font-size="10.5" font-weight="600" letter-spacing="1.2" fill="#7F8AB3">RECOVER</text>
  <rect x="10" y="88" width="188" height="36" rx="8" fill="rgba(126,164,255,.14)"/>
  <rect x="10" y="97" width="3" height="18" rx="1.5" fill="url(#w-grad)"/>
  <use href="#i-search" x="24" y="98" width="16" height="16" fill="none" stroke="#B9CBFF" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="50" y="111" font-size="13.5" font-weight="600" fill="#FFFFFF">Scan</text>
  <use href="#i-list" x="24" y="134" width="16" height="16" fill="none" stroke="#8F9BC4" stroke-width="1.9" stroke-linecap="round"/>
  <text x="50" y="147" font-size="13.5" fill="#B7C1E2">Results</text>
  <use href="#i-history" x="24" y="170" width="16" height="16" fill="none" stroke="#8F9BC4" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="50" y="183" font-size="13.5" fill="#B7C1E2">History</text>
  <text x="22" y="224" font-size="10.5" font-weight="600" letter-spacing="1.2" fill="#7F8AB3">DISKS</text>
  <use href="#i-drive" x="24" y="238" width="16" height="16" fill="none" stroke="#8F9BC4" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="50" y="251" font-size="13.5" fill="#B7C1E2">Devices</text>
  <use href="#i-layers" x="24" y="274" width="16" height="16" fill="none" stroke="#8F9BC4" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="50" y="287" font-size="13.5" fill="#B7C1E2">Partitions</text>
  <use href="#i-pulse" x="24" y="310" width="16" height="16" fill="none" stroke="#8F9BC4" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="50" y="323" font-size="13.5" fill="#B7C1E2">Health</text>
  <use href="#i-key" x="24" y="346" width="16" height="16" fill="none" stroke="#8F9BC4" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="50" y="359" font-size="13.5" fill="#B7C1E2">Licence</text>
  <rect x="12" y="572" width="184" height="104" rx="10" fill="rgba(255,255,255,.035)" stroke="rgba(255,255,255,.08)"/>
  <text x="26" y="598" font-size="12.5" font-weight="600" fill="#E6EBFF">Free recovery left</text>
  <text x="26" y="620" font-size="18" font-weight="700" fill="#FFFFFF" class="m">0.62 GB</text>
  <text x="104" y="620" font-size="12" fill="#8F9BC4">of 1 GB</text>
  <rect x="26" y="634" width="156" height="6" rx="3" fill="rgba(255,255,255,.08)"/>
  <rect x="26" y="634" width="97" height="6" rx="3" fill="url(#w-grad)"/>
  <text x="26" y="660" font-size="11.5" fill="#8F9BC4">Scan &amp; preview: unlimited</text>

  <text x="232" y="86" font-size="20" font-weight="650" fill="#FFFFFF">External drive (E:)</text>
  <use href="#i-lock" x="232" y="96" width="14" height="14" fill="none" stroke="#86A9FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="252" y="107.5" font-size="12" fill="#97A3CB" class="m">Quick scan · NTFS · 29.7 GB · read-only</text>
  <rect x="918.5" y="66.5" width="82" height="34" rx="8" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.14)"/>
  <use href="#i-pause" x="934" y="76" width="14" height="14" fill="none" stroke="#DCE3FF" stroke-width="2.2" stroke-linecap="round"/>
  <text x="954" y="88" font-size="13" font-weight="600" fill="#E6EBFF">Pause</text>
  <rect x="1010.5" y="66.5" width="86" height="34" rx="8" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.14)"/>
  <rect x="1028" y="78" width="10" height="10" rx="2" fill="#E6EBFF"/>
  <text x="1046" y="88" font-size="13" font-weight="600" fill="#E6EBFF">Stop</text>

  <rect x="232.5" y="124.5" width="864" height="64" rx="12" fill="rgba(255,255,255,.035)" stroke="rgba(255,255,255,.08)"/>
  <circle class="pulse" cx="256" cy="148" r="4.5" fill="#86A9FF"/>
  <text x="270" y="152.5" font-size="13.5" font-weight="500" fill="#DDE4FF">Reading file records…</text>
  <text x="1078" y="152.5" font-size="13.5" fill="#97A3CB" text-anchor="end"><tspan class="m" fill="#FFFFFF" font-weight="600">1,284</tspan> files found  ·  <tspan class="m" fill="#FFFFFF" font-weight="600">64%</tspan></text>
  <rect x="250" y="166" width="828" height="8" rx="4" fill="rgba(255,255,255,.08)"/>
  <rect x="250" y="166" width="540" height="8" rx="4" fill="url(#w-grad)"/>
  <g clip-path="url(#w-bar)"><rect class="shimmer" x="250" y="166" width="140" height="8" fill="url(#w-shine)"/></g>

  <rect x="232.5" y="204.5" width="200" height="32" rx="8" fill="rgba(0,0,0,.2)" stroke="rgba(255,255,255,.1)"/>
  <use href="#i-search" x="244" y="213" width="14" height="14" fill="none" stroke="#7F8AB3" stroke-width="2" stroke-linecap="round"/>
  <text x="266" y="225" font-size="12.5" fill="#7F8AB3">Search by name</text>
  <rect x="444.5" y="206.5" width="82" height="28" rx="14" fill="rgba(126,164,255,.18)" stroke="rgba(126,164,255,.45)"/>
  <text x="485" y="225" font-size="12" font-weight="600" fill="#DCE5FF" text-anchor="middle">All · 1,284</text>
  <rect x="534.5" y="206.5" width="92" height="28" rx="14" fill="none" stroke="rgba(255,255,255,.12)"/>
  <text x="580" y="225" font-size="12" fill="#B7C1E2" text-anchor="middle">Photos · 742</text>
  <rect x="634.5" y="206.5" width="80" height="28" rx="14" fill="none" stroke="rgba(255,255,255,.12)"/>
  <text x="674" y="225" font-size="12" fill="#B7C1E2" text-anchor="middle">Docs · 211</text>
  <rect x="722.5" y="206.5" width="86" height="28" rx="14" fill="none" stroke="rgba(255,255,255,.12)"/>
  <text x="765" y="225" font-size="12" fill="#B7C1E2" text-anchor="middle">Deleted only</text>

  <text x="290" y="266" font-size="10.5" font-weight="600" letter-spacing="1" fill="#7F8AB3">NAME</text>
  <text x="468" y="266" font-size="10.5" font-weight="600" letter-spacing="1" fill="#7F8AB3">FOLDER</text>
  <text x="684" y="266" font-size="10.5" font-weight="600" letter-spacing="1" fill="#7F8AB3" text-anchor="end">SIZE</text>
  <text x="700" y="266" font-size="10.5" font-weight="600" letter-spacing="1" fill="#7F8AB3">RECOVERABILITY</text>
  <path d="M232 276.5H808" stroke="rgba(255,255,255,.08)"/>

  <g>
    <rect x="232.5" y="280.5" width="576" height="39" rx="8" fill="rgba(126,164,255,.12)" stroke="rgba(126,164,255,.38)"/>
    <rect x="242" y="293" width="14" height="14" rx="3.5" fill="url(#w-grad)"/><path d="M245.5 300.2l2.4 2.4 4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="264" y="291" width="18" height="18" rx="5" fill="rgba(56,189,248,.18)"/><path d="M267.5 305l4-4.5 2.6 2.6 2-2 2.4 3.9z" fill="#7DD3FC"/><circle cx="276.5" cy="295.6" r="1.6" fill="#7DD3FC"/>
    <text x="290" y="304.5" font-size="13" font-weight="600" fill="#FFFFFF">DSC_0412.JPG</text>
    <text x="468" y="304.5" font-size="11.5" fill="#97A3CB" class="m">\\DCIM\\100CANON</text>
    <text x="684" y="304.5" font-size="12.5" fill="#C9D1EC" text-anchor="end" class="m">6.1 MB</text>
    <rect x="700" y="289" width="86" height="22" rx="11" fill="rgba(52,211,153,.13)" stroke="rgba(52,211,153,.4)"/><circle cx="711" cy="300" r="3" fill="#34D399"/><text x="719" y="304" font-size="11.5" font-weight="600" fill="#6EE7B7">Excellent</text>
  </g>
  <g>
    <rect x="242.5" y="333.5" width="13" height="13" rx="3.5" fill="url(#w-grad)"/><path d="M245.5 340.2l2.4 2.4 4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="264" y="331" width="18" height="18" rx="5" fill="rgba(56,189,248,.18)"/><path d="M267.5 345l4-4.5 2.6 2.6 2-2 2.4 3.9z" fill="#7DD3FC"/><circle cx="276.5" cy="335.6" r="1.6" fill="#7DD3FC"/>
    <text x="290" y="344.5" font-size="13" fill="#E6EBFF">IMG_2231.CR2</text>
    <text x="468" y="344.5" font-size="11.5" fill="#97A3CB" class="m">\\DCIM\\100CANON</text>
    <text x="684" y="344.5" font-size="12.5" fill="#C9D1EC" text-anchor="end" class="m">24.8 MB</text>
    <rect x="700" y="329" width="86" height="22" rx="11" fill="rgba(52,211,153,.13)" stroke="rgba(52,211,153,.4)"/><circle cx="711" cy="340" r="3" fill="#34D399"/><text x="719" y="344" font-size="11.5" font-weight="600" fill="#6EE7B7">Excellent</text>
  </g>
  <path d="M232 360.5H808" stroke="rgba(255,255,255,.05)"/>
  <g>
    <rect x="242.5" y="373.5" width="13" height="13" rx="3.5" fill="url(#w-grad)"/><path d="M245.5 380.2l2.4 2.4 4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="264" y="371" width="18" height="18" rx="5" fill="rgba(129,140,248,.2)"/><path d="M268.5 376h9M268.5 380h9M268.5 384h6" stroke="#A5B4FC" stroke-width="1.6" stroke-linecap="round"/>
    <text x="290" y="384.5" font-size="13" fill="#E6EBFF">Thesis final.docx</text>
    <text x="468" y="384.5" font-size="11.5" fill="#97A3CB" class="m">\\Documents\\College</text>
    <text x="684" y="384.5" font-size="12.5" fill="#C9D1EC" text-anchor="end" class="m">2.3 MB</text>
    <rect x="700" y="369" width="62" height="22" rx="11" fill="rgba(96,165,250,.13)" stroke="rgba(96,165,250,.4)"/><circle cx="711" cy="380" r="3" fill="#60A5FA"/><text x="719" y="384" font-size="11.5" font-weight="600" fill="#93C5FD">Good</text>
  </g>
  <path d="M232 400.5H808" stroke="rgba(255,255,255,.05)"/>
  <g>
    <rect x="242.5" y="413.5" width="13" height="13" rx="3.5" fill="url(#w-grad)"/><path d="M245.5 420.2l2.4 2.4 4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="264" y="411" width="18" height="18" rx="5" fill="rgba(52,211,153,.16)"/><path d="M268.5 415.5h9v9h-9zM268.5 420h9M273 415.5v9" fill="none" stroke="#6EE7B7" stroke-width="1.4"/>
    <text x="290" y="424.5" font-size="13" fill="#E6EBFF">Quarterly report.xlsx</text>
    <text x="468" y="424.5" font-size="11.5" fill="#97A3CB" class="m">\\Work\\2026</text>
    <text x="684" y="424.5" font-size="12.5" fill="#C9D1EC" text-anchor="end" class="m">248 KB</text>
    <rect x="700" y="409" width="62" height="22" rx="11" fill="rgba(96,165,250,.13)" stroke="rgba(96,165,250,.4)"/><circle cx="711" cy="420" r="3" fill="#60A5FA"/><text x="719" y="424" font-size="11.5" font-weight="600" fill="#93C5FD">Good</text>
  </g>
  <path d="M232 440.5H808" stroke="rgba(255,255,255,.05)"/>
  <g>
    <rect x="242.5" y="453.5" width="13" height="13" rx="3.5" fill="none" stroke="rgba(255,255,255,.3)"/>
    <rect x="264" y="451" width="18" height="18" rx="5" fill="rgba(192,132,252,.18)"/><path d="M270.5 455.5v9l7-4.5z" fill="#D8B4FE"/>
    <text x="290" y="464.5" font-size="13" fill="#E6EBFF">Wedding highlights.mp4</text>
    <text x="468" y="464.5" font-size="11.5" fill="#97A3CB" class="m">\\Videos\\2025</text>
    <text x="684" y="464.5" font-size="12.5" fill="#C9D1EC" text-anchor="end" class="m">1.4 GB</text>
    <rect x="700" y="449" width="56" height="22" rx="11" fill="rgba(251,191,36,.12)" stroke="rgba(251,191,36,.4)"/><circle cx="711" cy="460" r="3" fill="#FBBF24"/><text x="719" y="464" font-size="11.5" font-weight="600" fill="#FCD34D">Fair</text>
  </g>
  <path d="M232 480.5H808" stroke="rgba(255,255,255,.05)"/>
  <g>
    <rect x="242.5" y="493.5" width="13" height="13" rx="3.5" fill="none" stroke="rgba(255,255,255,.3)"/>
    <rect x="264" y="491" width="18" height="18" rx="5" fill="rgba(251,191,36,.16)"/><path d="M273 494.5v11" stroke="#FCD34D" stroke-width="1.6" stroke-dasharray="1.6 1.6"/><rect x="270.5" y="502" width="5" height="4" rx="1" fill="#FCD34D"/>
    <text x="290" y="504.5" font-size="13" fill="#E6EBFF">Backup 2024.zip</text>
    <text x="468" y="504.5" font-size="11.5" fill="#97A3CB" class="m">\\Archive</text>
    <text x="684" y="504.5" font-size="12.5" fill="#C9D1EC" text-anchor="end" class="m">512 MB</text>
    <rect x="700" y="489" width="60" height="22" rx="11" fill="rgba(248,113,113,.12)" stroke="rgba(248,113,113,.4)"/><circle cx="711" cy="500" r="3" fill="#F87171"/><text x="719" y="504" font-size="11.5" font-weight="600" fill="#FCA5A5">Poor</text>
  </g>
  <path d="M232 520.5H808" stroke="rgba(255,255,255,.05)"/>
  <g>
    <rect x="242.5" y="533.5" width="13" height="13" rx="3.5" fill="none" stroke="rgba(255,255,255,.3)"/>
    <rect x="264" y="531" width="18" height="18" rx="5" fill="rgba(163,174,201,.18)"/><circle cx="270" cy="540" r="1.6" fill="#CBD5E1"/><circle cx="276" cy="540" r="1.6" fill="#CBD5E1"/>
    <text x="290" y="544.5" font-size="13" fill="#E6EBFF">settings.dat</text>
    <text x="468" y="544.5" font-size="11.5" fill="#97A3CB" class="m">\\AppData\\Local</text>
    <text x="684" y="544.5" font-size="12.5" fill="#C9D1EC" text-anchor="end" class="m">12 KB</text>
    <rect x="700" y="529" width="80" height="22" rx="11" fill="rgba(163,174,201,.12)" stroke="rgba(163,174,201,.38)"/><circle cx="711" cy="540" r="3" fill="#A3AEC9"/><text x="719" y="544" font-size="11.5" font-weight="600" fill="#CBD5E1">Unknown</text>
  </g>
  <path d="M232 560.5H808" stroke="rgba(255,255,255,.05)"/>
  <g>
    <rect class="row-flash" x="232.5" y="561" width="576" height="39" rx="8" fill="rgba(126,164,255,.10)"/>
    <rect x="242.5" y="573.5" width="13" height="13" rx="3.5" fill="none" stroke="rgba(255,255,255,.3)"/>
    <rect x="264" y="571" width="18" height="18" rx="5" fill="rgba(248,113,113,.16)"/><path d="M268.5 576h9M268.5 580h9M268.5 584h6" stroke="#FCA5A5" stroke-width="1.6" stroke-linecap="round"/>
    <text x="290" y="584.5" font-size="13" fill="#E6EBFF">Invoice_0921.pdf</text>
    <text x="468" y="584.5" font-size="11.5" fill="#97A3CB" class="m">\\Work\\Invoices</text>
    <text x="684" y="584.5" font-size="12.5" fill="#C9D1EC" text-anchor="end" class="m">184 KB</text>
    <rect x="700" y="569" width="86" height="22" rx="11" fill="rgba(52,211,153,.13)" stroke="rgba(52,211,153,.4)"/><circle cx="711" cy="580" r="3" fill="#34D399"/><text x="719" y="584" font-size="11.5" font-weight="600" fill="#6EE7B7">Excellent</text>
  </g>

  <rect x="824.5" y="204.5" width="272" height="396" rx="12" fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.08)"/>
  <text x="840" y="230" font-size="10.5" font-weight="600" letter-spacing="1.2" fill="#7F8AB3">PREVIEW</text>
  <g clip-path="url(#w-thumb)">
    <rect x="840" y="244" width="240" height="150" fill="url(#w-sky)"/>
    <circle cx="1012" cy="330" r="22" fill="#FFD9A8" opacity=".92"/>
    <path d="M840 362L888 312 922 340 968 292 1022 348 1056 322 1080 338V394H840Z" fill="#26205C"/>
    <path d="M840 376L874 352 918 370 966 344 1018 372 1080 356V394H840Z" fill="#120F3A"/>
    <path d="M988 384h48M998 389h28" stroke="#FFD9A8" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/>
  </g>
  <text x="840" y="424" font-size="14" font-weight="600" fill="#FFFFFF">DSC_0412.JPG</text>
  <text x="840" y="444" font-size="12" fill="#97A3CB">JPEG image · 4000 × 3000 · 6.1 MB</text>
  <path d="M840 460.5H1080" stroke="rgba(255,255,255,.07)"/>
  <text x="840" y="486" font-size="12.5" fill="#97A3CB">Recoverability</text>
  <rect x="994" y="471" width="86" height="22" rx="11" fill="rgba(52,211,153,.13)" stroke="rgba(52,211,153,.4)"/><circle cx="1005" cy="482" r="3" fill="#34D399"/><text x="1013" y="486" font-size="11.5" font-weight="600" fill="#6EE7B7">Excellent</text>
  <text x="840" y="520" font-size="12.5" fill="#97A3CB">Content check</text>
  <path d="M987 515.5l3 3 6-6.5" fill="none" stroke="#6EE7B7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="1080" y="520" font-size="12.5" font-weight="600" fill="#6EE7B7" text-anchor="end">Is a JPEG</text>
  <text x="840" y="552" font-size="12.5" fill="#97A3CB">State</text>
  <text x="1080" y="552" font-size="12.5" fill="#E6EBFF" text-anchor="end">Deleted</text>
  <text x="840" y="584" font-size="12.5" fill="#97A3CB">Modified</text>
  <text x="1080" y="584" font-size="12.5" fill="#E6EBFF" text-anchor="end" class="m">14 Oct 2026</text>

  <path d="M209 618.5H1120" stroke="rgba(255,255,255,.08)"/>
  <rect x="209" y="619" width="911" height="77" fill="rgba(0,0,0,.14)"/>
  <text x="232" y="662" font-size="14" fill="#E6EBFF"><tspan font-weight="650" fill="#FFFFFF">4 selected</tspan>  ·  <tspan class="m">33.4 MB</tspan></text>
  <rect x="418" y="650.5" width="14" height="14" rx="3.5" fill="url(#w-grad)"/><path d="M421.5 657.7l2.4 2.4 4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="440" y="662" font-size="13" fill="#B7C1E2">Keep folder structure</text>
  <rect x="672.5" y="637.5" width="232" height="42" rx="10" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.12)"/>
  <use href="#i-drive" x="686" y="650" width="17" height="17" fill="none" stroke="#86A9FF" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="712" y="663" font-size="13" fill="#97A3CB">Save to</text>
  <text x="764" y="663" font-size="13" fill="#FFFFFF" font-weight="600" class="m">D:\\Recovered</text>
  <rect x="916" y="637" width="180" height="42" rx="10" fill="url(#w-grad)"/>
  <rect x="916.5" y="637.5" width="179" height="41" rx="9.5" fill="none" stroke="rgba(255,255,255,.22)"/>
  <text x="1006" y="663" font-size="14" font-weight="650" fill="#FFFFFF" text-anchor="middle">Recover 4 files</text>
</svg>

<svg class="win-m" viewBox="0 0 360 512" role="img" aria-labelledby="winm-title">
  <title id="winm-title">Illustration of the RecoverX app: a quick scan of an external drive at 64 percent, with found files graded for recoverability and a button to recover 2 files to drive D.</title>
  <defs>
    <linearGradient id="m-grad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4C7DF0"/><stop offset="1" stop-color="#8A5CF0"/></linearGradient>
    <linearGradient id="m-shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="m-logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B6FE0"/><stop offset="1" stop-color="#7C4DE8"/></linearGradient>
    <clipPath id="m-bar"><rect x="30" y="140" width="194" height="7" rx="3.5"/></clipPath>
  </defs>
  <rect x="0" y="0" width="360" height="40" fill="rgba(255,255,255,.035)"/>
  <rect x="14" y="11" width="18" height="18" rx="4" fill="url(#m-logo)"/>
  <path d="M19 14.6H27L27.3 18A4.3 7.9 0 0 1 23 25.8A4.3 7.9 0 0 1 18.7 18Z" fill="#fff"/>
  <text x="40" y="25" font-size="13" font-weight="600" fill="#E6EBFF">RecoverX</text>
  <path d="M282 20.5h9" stroke="#A9B3D6" stroke-width="1.2"/>
  <rect x="306.5" y="16" width="9" height="9" rx="1.5" fill="none" stroke="#A9B3D6" stroke-width="1.2"/>
  <path d="M332 16l8.5 8.5M340.5 16L332 24.5" stroke="#A9B3D6" stroke-width="1.2"/>
  <path d="M0 40.5H360" stroke="rgba(255,255,255,.08)"/>

  <text x="16" y="72" font-size="18" font-weight="650" fill="#FFFFFF">External drive (E:)</text>
  <use href="#i-lock" x="16" y="81" width="13" height="13" fill="none" stroke="#86A9FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="34" y="92" font-size="11.5" fill="#97A3CB" class="m">Quick scan · NTFS · read-only</text>

  <rect x="16.5" y="108.5" width="327" height="54" rx="11" fill="rgba(255,255,255,.035)" stroke="rgba(255,255,255,.08)"/>
  <circle class="pulse" cx="34" cy="128" r="4" fill="#86A9FF"/>
  <text x="46" y="132" font-size="12.5" fill="#DDE4FF">Reading file records…</text>
  <text x="328" y="132" font-size="12.5" font-weight="600" fill="#FFFFFF" text-anchor="end" class="m">64%</text>
  <rect x="30" y="140" width="298" height="7" rx="3.5" fill="rgba(255,255,255,.08)"/>
  <rect x="30" y="140" width="194" height="7" rx="3.5" fill="url(#m-grad)"/>
  <g clip-path="url(#m-bar)"><rect class="shimmer" x="30" y="140" width="90" height="7" fill="url(#m-shine)"/></g>

  <text x="16" y="186" font-size="10.5" font-weight="600" letter-spacing="1" fill="#7F8AB3">1,284 FILES FOUND</text>

  <rect x="8.5" y="196.5" width="343" height="47" rx="9" fill="rgba(126,164,255,.12)" stroke="rgba(126,164,255,.36)"/>
  <rect x="20" y="213" width="14" height="14" rx="3.5" fill="url(#m-grad)"/><path d="M23.5 220.2l2.4 2.4 4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="44" y="216" font-size="13" font-weight="600" fill="#FFFFFF">DSC_0412.JPG</text>
  <text x="44" y="233" font-size="11" fill="#97A3CB" class="m">6.1 MB · \\DCIM</text>
  <rect x="256" y="209" width="84" height="22" rx="11" fill="rgba(52,211,153,.13)" stroke="rgba(52,211,153,.4)"/><circle cx="267" cy="220" r="3" fill="#34D399"/><text x="275" y="224" font-size="11.5" font-weight="600" fill="#6EE7B7">Excellent</text>

  <rect x="20.5" y="261.5" width="13" height="13" rx="3.5" fill="url(#m-grad)"/><path d="M23.5 268.2l2.4 2.4 4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="44" y="264" font-size="13" fill="#E6EBFF">Thesis final.docx</text>
  <text x="44" y="281" font-size="11" fill="#97A3CB" class="m">2.3 MB · \\Documents</text>
  <rect x="278" y="257" width="62" height="22" rx="11" fill="rgba(96,165,250,.13)" stroke="rgba(96,165,250,.4)"/><circle cx="289" cy="268" r="3" fill="#60A5FA"/><text x="297" y="272" font-size="11.5" font-weight="600" fill="#93C5FD">Good</text>
  <path d="M16 292.5H344" stroke="rgba(255,255,255,.06)"/>

  <rect x="20.5" y="309.5" width="13" height="13" rx="3.5" fill="none" stroke="rgba(255,255,255,.3)"/>
  <text x="44" y="312" font-size="13" fill="#E6EBFF">Wedding highlights.mp4</text>
  <text x="44" y="329" font-size="11" fill="#97A3CB" class="m">1.4 GB · \\Videos</text>
  <rect x="284" y="305" width="56" height="22" rx="11" fill="rgba(251,191,36,.12)" stroke="rgba(251,191,36,.4)"/><circle cx="295" cy="316" r="3" fill="#FBBF24"/><text x="303" y="320" font-size="11.5" font-weight="600" fill="#FCD34D">Fair</text>
  <path d="M16 340.5H344" stroke="rgba(255,255,255,.06)"/>

  <rect x="20.5" y="357.5" width="13" height="13" rx="3.5" fill="none" stroke="rgba(255,255,255,.3)"/>
  <text x="44" y="360" font-size="13" fill="#E6EBFF">Backup 2024.zip</text>
  <text x="44" y="377" font-size="11" fill="#97A3CB" class="m">512 MB · \\Archive</text>
  <rect x="280" y="353" width="60" height="22" rx="11" fill="rgba(248,113,113,.12)" stroke="rgba(248,113,113,.4)"/><circle cx="291" cy="364" r="3" fill="#F87171"/><text x="299" y="368" font-size="11.5" font-weight="600" fill="#FCA5A5">Poor</text>
  <path d="M16 388.5H344" stroke="rgba(255,255,255,.06)"/>

  <g>
    <rect x="20.5" y="405.5" width="13" height="13" rx="3.5" fill="none" stroke="rgba(255,255,255,.3)"/>
    <text x="44" y="408" font-size="13" fill="#E6EBFF">settings.dat</text>
    <text x="44" y="425" font-size="11" fill="#97A3CB" class="m">12 KB · \\AppData</text>
    <rect x="260" y="401" width="80" height="22" rx="11" fill="rgba(163,174,201,.12)" stroke="rgba(163,174,201,.38)"/><circle cx="271" cy="412" r="3" fill="#A3AEC9"/><text x="279" y="416" font-size="11.5" font-weight="600" fill="#CBD5E1">Unknown</text>
  </g>

  <path d="M0 444.5H360" stroke="rgba(255,255,255,.08)"/>
  <rect x="0" y="445" width="360" height="67" fill="rgba(0,0,0,.14)"/>
  <rect x="16" y="458" width="328" height="40" rx="10" fill="url(#m-grad)"/>
  <rect x="16.5" y="458.5" width="327" height="39" rx="9.5" fill="none" stroke="rgba(255,255,255,.22)"/>
  <text x="180" y="483" font-size="14" font-weight="650" fill="#FFFFFF" text-anchor="middle">Recover 2 files to D:\\Recovered</text>
</svg>
</div>`

// --- Home -------------------------------------------------------------------------

/**
 * @param {SiteConfig} site
 * @param {Installer | null} installer
 * @returns {Page}
 */
export function homePage(site, installer) {
  const { limit, windowDays } = site.moveAllowance

  // The quick-scan tile's FAT caveat: deleting a FAT file overwrites the
  // first byte of its 8.3 name with the 0xE5 marker, which `readShortName` in
  // src/main/scan/fat/fat.ts shows as "_"; long names survive whole. The
  // illustrations are labelled NTFS, where DSC_0412.JPG comes back as it was.

  // src/main/scan/carve/carve-signatures.ts: 21 signatures. ZIP covers the
  // Office Open XML formats, which are ZIP containers.
  const fileTypes = [
    {
      kind: 't-photo',
      icon: 'image',
      group: 'Photos & images',
      types: ['JPEG', 'PNG', 'GIF', 'BMP', 'WebP', 'Photoshop PSD', 'Canon CR2'],
    },
    { kind: 't-video', icon: 'film', group: 'Video', types: ['MP4', 'AVI', 'MKV'] },
    { kind: 't-audio', icon: 'music', group: 'Audio', types: ['MP3', 'FLAC', 'WAV'] },
    { kind: 't-doc', icon: 'doc', group: 'Documents', types: ['PDF', 'Office 97–2003', 'RTF'] },
    {
      kind: 't-arch',
      icon: 'archive',
      group: 'Archives & data',
      types: ['ZIP', 'RAR', '7-Zip', 'SQLite', 'Outlook PST'],
    },
  ]

  const main = markup`<section class="hero night" aria-labelledby="hero-title">
<div class="wrap">
<p class="pill"><b>Free to try</b>Data recovery for Windows 10 &amp; 11</p>
<h1 id="hero-title">Recover lost files <span class="grad-text">without touching the original.</span></h1>
<p class="lead">Scan a drive, preview every file, and save what you need somewhere safe.</p>
<div class="cta-row">
<a class="btn btn-primary" href="/download/">${icon('download')}${downloadLabel(installer, 'Download free')}</a>
<a class="btn btn-ghost" href="#pricing">See pricing${icon('arrow')}</a>
</div>
<ul class="reassure" aria-label="Free edition">
<li>${icon('check')}Unlimited scan &amp; preview</li>
<li>${icon('check')}Recover up to 1&nbsp;GB free</li>
<li>${icon('check')}No account needed</li>
</ul>
<div class="stage">
<div class="float float-ro" aria-hidden="true"><span class="float-ic">${icon('lock')}</span><div><strong>Read-only on E:</strong><span><b class="mono">0 bytes</b> written to the source</span></div></div>
<div class="float float-ok" aria-hidden="true"><span class="float-ic">${icon('folder')}</span><div><strong>Saved to another drive</strong><span>Original folders kept</span></div></div>
${PRODUCT_WINDOW}
</div>
<ul class="trust" aria-label="Why it is safe">
<li><span class="trust-ic">${icon('lock')}</span><div><strong>Read-only by design</strong><span>Nothing is ever written to the drive you recover from.</span></div></li>
<li><span class="trust-ic">${icon('offline')}</span><div><strong>Works offline</strong><span>Scan, preview and recover with no internet.</span></div></li>
<li><span class="trust-ic">${icon('pc-lock')}</span><div><strong>Files never uploaded</strong><span>Everything happens on your own PC.</span></div></li>
<li><span class="trust-ic">${icon('user-x')}</span><div><strong>No account needed</strong><span>Install and scan. No sign-up, no key.</span></div></li>
</ul>
<div class="hero-end"></div>
</div>
</section>

<section class="band light" id="how-it-works" aria-labelledby="how-title">
<div class="wrap">
<div class="sec-head split">
<div><span class="kicker">How it works</span>
<h2 id="how-title">Three steps. Stop at any of them.</h2></div>
<p>No settings to learn. Tell ${site.productName} what went wrong and it picks the right scan for you.</p>
</div>
<ol class="steps">
<li class="step">
<div class="step-top"><span class="step-ic">${icon('chat', 'ic-lg')}</span><span class="step-n">STEP 01</span></div>
<h3>Tell it what happened</h3>
<p>Deleted, formatted, or a drive that won't open. It chooses quick or deep scan.</p>
<div class="step-demo" aria-hidden="true"><span class="opt on">Deleted</span><span class="opt">Formatted</span><span class="opt">Won't open</span></div>
</li>
<li class="step">
<div class="step-top"><span class="step-ic">${icon('eye', 'ic-lg')}</span><span class="step-n">STEP 02</span></div>
<h3>Scan and preview</h3>
<p>Pause or resume any time. Preview finds, each graded for how recoverable it is.</p>
<div class="step-demo" aria-hidden="true"><span class="grade ex">Excellent</span><span class="grade gd">Good</span><span class="grade fr">Fair</span></div>
</li>
<li class="step">
<div class="step-top"><span class="step-ic">${icon('folder', 'ic-lg')}</span><span class="step-n">STEP 03</span></div>
<h3>Recover somewhere safe</h3>
<p>Save to a different drive, with the original folders kept intact.</p>
<div class="step-demo" aria-hidden="true"><span class="path"><code>E:\\DCIM</code>${icon('arrow')}<code>D:\\Recovered\\DCIM</code></span></div>
</li>
</ol>
</div>
</section>

<section class="band night" id="features" aria-labelledby="features-title">
<div class="wrap">
<div class="sec-head split">
<div><span class="kicker">Features</span>
<h2 id="features-title">Thorough scans. Careful by design.</h2></div>
<p>Recovery software should only ever read your damaged drive. ${site.productName} is built around that rule.</p>
</div>
<div class="bento">
<article class="tile span2">
<div class="tile-split">
<div>
<span class="tile-ic">${icon('eye')}</span>
<h3>Know before you recover</h3>
<p>Preview images and text in place. Every file is graded from evidence on the disk.</p>
<div class="legend" aria-label="Recoverability grades">
<span class="grade ex">Excellent</span><span class="grade gd">Good</span><span class="grade fr">Fair</span><span class="grade pr">Poor</span><span class="grade uk">Unknown</span>
</div>
</div>
<div class="peek" aria-hidden="true">
<svg viewBox="0 0 320 170">
<defs><linearGradient id="p-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B2C7A"/><stop offset=".55" stop-color="#6A3FB5"/><stop offset="1" stop-color="#F2A065"/></linearGradient></defs>
<rect width="320" height="170" fill="url(#p-sky)"/>
<circle cx="226" cy="98" r="26" fill="#FFD9A8" opacity=".92"/>
<path d="M0 128L60 70 104 104 162 48 230 116 272 86 320 106V170H0Z" fill="#26205C"/>
<path d="M0 146L44 118 100 138 160 108 226 140 320 120V170H0Z" fill="#120F3A"/>
</svg>
<div class="peek-meta"><div><div class="peek-name">DSC_0412.JPG</div><div class="peek-sub">6.1 MB · \\DCIM\\100CANON</div></div><span class="grade ex">Excellent</span></div>
<div class="peek-check">${icon('check')}Content check: it really is a JPEG</div>
</div>
</div>
</article>
<article class="tile">
<span class="tile-ic">${icon('lock')}</span>
<h3>Read-only, always</h3>
<p>Nothing is written to the source drive. Not during a scan, a preview or a recovery.</p>
<div class="readout" aria-hidden="true">
<div><span>E: opened</span><b>read-only</b></div>
<div><span>Scan</span><b>Quick · NTFS</b></div>
<div><span>Written to E:</span><b class="zero">0 bytes</b></div>
</div>
</article>
<article class="tile">
<span class="tile-ic">${icon('zap')}</span>
<h3>Quick scan</h3>
<p>Reads NTFS, FAT12/16/32 and exFAT records. Files return with names, folders and dates. On FAT, short names such as DSC_0412.JPG lose their first letter (_SC_0412.JPG).</p>
</article>
<article class="tile">
<span class="tile-ic">${icon('radar')}</span>
<h3>Deep scan</h3>
<p>Finds 21 file types by their content, even after a format or on a RAW drive.</p>
</article>
<article class="tile">
<span class="tile-ic">${icon('layers')}</span>
<h3>Lost partitions</h3>
<p>Finds deleted volumes from surviving headers. Never rewrites your partition table.</p>
</article>
<article class="tile">
<span class="tile-ic">${icon('pulse')}</span>
<h3>Drive health</h3>
<p>Reads SMART data. A drive that reports nothing shows as unknown, never as healthy.</p>
<div class="stats" aria-hidden="true">
<div class="stat"><b>38 °C</b><span>Temperature</span></div>
<div class="stat"><b>4,210</b><span>Power-on h</span></div>
<div class="stat"><b>0</b><span>Reallocated</span></div>
</div>
</article>
<article class="tile span2">
<div class="tile-split wide-r">
<div>
<span class="tile-ic">${icon('folder')}</span>
<h3>Recover to a different drive</h3>
<p>Original folders are kept. The source drive is refused as a destination.</p>
</div>
<div aria-hidden="true">
<div class="route">
<div class="drive">
<div class="drive-h">${icon('drive')}E: Source</div>
<span class="drive-tag tag-ro">${icon('lock', 'ic-sm')}Read-only</span>
<ul class="tree"><li>DCIM</li><li>100CANON</li><li>DSC_0412.JPG</li></ul>
</div>
<div class="arrow"><span>${icon('arrow')}</span></div>
<div class="drive">
<div class="drive-h">${icon('drive')}D: Backup</div>
<span class="drive-tag tag-ok">${icon('check', 'ic-sm')}Destination</span>
<ul class="tree"><li>Recovered</li><li>DCIM\\100CANON</li><li>DSC_0412.JPG</li></ul>
</div>
</div>
<p class="blocked">${icon('ban')}Saving back to E: is blocked</p>
</div>
</div>
</article>
</div>
</div>
</section>

<section class="band light" id="file-types" aria-labelledby="types-title">
<div class="wrap">
<div class="sec-head split">
<div><span class="kicker">Deep scan</span>
<h2 id="types-title">21 file types, found by content.</h2></div>
<p>Photos, video, music, documents and archives, even when the file system is gone.</p>
</div>
<div class="types">
${fileTypes.map(
  (entry) => markup`<article class="type ${entry.kind}">
<div class="type-h"><span class="type-ic">${icon(entry.icon)}</span><h3>${entry.group}</h3><span class="count">${entry.types.length} types</span></div>
<ul class="chips">${entry.types.map((type) => markup`<li>${type}</li>`)}</ul>
</article>`,
)}
</div>
<p class="types-note">${icon('info')}<span><strong>Word, Excel and PowerPoint (.docx, .xlsx, .pptx)</strong> are found as ZIP. Deep scan can't restore original names or folders — quick scan does, on NTFS, FAT and exFAT.</span></p>
</div>
</section>

<section class="band light alt" id="pricing" aria-labelledby="pricing-title">
<div class="wrap">
<div class="sec-head center">
<span class="kicker">Pricing</span>
<h2 id="pricing-title">Start free. Pay only to recover more.</h2>
<p>Every edition has every feature. Paid editions remove the 1&nbsp;GB recovery limit.</p>
</div>
${freeStrip(installer)}
${plans(site, { payOnline: false })}
${buySteps()}
${priceNote(site, markup`<a href="/buy/">More about buying</a>`)}
</div>
</section>

<section class="band light" id="faq" aria-labelledby="faq-title">
<div class="wrap">
<div class="faq-grid">
<div class="faq-side">
<span class="kicker">FAQ</span>
<h2 class="h2" id="faq-title">Questions, answered.</h2>
<p>Can't find what you need? Write to us and we'll help.</p>
<a class="contact" href="mailto:${site.email}">${icon('mail')}${site.email}</a>
</div>
<div class="faq">
<details open>
<summary>What does the Free edition include?<span class="pm" aria-hidden="true"></span></summary>
<p>Every feature, with one limit: up to 1&nbsp;GB of recovered files in total on each computer. Scanning and preview are unlimited, and ${site.productName} tells you before a recovery would go over the limit. It is for personal use, and for anyone to try ${site.productName} before buying.</p>
</details>
<details>
<summary>Can I move my licence to a new PC?<span class="pm" aria-hidden="true"></span></summary>
<p>Yes. On the old PC, open Licence and choose <strong>Remove from this computer</strong>, then activate the same key on the new one. Professional and Business licences can be moved this way up to ${limit} times in any ${windowDays} days; after that, email us and we'll move it for you.</p>
</details>
<details>
<summary>Can I activate a PC with no internet?<span class="pm" aria-hidden="true"></span></summary>
<p>Yes. Send us the Computer ID shown on the Licence screen and we'll reply with an activation code for that PC. See <a href="/support/#activate-offline">offline activation</a>.</p>
</details>
<details>
<summary>Can it recover deleted files from an SSD?<span class="pm" aria-hidden="true"></span></summary>
<p>Often not. Most SSDs support TRIM, which erases deleted data within moments. Hard disks, USB drives and memory cards give far better odds.</p>
</details>
<details>
<summary>Are my files uploaded anywhere?<span class="pm" aria-hidden="true"></span></summary>
<p>No. Scanning, preview and recovery all happen on your PC. Activating a licence sends only your key and a pseudonymous computer ID — the <a href="/privacy/">privacy policy</a> lists exactly what is sent.</p>
</details>
<details>
<summary>What happens when a paid licence ends?<span class="pm" aria-hidden="true"></span></summary>
<p>${site.productName} goes back to the Free edition: scanning and preview carry on, and files you've recovered stay where you saved them. The Free edition's 1&nbsp;GB counts everything that PC has recovered, including while it was licensed, so a PC that has already recovered 1&nbsp;GB needs a <a href="/support/#renew">renewal</a> to recover more. Renewing keeps the same key.</p>
</details>
<details>
<summary>Can I get a refund?<span class="pm" aria-hidden="true"></span></summary>
<p>Email <a href="mailto:${site.email}">${site.email}</a> with your licence key and order reference, and we'll get back to you.</p>
</details>
<details>
<summary>What do I need to run it?<span class="pm" aria-hidden="true"></span></summary>
<p>Windows 10 (version 21H2 or later) or Windows 11 on a 64-bit PC, with administrator rights — reading a drive directly needs them. You also need a second drive or USB stick for the recovered files.</p>
</details>
</div>
</div>
${knowPanel({
  id: 'know-title',
  level: 3,
  title: 'Good to know before you start',
  note: 'True of every recovery tool',
  items: [
    [
      "Results aren't guaranteed.",
      'It depends on what has happened to the drive since the files were lost.',
    ],
    ['Stop using the drive.', 'New files, downloads and updates can overwrite what you lost.'],
    [
      'Lost files on C:?',
      `Install ${site.productName} on another PC if you can, then connect the drive.`,
    ],
    [
      'SSDs are different.',
      'TRIM often erases deleted data within moments. Overwritten data is gone for good.',
    ],
  ],
})}
</div>
</section>

${finalCta(site, installer, { href: '#pricing', label: 'See pricing' })}`

  return {
    path: '/',
    file: 'index.html',
    title: `${site.productName} — data recovery for Windows`,
    description:
      'Recover deleted, formatted and lost files on Windows 10 and 11. Read-only scanning, preview before you recover, and files saved to a different drive. Free edition recovers up to 1 GB.',
    nav: 'home',
    main,
  }
}

// --- Buy ---------------------------------------------------------------------------

/**
 * @param {SiteConfig} site
 * @param {Installer | null} installer
 * @returns {Page}
 */
export function buyPage(site, installer) {
  const { limit, windowDays } = site.moveAllowance

  const payOnline =
    site.paymentLinkUrl === null
      ? null
      : markup`<div class="pay-card">
<h3>Pay online</h3>
<p>Prefer to pay now? Pay online, and we email your licence key once the payment has been received.</p>
<a class="btn btn-primary" href="${site.paymentLinkUrl}">Pay online</a>
</div>`

  const main = markup`${pageHero({
    kicker: 'Pricing',
    title: 'Editions and pricing',
    lead: 'Every edition has every feature. Paid editions remove the 1 GB recovery limit.',
  })}

<section class="band light alt tight" aria-labelledby="editions-title">
<div class="wrap">
<h2 class="sr-only" id="editions-title">Editions</h2>
${freeStrip(installer)}
${plans(site, { payOnline: true })}
${buySteps()}
${priceNote(site, markup`<a href="#order">How to order</a>`)}
</div>
</section>

<section class="band light tight" id="order" aria-labelledby="order-title">
<div class="wrap narrow">
<h2 class="sub-h" id="order-title">Order a licence</h2>
<p class="order-lead">Send this form and we email you how to pay, usually within one business day. Once the payment has been received, your licence key follows by email; enter it on the Licence screen in ${site.productName} — see <a href="/support/#activate-online">activating a licence</a>.</p>
${orderForm(site)}
${payOnline}
${knowPanel({
  id: 'good-to-know',
  level: 3,
  title: 'Good to know',
  items: [
    [
      'Sold here, not in the app.',
      `Licences are sold by ${site.vendor.shortName} on this site — not inside the app and not through the Microsoft Store.`,
    ],
    [
      'One year, renewable.',
      markup`A paid licence runs for one year. <a href="/support/#renew">Renewing</a> keeps the same key; without it, ${site.productName} goes back to the Free edition, whose 1 GB counts what the PC recovered while licensed.`,
    ],
    [
      'Moving to a new PC.',
      markup`Professional and Business licences can be <a href="/support/#move-licence">moved</a> by you up to ${limit} times in any ${windowDays} days; after that we move them for you.`,
    ],
    [
      'Try before you buy.',
      `The Free edition, for personal use and for trying ${site.productName} at work, scans and previews without limit, so you can see what can be found first.`,
    ],
    [
      'Refunds and questions.',
      markup`Email <a href="mailto:${site.email}">${site.email}</a> before buying, or about a purchase or a <a href="/support/#refunds">refund</a>.`,
    ],
  ],
})}
</div>
</section>

${finalCta(site, installer, { href: '/support/', label: 'Read the documentation' })}`

  return {
    path: '/buy/',
    file: 'buy/index.html',
    title: `Editions and pricing — ${site.productName}`,
    description: `${site.productName} editions: Free (1 GB of recovery), Professional ₹2,499, Business ₹5,999 and Technician ₹14,999 per year, and Enterprise licensing. How to buy.`,
    nav: 'buy',
    main,
  }
}

// --- Order form outcomes (redirect targets of the licence server's /order/) ---------

/**
 * @param {SiteConfig} site
 * @param {Installer | null} installer
 * @returns {Page}
 */
export function orderSentPage(site, installer) {
  const main = markup`${pageHero({
    kicker: 'Order',
    title: 'Thank you — your order request is on its way',
    lead: 'We have received it and will reply by email with how to pay, usually within one business day.',
  })}

<section class="band light tight" aria-labelledby="next-title">
<div class="wrap narrow">
<h2 class="sub-h" id="next-title">What happens next</h2>
<ol class="numbered">
<li>Look out for our email from ${site.email} — check the spam folder too.</li>
<li>Pay as it describes.</li>
<li>Your licence key arrives by email. Enter it on the Licence screen in ${site.productName} — see <a href="/support/#activate-online">activating a licence</a>.</li>
</ol>
<p>Not heard from us within two business days? Email <a href="mailto:${site.email}">${site.email}</a>.</p>
<div class="cta-row">
<a class="btn btn-primary" href="/download/">${icon('download')}${downloadLabel(installer, `Download ${site.productName}`, 'Download — coming soon')}</a>
<a class="btn btn-outline" href="/">Home</a>
</div>
</div>
</section>`

  return {
    path: '/buy/sent/',
    file: 'buy/sent/index.html',
    title: `Order request sent — ${site.productName}`,
    description: 'Your order request has been sent.',
    nav: 'buy',
    noindex: true,
    main,
  }
}

/**
 * @param {SiteConfig} site
 * @returns {Page}
 */
export function orderErrorPage(site) {
  const main = markup`${pageHero({
    kicker: 'Order',
    title: 'Your order request could not be sent',
    lead: 'Nothing was sent. Please try again in a few minutes, or email us instead.',
  })}

<section class="band light tight" aria-labelledby="why-title">
<div class="wrap narrow">
<h2 class="sub-h" id="why-title">Why this can happen</h2>
<ul class="order-reasons">
<li>A required field was empty or not in the expected form (for example the email address or the mobile number).</li>
<li>Several requests came from your connection in a short time; wait an hour and send it again.</li>
<li>Our mail service was briefly unavailable.</li>
</ul>
<p>Use your browser's Back button to return to the form with what you typed still filled in.</p>
<div class="cta-row">
<a class="btn btn-primary" href="${ORDER_FORM}">Back to the order form</a>
<a class="btn btn-outline" href="mailto:${site.email}">${icon('mail')}Email ${site.email}</a>
</div>
</div>
</section>`

  return {
    path: '/buy/error/',
    file: 'buy/error/index.html',
    title: `Order request not sent — ${site.productName}`,
    description: 'Your order request could not be sent.',
    nav: 'buy',
    noindex: true,
    main,
  }
}

// --- Support ------------------------------------------------------------------------

/**
 * @param {SiteConfig} site
 * @returns {Page}
 */
export function supportPage(site) {
  const { limit, windowDays } = site.moveAllowance
  const sections = [
    { id: 'before-you-start', text: 'Before you recover anything' },
    { id: 'requirements', text: 'System requirements' },
    { id: 'activate-online', text: 'Activate a licence' },
    { id: 'activate-offline', text: 'Activate without internet' },
    { id: 'move-licence', text: 'Move a licence to a new PC' },
    { id: 'renew', text: 'Renew a licence' },
    { id: 'free-limit', text: 'The Free edition’s 1 GB limit' },
    { id: 'updates', text: 'Updates' },
    { id: 'refunds', text: 'Refunds' },
    { id: 'troubleshooting', text: 'Licence messages explained' },
    { id: 'privacy', text: 'Privacy' },
    { id: 'contact', text: 'Contact us' },
  ]

  // Licence behaviour: src/main/licensing/license.service.ts (renewal window
  // and grace, offline removal retried at start-up), the Licence screen's
  // strings in src/renderer/i18n/locales/en.ts, and the self-service release
  // cap in src/server/authority.ts. Updates: src/main/updates/update.service.ts.
  // The Free limit is checked against every recovery in the computer's
  // history (`totalRecoveredBytes` in src/main/recovery/recovery.service.ts),
  // licensed or not — which is why the pages say so wherever a licence ends.
  const main = markup`${pageHero({
    kicker: 'Help',
    title: 'Support',
    lead: `Activation, moving a licence, renewals and refunds. Or email ${site.email}.`,
    extra: markup`<a class="contact" href="mailto:${site.email}">${icon('mail')}${site.email}</a>`,
  })}
<div class="wrap doc-layout">
${tableOfContents(sections)}
<div class="prose">

${knowPanel({
  panelId: 'before-you-start',
  id: 'before-title',
  level: 2,
  title: 'Before you recover anything',
  note: 'True of every recovery tool',
  items: disclaimers(site),
})}

<section id="requirements" aria-labelledby="requirements-title">
<h2 id="requirements-title">System requirements</h2>
<ul>
<li>Windows 10 version 21H2 or later, or Windows 11, on a 64-bit (x64) PC.</li>
<li>An administrator account. Reading drives directly needs administrator rights, so Windows asks for permission (UAC) each time ${site.productName} starts.</li>
<li>About 400 MB of disk space for the app.</li>
<li>A second drive or a USB stick with enough free space for the recovered files: ${site.productName} never saves them to the drive they came from.</li>
</ul>
</section>

<section id="activate-online" aria-labelledby="activate-online-title">
<h2 id="activate-online-title">Activate a licence</h2>
<ol class="numbered">
<li>Open ${site.productName} and go to <strong>Licence</strong>.</li>
<li>Under <strong>Activate a licence</strong>, choose <strong>Online</strong> and enter the key from your email. Keys start with <code>RECX</code>; a typing mistake is caught before anything is sent.</li>
<li>Click <strong>Activate</strong>. The new edition applies at once.</li>
</ol>
<p class="types-note">${icon('info')}<span>Activation sends your licence key and a pseudonymous computer identifier to our licence server — see the <a href="/privacy/">privacy policy</a>.</span></p>
</section>

<section id="activate-offline" aria-labelledby="activate-offline-title">
<h2 id="activate-offline-title">Activate a computer without internet</h2>
<ol class="numbered">
<li>On the computer you want to activate, open <strong>Licence</strong> and click <strong>Copy computer ID</strong>.</li>
<li>From any device, email the computer ID and your licence key to <a href="mailto:${site.email}">${site.email}</a>.</li>
<li>We reply with an activation code for that computer.</li>
<li>Under <strong>Activate a licence</strong>, choose <strong>Offline</strong>, paste the activation code and click <strong>Activate</strong>.</li>
</ol>
<p class="types-note">${icon('info')}<span>An activation code works only on the computer it was made for.</span></p>
</section>

<section id="move-licence" aria-labelledby="move-title">
<h2 id="move-title">Move a licence to a new PC</h2>
<p>A licence counts the computers it is active on. To use it on a different computer, free a place first:</p>
<ol class="numbered">
<li>On the old computer, open <strong>Licence → Remove from this computer</strong>. That computer goes back to the Free edition, whose 1 GB limit counts what it recovered while licensed; nothing you have already recovered is affected.</li>
<li>On the new computer, activate the same key.</li>
</ol>
<p>If the old computer is offline when you remove the licence, its place is freed the next time ${site.productName} is opened there with an internet connection.</p>
<div class="types-note">${icon('info')}<div>
<h3>How often you can move a licence yourself</h3>
<p><strong>Professional</strong> (1 PC) and <strong>Business</strong> (3 PCs) licences can be moved this way up to <strong>${limit} times in any ${windowDays} days</strong>. After that, ${site.productName} keeps the licence on the computer it is on and asks you to contact us; email your licence key to <a href="mailto:${site.email}">${site.email}</a> and we will move it for you.</p>
<p><strong>Technician</strong> and <strong>Enterprise</strong> licences cover any number of computers, so the limit never applies to them.</p>
</div></div>
<p><strong>Old computer broken, lost or already wiped?</strong> Email us your licence key and we will free its place.</p>
<p><strong>Reinstalled Windows or renamed the computer?</strong> The Licence screen may show <em>Different computer</em>. Click <strong>Release this activation</strong>, then activate your key again.</p>
</section>

<section id="renew" aria-labelledby="renew-title">
<h2 id="renew-title">Renew a licence</h2>
<p>Paid licences run for one year. To renew, email <a href="mailto:${site.email}">${site.email}</a> with your licence key${site.paymentLinkUrl !== null ? markup`, or <a href="${site.paymentLinkUrl}">pay online</a>` : ''}.</p>
<p>Renewing extends the same key, so there is nothing to type again. From 14 days before the end date until 30 days after it, ${site.productName} checks for a renewal each time it starts; <strong>Check for renewal</strong> on the Licence screen picks it up straight away.</p>
<p>If a licence ends without being renewed, ${site.productName} goes back to the Free edition, and everything you have already recovered stays where you saved it. The Free edition’s <a href="#free-limit">1 GB limit</a> counts every recovery made on that computer, including those made while it was licensed, so a computer that has already recovered 1 GB cannot recover more until the licence is renewed.</p>
</section>

<section id="free-limit" aria-labelledby="free-limit-title">
<h2 id="free-limit-title">The Free edition’s 1 GB limit</h2>
<p>Without a licence, ${site.productName} recovers up to 1 GB (1,073,741,824 bytes) of files in total on each computer. The total counts every recovery made on that computer, including any made while it had a licence. Scanning and preview are not limited.</p>
<ul>
<li>The Licence screen shows how much of the allowance is left.</li>
<li>${site.productName} tells you before a recovery would go over the limit, so you can choose fewer files.</li>
<li>A licence removes the limit. Files you have already recovered stay where you saved them.</li>
</ul>
</section>

<section id="updates" aria-labelledby="updates-title">
<h2 id="updates-title">Updates</h2>
<p>While <strong>Check for updates automatically</strong> is on in Settings, ${site.productName} checks for a new version once, shortly after it starts. To check at any time, open <strong>About</strong> and click <strong>Check now</strong> under Updates.</p>
<p>A new version is downloaded only when you click <strong>Download update</strong>, and installed only when you click <strong>Install and restart</strong> — finish any scan or recovery first. What changed in each version is in the <a href="/releases/">release notes</a>.</p>
</section>

<section id="refunds" aria-labelledby="refunds-title">
<h2 id="refunds-title">Refunds</h2>
<p>To ask about a refund, or about any other problem with a purchase, email <a href="mailto:${site.email}">${site.email}</a> with your licence key and order reference.</p>
</section>

<section id="troubleshooting" aria-labelledby="troubleshooting-title">
<h2 id="troubleshooting-title">Licence messages explained</h2>
<dl class="definitions">
<dt>“That key is for a different product” or “There is a typing error in this key”</dt>
<dd>Licence keys start with <code>RECX</code>, followed by 20 characters. Compare the key with the email it came in.</dd>
<dt>“This licence is already active on another computer, which is all it allows”</dt>
<dd>Remove the licence from a computer you no longer use, or email us and we will move it for you.</dd>
<dt>Different computer</dt>
<dd>The activation was made for another computer, which happens after Windows is reinstalled or the computer is renamed. Click <strong>Release this activation</strong>, then activate your key again.</dd>
<dt>Not valid</dt>
<dd>The stored activation could not be verified. Activate again, or email us with the computer ID.</dd>
<dt>Cannot be checked</dt>
<dd>This copy of ${site.productName} cannot verify licences. Download it again from the <a href="/download/">download page</a>.</dd>
<dt>Expired</dt>
<dd>The licence has run out and ${site.productName} is back on the Free edition, whose 1 GB limit includes what this computer recovered while licensed. <a href="#renew">Renew it</a> to recover without limit again.</dd>
</dl>
</section>

<section id="privacy" aria-labelledby="privacy-title">
<h2 id="privacy-title">Privacy</h2>
<p>Your files never leave your computer. The <a href="/privacy/">privacy policy</a> says exactly what the app sends, when, and how long we keep it.</p>
</section>

<section id="contact" aria-labelledby="contact-title">
<h2 id="contact-title">Contact us</h2>
<p>Email <a href="mailto:${site.email}">${site.email}</a>. To help us answer quickly:</p>
<ul>
<li>include your licence key, if you have one;</li>
<li>for an activation question, include the <strong>Computer ID</strong> from the Licence screen;</li>
<li>for a technical problem, open <strong>About</strong> and click <strong>Copy diagnostics</strong>, then paste the result into your email.</li>
</ul>
<address class="address-card">
<strong>${site.vendor.legalName}</strong><br>
<a href="mailto:${site.email}">${site.email}</a> · <a href="${site.vendor.url}">${site.vendor.url.replace(/^https:\/\//u, '')}</a>
</address>
</section>

</div>
</div>`

  return {
    path: '/support/',
    file: 'support/index.html',
    title: `Support and documentation — ${site.productName}`,
    description: `Activate ${site.productName} online or offline, move a licence to a new PC, renew, the Free edition’s 1 GB limit, refunds, and how to contact support.`,
    nav: 'support',
    main,
  }
}

// --- Download ---------------------------------------------------------------------------

/**
 * @param {SiteConfig} site
 * @param {Installer | null} installer
 * @returns {Page}
 */
export function downloadPage(site, installer) {
  const hero =
    installer === null
      ? pageHero({
          kicker: 'Download',
          title: `Download ${site.productName}`,
          lead: `The first release is being prepared. ${site.productName} will be available here, and from the Microsoft Store, as soon as it is published.`,
          extra: markup`<p class="pill solo">Coming soon</p>`,
        })
      : pageHero({
          kicker: 'Download',
          title: `Download ${site.productName}`,
          lead: 'For Windows 10 (21H2 or later) and Windows 11, 64-bit. No key, no account.',
          extra: markup`<div class="cta-row">
<a class="btn btn-primary" href="${installerPath(installer)}">${icon('download')}Download for Windows · v${installer.version} · ${formatSize(installer.size)}</a>
${site.storeUrl !== null && storeButton(site, 'night')}
</div>`,
        })

  const card =
    installer === null
      ? markup`<div class="download-card">
<h2>The first release is being prepared</h2>
<p>${site.productName} will be available to download here as soon as it is published. Questions in the meantime? Email <a href="mailto:${site.email}">${site.email}</a>.</p>
</div>
${storeButton(site, 'paper')}`
      : markup`<div class="download-card">
<h2>Version ${installer.version}</h2>
<p>Released ${formatDate(installer.date)} · Windows 10 and 11, 64-bit</p>
<dl class="specs">
<div><dt>File</dt><dd><code>${installer.fileName}</code></dd></div>
<div><dt>Size</dt><dd>${formatSize(installer.size)} (${installer.size.toLocaleString('en-US')} bytes)</dd></div>
<div><dt>SHA-256</dt><dd><code class="hash">${installer.sha256}</code></dd></div>
</dl>
<div class="cta-row">
<a class="btn btn-primary" href="${installerPath(installer)}">${icon('download')}Download for Windows</a>
<a class="btn btn-outline" href="/releases/">What’s new in ${installer.version}</a>
</div>
</div>
<p class="types-note">${icon('info')}<span>To check the download, run <code>Get-FileHash .\\${installer.fileName} -Algorithm SHA256</code> in PowerShell and compare the result with the SHA-256 above.</span></p>
${
  site.installerCodeSigned
    ? ''
    : markup`<p class="types-note">${icon('info')}<span>This first build is not yet code-signed, so Windows SmartScreen may show “Windows protected your PC”. Choose <strong>More info</strong>, then <strong>Run anyway</strong> — after checking the SHA-256 above. A signed build will follow and reaches existing installations as an update.${
        site.storeUrl === null
          ? ''
          : markup` Or install RecoverX from the <a href="${site.storeUrl}">Microsoft Store</a> instead: Microsoft signs that copy, so Windows shows no such warning, and the Store keeps it up to date.`
      }</span></p>`
}
${storeButton(site, 'paper')}`

  const main = markup`${hero}

<section class="band light tight" aria-label="Download">
<div class="wrap narrow">
${card}
</div>
</section>

<section class="band light alt tight" aria-labelledby="before-install">
<div class="wrap narrow">
${knowPanel({
  id: 'before-install',
  level: 2,
  title: 'Before you install',
  note: 'True of every recovery tool',
  items: disclaimers(site),
})}
<h2 class="sub-h" id="install-requirements">What you need</h2>
<ul class="needs">
<li class="need"><span class="need-ic">${icon('pc')}</span><div><strong>Windows 10 or 11, 64-bit</strong><span>Windows 10 version 21H2 or later, or Windows 11, on an x64 PC.</span></div></li>
<li class="need"><span class="need-ic">${icon('shield')}</span><div><strong>An administrator account</strong><span>Windows asks for permission (UAC) each time ${site.productName} starts, because reading drives directly needs it.</span></div></li>
<li class="need"><span class="need-ic">${icon('download')}</span><div><strong>About 400 MB of disk space</strong><span>For the app itself.</span></div></li>
<li class="need"><span class="need-ic">${icon('drive')}</span><div><strong>A second drive or USB stick</strong><span>With enough free space for the recovered files: they are never saved to the drive they came from.</span></div></li>
</ul>
<p class="after-needs">Need help? See <a href="/support/">support and documentation</a>.</p>
</div>
</section>`

  return {
    path: '/download/',
    file: 'download/index.html',
    title: `Download ${site.productName} for Windows`,
    description: `Download ${site.productName} for Windows 10 and 11 (64-bit). Free edition: unlimited scanning and preview, and up to 1 GB of recovery, with no key and no account.`,
    nav: 'download',
    main,
  }
}

// --- Release notes -----------------------------------------------------------------------

/**
 * @param {SiteConfig} site
 * @param {readonly Release[]} releases
 * @param {Installer | null} installer
 * @returns {Page}
 */
export function releasesPage(site, releases, installer) {
  const main = markup`${pageHero({
    kicker: 'Releases',
    title: 'Release notes',
    lead: 'What changed in each version, newest first.',
  })}

<section class="band light tight" aria-label="Versions">
<div class="wrap narrow">
<div class="timeline">
${releases.map((release) => {
  const id = `v${release.version.replace(/[^0-9A-Za-z]+/gu, '-')}`
  const current = installer !== null && installer.version === release.version
  return markup`<article class="release${current ? ' pick' : ''}" aria-labelledby="${id}">
<div class="release-head">
<span class="version">v${release.version}</span>
${
  release.date === null
    ? markup`<span class="pill solo">Not released yet</span>`
    : markup`<span class="release-date">Released <time datetime="${release.date}">${formatDate(release.date)}</time></span>`
}
</div>
<h2 id="${id}">${release.title}</h2>
<ul class="checks">${release.notes.map((note) => markup`<li>${icon('check')}<span>${note}</span></li>`)}</ul>
${current && markup`<a class="btn btn-outline" href="/download/">${icon('download')}Download v${release.version}</a>`}
</article>`
})}
</div>
</div>
</section>`

  return {
    path: '/releases/',
    file: 'releases/index.html',
    title: `Release notes — ${site.productName}`,
    description: `What changed in each version of ${site.productName} for Windows.`,
    nav: 'releases',
    main,
  }
}

// --- Generated documents ---------------------------------------------------------------

/**
 * Split a generated document into its title, its "Last updated" line if it
 * opens with one, and the rest, so the title can sit in the page hero. The
 * converters always put the title first (build.mjs checks there is exactly
 * one), and both pieces are the converters' own escaped output.
 *
 * @param {RenderedDocument} document
 * @returns {{ id: string, title: Html, updated: string | null, body: Html }}
 */
function splitTitle(document) {
  const source = document.html.value
  const title = /^\s*<h1 id="([^"]+)">([\s\S]*?)<\/h1>\s*/u.exec(source)
  if (!title) throw new Error('A generated document does not start with its title.')

  let rest = source.slice(title[0].length)
  /** @type {string | null} */
  let updated = null
  const meta = /^<p><strong>Last updated:<\/strong>\s*([^<]+)<\/p>\s*/u.exec(rest)
  if (meta) {
    updated = (meta[1] ?? '').trim()
    rest = rest.slice(meta[0].length)
  }

  return {
    id: title[1] ?? 'page-title',
    title: trusted(title[2] ?? ''),
    updated,
    body: trusted(rest),
  }
}

/**
 * A page around a document generated from the repository: the privacy policy
 * or the licence terms. Plain paper below the hero, and no call to action.
 *
 * @param {{ document: RenderedDocument, after?: Html }} content
 * @returns {Html}
 */
function documentMain({ document, after }) {
  const { id, title, updated, body } = splitTitle(document)
  const sections = document.headings.filter((heading) => heading.level === 2)
  const withToc = sections.length > 2
  return markup`${pageHero({
    kicker: 'Legal',
    title,
    titleId: id,
    meta: updated === null ? null : `Last updated ${updated}`,
    compact: true,
  })}
<div class="wrap doc-layout${withToc ? '' : ' no-toc'}">
${withToc && tableOfContents(sections)}
<article class="prose legal" aria-labelledby="${id}">
${body}
${after}
</article>
</div>`
}

/**
 * @param {SiteConfig} site
 * @param {RenderedDocument} document
 * @returns {Page}
 */
export function privacyPage(site, document) {
  return {
    path: '/privacy/',
    file: 'privacy/index.html',
    title: `Privacy policy — ${site.productName}`,
    description: `What ${site.productName} and its licence and update services process, why, how long it is kept, and your rights. Your files never leave your computer.`,
    nav: 'privacy',
    main: documentMain({ document }),
  }
}

/**
 * @param {SiteConfig} site
 * @param {RenderedDocument} document
 * @returns {Page}
 */
export function termsPage(site, document) {
  return {
    path: '/terms/',
    file: 'terms/index.html',
    title: `Licence terms — ${site.productName}`,
    description: `The ${site.productName} end-user licence agreement: the terms the installer shows before ${site.productName} is installed.`,
    nav: 'terms',
    main: documentMain({
      document,
      after: markup`<p class="types-note doc-note">${icon('info')}<span>These are the terms the ${site.productName} installer shows before installation. Questions about them: <a href="mailto:${site.email}">${site.email}</a>.</span></p>`,
    }),
  }
}

// --- Not found ----------------------------------------------------------------------------

/**
 * Served for any missing path, at any depth, so every link in it is
 * root-relative.
 *
 * @param {SiteConfig} site
 * @returns {Page}
 */
export function notFoundPage(site) {
  return {
    path: '/404.html',
    file: '404.html',
    title: `Page not found — ${site.productName}`,
    description: 'The page you asked for does not exist.',
    nav: null,
    noindex: true,
    main: markup`<section class="nf night" aria-labelledby="nf-title">
<div class="wrap">
${inlineLogo('logo-404', 64, 'cta-mark')}
<h1 id="nf-title">Page not found</h1>
<p>The page may have moved. These will get you back on track:</p>
<div class="cta-row">
<a class="btn btn-primary" href="/">Home</a>
<a class="btn btn-ghost" href="/download/">${icon('download')}Download</a>
<a class="btn btn-ghost" href="/support/">Support</a>
</div>
</div>
</section>`,
  }
}

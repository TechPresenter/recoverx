import { markup, trusted } from './html.mjs'
import { inlineLogo } from './logo.mjs'

/**
 * The frame every page shares: head, header, icon sprite, footer.
 *
 * Nothing on the site loads from anywhere but the site itself — no fonts, no
 * scripts, no analytics, no cookies — and the Content-Security-Policy below
 * makes that a property of the page rather than a promise: a browser will
 * refuse anything else, including a script someone manages to inject. The
 * privacy policy says the website does not track visitors, and the footer
 * says "No cookies. No trackers. No uploads."; this is what keeps both true.
 *
 * The policy travels in a <meta> element because the server's `.htaccess`
 * belongs to the licence server (server-php/public), and the static files
 * must be safe whatever headers it does or does not add. `frame-ancestors`
 * cannot be set from a <meta>; that one is the server's.
 *
 * The header and the footer sit on the "night" surface on every page, in both
 * colour schemes (see assets/site.css). The navigation is plain links on wide
 * screens and a <details> menu on narrow ones, so it works without a script.
 */

/** @typedef {import('./html.mjs').Html} Html */
/** @typedef {import('../site.config.mjs').SiteConfig} SiteConfig */
/** @typedef {import('./content.mjs').Installer} Installer */

/** @typedef {'home' | 'download' | 'buy' | 'support' | 'releases' | 'privacy' | 'terms'} NavKey */

/**
 * @typedef {object} Page
 * @property {string} path URL path: `/` or `/name/` for a page, `/404.html` for the error page.
 * @property {string} file Output file, relative to the output directory.
 * @property {string} title The whole `<title>`.
 * @property {string} description For search results and link previews; under ~160 characters.
 * @property {NavKey | null} nav Which navigation entry is the current page.
 * @property {Html} main
 * @property {boolean} [noindex] Keep the page out of search engines and the sitemap.
 */

/**
 * @typedef {object} Assets
 * @property {string} stylesheet Root-relative path of the hashed stylesheet.
 */

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * The icons, as one sprite every page carries and refers to with
 * `<use href="#i-…">`. 24 × 24 strokes in `currentColor` (`.ic` in the
 * stylesheet), so an icon takes the colour of the text beside it. Inline
 * rather than a file, because a sprite in another file is a second request
 * for every page, and the CSP allows a same-document reference without any
 * exception.
 */
const SPRITE =
  trusted(`<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">
<symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3.5v11.5"/><path d="M7 10.5l5 5 5-5"/><path d="M4.5 20h15"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2"/></symbol>
<symbol id="i-offline" viewBox="0 0 24 24"><path d="M12 19.5h.01"/><path d="M8.6 15.9a5 5 0 0 1 6.8 0"/><path d="M5.2 12.4a10 10 0 0 1 4.6-2.6"/><path d="M18.8 12.4a10 10 0 0 0-2.2-1.6"/><path d="M2 8.9a15 15 0 0 1 4-2.6"/><path d="M22 8.9A15 15 0 0 0 10.6 4.6"/><path d="M3 3l18 18"/></symbol>
<symbol id="i-pc" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7"/><path d="M12 16v4"/></symbol>
<symbol id="i-pc-lock" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7"/><path d="M12 16v4"/><rect x="9.5" y="9" width="5" height="4" rx="1"/><path d="M10.5 9V7.8a1.5 1.5 0 0 1 3 0V9"/></symbol>
<symbol id="i-user-x" viewBox="0 0 24 24"><circle cx="10" cy="8" r="4"/><path d="M3 20.5a7 7 0 0 1 11.5-5.4"/><path d="M17 15.5l4.5 4.5"/><path d="M21.5 15.5L17 20"/></symbol>
<symbol id="i-chat" viewBox="0 0 24 24"><path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1.1-4.3A8.5 8.5 0 1 1 20.5 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-drive" viewBox="0 0 24 24"><rect x="2.5" y="13" width="19" height="7" rx="2"/><path d="M5 13l2.6-7.5h8.8L19 13"/><path d="M6.5 16.5h.01M9.5 16.5h.01"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></symbol>
<symbol id="i-zap" viewBox="0 0 24 24"><path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/></symbol>
<symbol id="i-radar" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/><path d="M12 12l6.4-6.4"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 17l9 5 9-5"/></symbol>
<symbol id="i-pulse" viewBox="0 0 24 24"><path d="M3 12h4l2.2-5.5 4.4 11 2.2-5.5H21"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7.5 2.8v5.7c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V5.8z"/><path d="M8.7 12.2l2.3 2.3 4.4-4.6"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="M21 15.5l-5-5L5.5 20"/></symbol>
<symbol id="i-film" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/></symbol>
<symbol id="i-music" viewBox="0 0 24 24"><path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></symbol>
<symbol id="i-doc" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></symbol>
<symbol id="i-archive" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V9"/><path d="M10 13h4"/></symbol>
<symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/></symbol>
<symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
<symbol id="i-ban" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/></symbol>
<symbol id="i-history" viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4h4"/><path d="M12 8v4.5l3 2"/></symbol>
<symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3"/><path d="M17 6l3 3"/></symbol>
<symbol id="i-pause" viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></symbol>
<symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></symbol>
</svg>`)

/**
 * One icon from the sprite.
 *
 * @param {string} name The symbol id without its `i-` prefix.
 * @param {string} [extraClass]
 * @returns {Html}
 */
export function icon(name, extraClass) {
  const className = extraClass === undefined ? 'ic' : `ic ${extraClass}`
  return markup`<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`
}

/**
 * Where the home page's sections are, from the page being rendered: a
 * fragment on the home page itself, the home page's address everywhere else.
 *
 * @param {Page} page
 * @param {string} fragment
 */
function homeAnchor(page, fragment) {
  return page.nav === 'home' ? `#${fragment}` : `/#${fragment}`
}

/**
 * @param {Page} page
 * @param {NavKey} key
 * @returns {Html | null}
 */
function current(page, key) {
  return page.nav === key ? markup` aria-current="page"` : null
}

/**
 * @param {Page} page
 * @param {SiteConfig} site
 * @param {Assets} assets
 * @param {Installer | null} installer Until one is published, the header's
 *   button says "Coming soon" rather than promising a download.
 * @returns {string}
 */
export function renderPage(page, site, assets, installer) {
  const url = `${site.origin}${page.path}`
  const indexable = page.noindex !== true

  /** @type {Array<{ href: string, label: string, key?: NavKey }>} */
  const nav = [
    { href: homeAnchor(page, 'features'), label: 'Features' },
    { href: homeAnchor(page, 'how-it-works'), label: 'How it works' },
    page.nav === 'buy'
      ? { href: '/buy/', label: 'Pricing', key: 'buy' }
      : { href: homeAnchor(page, 'pricing'), label: 'Pricing' },
    { href: '/support/', label: 'Support', key: 'support' },
  ]
  /** @type {Array<{ href: string, label: string, key?: NavKey }>} */
  const compactNav = [
    ...nav.slice(0, 3),
    ...(page.nav === 'home' ? [{ href: '#faq', label: 'FAQ' }] : []),
    nav[3] ?? { href: '/support/', label: 'Support' },
    { href: '/download/', label: 'Download', key: 'download' },
  ]
  /** @param {{ href: string, label: string, key?: NavKey }} item */
  const link = (item) =>
    markup`<a href="${item.href}"${item.key === undefined ? null : current(page, item.key)}>${item.label}</a>`

  const html = markup`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
${indexable ? markup`<link rel="canonical" href="${url}">` : markup`<meta name="robots" content="noindex">`}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#060a22">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="${assets.stylesheet}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${site.productName}">
<meta property="og:title" content="${page.title}">
<meta property="og:description" content="${page.description}">
${indexable && markup`<meta property="og:url" content="${url}">`}
<meta property="og:image" content="${site.origin}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The ${site.productName} logo: a white shield with a tick on a blue-to-violet background">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${SPRITE}
<header class="site-header">
<div class="wrap bar">
<a class="brand" href="/" aria-label="${site.productName} home">${inlineLogo('logo-header', 30)}${site.productName}</a>
<nav class="nav" aria-label="Main">
${nav.map(link)}
</nav>
<a class="btn btn-primary btn-sm" href="/download/"${current(page, 'download')}>${icon('download')}${installer === null ? 'Coming soon' : 'Download free'}</a>
<details class="menu">
<summary aria-label="Open menu">${icon('menu')}</summary>
<nav class="menu-panel" aria-label="Main (compact)">
${compactNav.map(link)}
</nav>
</details>
</div>
</header>
<main id="main" tabindex="-1">
${page.main}
</main>
${footer(page, site)}
</body>
</html>
`

  return html.value
}

/**
 * The footer. The full postal address is on /support/ (contact) and in the
 * legal documents; here, only the town.
 *
 * @param {Page} page
 * @param {SiteConfig} site
 * @returns {Html}
 */
function footer(page, site) {
  return markup`<footer class="site-footer">
<div class="wrap">
<div class="f-grid">
<div class="f-brand">
<a class="brand" href="/" aria-label="${site.productName} home">${inlineLogo('logo-footer', 30)}${site.productName}</a>
<p>Read-only data recovery for Windows 10 and 11. Your files stay on your PC.</p>
</div>
<nav class="f-col" aria-labelledby="f-product">
<h2 id="f-product">Product</h2>
<ul><li><a href="${homeAnchor(page, 'features')}">Features</a></li><li><a href="${homeAnchor(page, 'pricing')}">Pricing</a></li><li><a href="/download/">Download</a></li><li><a href="/releases/">Releases</a></li></ul>
</nav>
<nav class="f-col" aria-labelledby="f-help">
<h2 id="f-help">Help</h2>
<ul><li><a href="/support/">Support</a></li><li><a href="/support/#activate-offline">Offline activation</a></li><li><a href="/support/#move-licence">Move a licence</a></li><li><a href="/buy/#how-to-buy">How to buy</a></li></ul>
</nav>
<div class="f-col">
<h2 id="f-company">Company</h2>
<ul><li><a href="${site.vendor.url}">${site.vendor.shortName}</a></li><li><a href="mailto:${site.email}">${site.email}</a></li><li class="muted">${site.vendor.town}</li></ul>
</div>
<nav class="f-col" aria-labelledby="f-legal">
<h2 id="f-legal">Legal</h2>
<ul><li><a href="/privacy/">Privacy</a></li><li><a href="/terms/">Terms</a></li></ul>
</nav>
</div>
<div class="f-base">
<p>© ${site.copyrightYear} ${site.vendor.legalName}</p>
<p>No cookies. No trackers. No uploads.</p>
</div>
</div>
</footer>`
}

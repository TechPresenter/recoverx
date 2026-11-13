# RecoverX website

The public site at **https://recoverx.snapkio.com/**: home page, editions and pricing, download, support and documentation, release notes, privacy policy and licence terms. It is plain static files — no server code, no JavaScript, no cookies, nothing loaded from anyone else's server — built by `website/build.mjs` into `dist/website/` and uploaded to `public_html/` on the AWS server (deploy/aws-ec2/README.md).

| Page          | URL          | Source                                                      |
| ------------- | ------------ | ----------------------------------------------------------- |
| Home          | `/`          | `lib/pages.mjs`                                             |
| Pricing       | `/buy/`      | `lib/pages.mjs`, prices in `site.config.mjs`                |
| Download      | `/download/` | `content/release.json`, Store link in `site.config.mjs`     |
| Support, docs | `/support/`  | `lib/pages.mjs` (the app's `DOCS_URL` points here)          |
| Release notes | `/releases/` | `content/releases.json`                                     |
| Privacy       | `/privacy/`  | **generated** from `docs/store/privacy-policy.md`           |
| Licence terms | `/terms/`    | **generated** from `LICENSE` (the EULA the installer shows) |
| Not found     | `/404.html`  | `lib/pages.mjs`                                             |

The privacy policy and the licence terms are not copied into the website: the build reads the repository's own documents every time, so the site can never publish a different text from the one the product ships. Edit those files, rebuild, upload.

## Look and feel

The design is "Night & Paper", approved in November 2026: every page opens on a dark **night** surface (header, hero or page title) and continues on **paper** that follows the visitor's light or dark setting; night returns only for the home page's features, the closing call to action and the footer. Everything is in one stylesheet, `assets/site.css` — tokens on `:root`, redefined for dark mode — and the class names are the design's own (`band`, `sec-head`, `plan`, `know`, `types-note`, …). The header and footer, with the icon sprite every page carries, are in `lib/layout.mjs`; the page bodies, including the hero's SVG illustration of the app, are in `lib/pages.mjs`.

Two rules keep it honest. The illustration and every card show only what the app really does (grades Excellent, Good, Fair, Poor or Unknown; never the source drive as a destination; never more than the 1 GB Free allowance). And the disclaimers live in the calm "Good to know" panels, never in alarm colours.

## Build

```sh
npm run website:build
```

The build exits non-zero, and says why, if anything below is not true:

- **The legal documents are finished.** A `[[…]]` or `{{…}}` placeholder, the word `DRAFT`, "not yet in force", an "Engineering note", or the domain the product used before recoverx.snapkio.com in `docs/store/privacy-policy.md` or `LICENSE` stops the build: publishing the page makes it binding. `--allow-draft` builds anyway for a local look, with a warning — **never upload that build**.
- **Every section was rendered.** The headings in each source are counted independently of the converter and compared with the page.
- **Every page is well-formed** (no unclosed, misnested or duplicated elements, ids or attributes; no stray `<` or `&`; one `<h1>`, one `<main>`; no skipped heading levels).
- **Every internal link resolves** to a file in the build — including `#anchors`, the canonical and Open Graph URLs, `sitemap.xml` and `robots.txt` — and ends in `/` where it names a page. Links into `/downloads/` and `/updates/` are not checked: those files are uploaded separately (below).
- **Nothing is written into a path the website does not own**: `.htaccess`, `v1/`, `admin/`, `setup/`, `healthz` (the licence server), `downloads/`, `updates/` (release files).
- **Nothing depends on what the Content-Security-Policy blocks**: no `style=""` attribute, `<style>` or `<script>` element, or `on…=` handler. A browser drops those silently, so a template that used one would look right in review and broken on the site.
- `content/release.json` and `releases.json` are valid and agree with each other.

Other commands:

| Command                                  | What it does                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `node website/serve.mjs`                 | Serves `dist/website/` at http://127.0.0.1:4173/ the way the host does (`/x/` → `x/index.html`, 404 page).                    |
| `node website/build.mjs --out <dir>`     | Builds somewhere else.                                                                                                        |
| `node website/build.mjs --content <dir>` | Reads `release.json` and `releases.json` from another folder, to preview a release before committing it.                      |
| `node --test website/tests/`             | Unit tests for the markdown and licence converters, the checks, and the pages in every release, Store and payment-link state. |
| `npx tsc -p website/tsconfig.json`       | Type-checks the build scripts (plain JavaScript with JSDoc types, at the repository's strictness).                            |

## Upload

`public_html/` on recoverx.snapkio.com holds four things, uploaded by different steps. Only the first comes from this build:

```text
public_html/
├── index.html, 404.html, robots.txt, sitemap.xml,      ← the CONTENTS of dist/website/
│   favicon.svg, apple-touch-icon.png, og-image.png,
│   assets/site.<hash>.css,
│   buy/ download/ support/ releases/ privacy/ terms/
├── .htaccess, v1/, admin/, setup/                       ← server-php/public — the licence server (server-php/README.md)
├── downloads/win/<version>/RecoverX-Setup-<version>-x64.exe   ← one folder per release, never replaced
└── updates/win/latest/                                  ← the app's update feed (docs/RELEASE.md, step 6)
```

1. `npm run website:build`.
2. Upload the **contents** of `dist/website/` (not the folder itself) over `public_html/` on the AWS server — the one-line `tar … | ssh` command is in [deploy/aws-ec2/README.md → Deploying](../deploy/aws-ec2/README.md#deploying). The build contains no `.htaccess` and nothing under the licence server's or the release folders, so this upload cannot overwrite them.
3. The stylesheet's name changes whenever its content does; older `assets/site.*.css` files can be deleted.
4. There is no CDN in front, so the new pages are live at once. Check them.

**The 404 page** is used only if the server is told to: the root `.htaccess` (owned by `server-php/public`) needs `ErrorDocument 404 /404.html`.

The pages carry their own Content-Security-Policy (`default-src 'none'; style-src 'self'; img-src 'self'`), so a browser refuses anything not served by the site itself — which is what keeps the privacy policy's "the website sets no cookies and loads nothing from anyone else" true. `frame-ancestors` cannot be set from a page; add it to the server's headers if wanted.

## Change prices, the payment link or the Store link

All in `site.config.mjs`, then build and upload:

- **Prices and editions**: `editions`. Keep them in step with the Store listing (`docs/store/listing.en-US.md`) and the licence server's admin hints.
- **Payment link**: `paymentLinkUrl` — the Razorpay/UPI link, an `https://` URL. While it is `null`, licences are sold by email and no "Pay online" button appears; once set, /buy/ and the renewal instructions on /support/ offer it.
- **Microsoft Store**: `storeUrl` — the listing's `https://` URL once Partner Center publishes it. While it is `null`, the site says "Coming soon to the Microsoft Store".
- **Move allowance**: `moveAllowance` — must match `LICENSE_SELF_RELEASE_LIMIT` / `LICENSE_SELF_RELEASE_WINDOW_DAYS` on the licence server.

Everything the site says about what RecoverX does lives in `lib/pages.mjs`, and every sentence there is true of the code — checked against `docs/store/listing.en-US.md` and `src/main/{scan,disk,health,recovery,preview,licensing}`. Store Policy 10.1.1 forbids claiming what the product does not do, and this site is where the Store listing sends people. When a feature changes, change the page in the same commit. Never claim a feature the code does not have — machine learning or "AI" included — and never promise that a file can be recovered.

## Publish a release

The installer is offered at an immutable, versioned URL: `/downloads/win/<version>/RecoverX-Setup-<version>-x64.exe`. A published file is never replaced, renamed or deleted — Partner Center and customers mid-download may still fetch it. A fix is a new version at a new URL.

1. **Build and sign** with `npm run package:store` (docs/MICROSOFT-STORE.md). It writes the signed and verified installer to `release/<version>/store/RecoverX-Setup-<version>-x64.exe`.
2. **Write the release notes**: add an entry at the top of `website/content/releases.json` with the version, a title, plain-sentence notes that are true of the code, and the upload date as `"date": "YYYY-MM-DD"`.
3. **Point the download page at it**:

   ```sh
   node website/release.mjs release/<version>/store/RecoverX-Setup-<version>-x64.exe
   ```

   This writes `content/release.json` — version, file name, size and SHA-256 — from the file itself. It refuses a `NOT-FOR-SUBMISSION` build, a file not named `RecoverX-Setup-<version>-x64.exe`, and a version whose release notes are missing or dated differently.

4. **Upload the installer** to `public_html/downloads/win/<version>/` — a new folder — and check that `https://recoverx.snapkio.com/downloads/win/<version>/RecoverX-Setup-<version>-x64.exe` downloads with the size and SHA-256 that `release.mjs` printed.
5. **Update feed**: upload to `public_html/updates/win/latest/` the files electron-builder wrote to `release/<version>/` — `RecoverX-Setup-<version>-x64.exe`, its `.blockmap`, and **`latest.yml` last** (it names the installer by electron-builder's file name, so that exact file must sit beside it). Details and rollback: docs/RELEASE.md.
6. **Website**: `npm run website:build`, upload the contents of `dist/website/` as above, purge the CDN cache, and open `/download/` and `/releases/` on the live site.
7. Commit `website/content/`.

Until the first installer is published, `content/release.json` holds `"installer": null`: the download page says the first release is being prepared, and the site's download buttons say "Download — coming soon".

## Files

```text
website/
├── build.mjs           the build: reads, renders, writes, checks
├── release.mjs         stamps content/release.json from an installer
├── serve.mjs           local preview server
├── site.config.mjs     origin, vendor, contact, prices, payment and Store links
├── content/            release.json (the download), releases.json (the notes)
├── assets/site.css     the one stylesheet (light and dark)
├── lib/
│   ├── html.mjs        escaping and the `markup` template tag
│   ├── markdown.mjs    the safe markdown converter (privacy policy)
│   ├── licence.mjs     the plain-text licence reader (LICENSE)
│   ├── layout.mjs      head, header, footer, Content-Security-Policy
│   ├── pages.mjs       every page's content
│   ├── logo.mjs        the shield mark: inline SVG, favicon, PNG images
│   ├── content.mjs     reading and checking content/*.json
│   └── checks.mjs      well-formedness, links, reserved paths
└── tests/              node --test website/tests/
```

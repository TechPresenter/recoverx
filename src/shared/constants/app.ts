/**
 * Immutable product identity and infrastructure names.
 *
 * Everything here is compiled into both processes, so it must stay free of any
 * Node, Electron or React dependency. Values that differ per machine (absolute
 * paths, versions) are resolved at runtime in the main process instead.
 */

/** Human-readable product name, shown in the title bar, installer and About screen. */
export const APP_NAME = 'RecoverX'

/** Reverse-DNS application identifier — must match `appId` in electron-builder.yml. */
export const APP_ID = 'in.appsgain.recoverx'

/** Vendor folder name used under %APPDATA% for the user-data directory. */
export const APP_DATA_FOLDER = 'RecoverX'

/** SQLite database file name inside the user-data directory. */
export const DATABASE_FILE_NAME = 'recoverx.db'

/** Sub-directory of the user-data directory that holds rotated Winston logs. */
export const LOG_DIR_NAME = 'logs'

/** Base name of the rotating log files (a date suffix is appended per day). */
export const LOG_FILE_PREFIX = 'recoverx'

/**
 * The company behind the product.
 *
 * Separate from the product constants above because they answer different
 * questions: `APP_NAME` is what the software is called, this is who is
 * accountable for it. Support, licensing and the copyright notice all key off
 * the vendor, and a rename of either must not silently rewrite the other.
 */
export const VENDOR_NAME = 'Appsgain Technologies'
export const VENDOR_URL = 'https://appsgain.in'
export const COPYRIGHT_YEAR = 2026
export const COPYRIGHT_NOTICE = `© ${COPYRIGHT_YEAR} ${VENDOR_NAME}. All Rights Reserved.`

/** The vendor's own mailbox, named in support sentences and the fatal-error dialog. */
export const SUPPORT_EMAIL = 'info@appsgain.in'

/**
 * The product's public home.
 *
 * Everything a customer is sent to lives on this one host, which the vendor
 * controls: the website, its support and privacy pages, the shop, the update
 * feed and the licence API. A link to a domain someone else owns can be bought
 * out from under the product and made to serve anything, and every copy ever
 * installed would keep opening it.
 *
 * No trailing slash on the origin, because the licence server writes it into
 * customer-facing sentences ("Renew it at …"); the pages beneath it carry
 * theirs, matching the directories the static site is built into, so a click
 * lands on the page rather than on a redirect to it.
 */
export const WEBSITE_URL = 'https://recoverx.snapkio.com'
export const DOCS_URL = `${WEBSITE_URL}/support/`
export const PRIVACY_URL = `${WEBSITE_URL}/privacy/`
export const RELEASE_NOTES_URL = `${WEBSITE_URL}/releases/`

/**
 * Where a licence is bought or renewed.
 *
 * On the product's own host, which is already in the external allowlist below,
 * so the purchase path never needs that list widened. It carries no query
 * string: nothing about this machine or its licence belongs in a URL that ends
 * up in browser history and the shop's access logs.
 */
export const PURCHASE_URL = `${WEBSITE_URL}/buy/`

/**
 * Hosts the renderer is allowed to hand to the OS browser. Any other target is
 * refused by the navigation guard in the main process — this is the mitigation
 * for a compromised renderer trying to exfiltrate data through `window.open`.
 *
 * Only hosts the application actually links to, and only domains the vendor
 * controls: the vendor's site (`VENDOR_URL`) and the product's own host above.
 */
export const ALLOWED_EXTERNAL_HOSTS: readonly string[] = [
  'appsgain.in',
  'www.appsgain.in',
  'recoverx.snapkio.com',
]

/** Commercial editions. Enforcement lands with the Activation module. */
export const LICENSE_EDITIONS = [
  'free',
  'professional',
  'business',
  'technician',
  'enterprise',
] as const

export type LicenseEdition = (typeof LICENSE_EDITIONS)[number]

/** Recovery ceiling for the Free edition, in bytes (1 GiB). */
export const FREE_EDITION_RECOVERY_LIMIT_BYTES = 1024 * 1024 * 1024

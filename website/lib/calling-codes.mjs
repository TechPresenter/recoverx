import { URL, fileURLToPath } from 'node:url'
import { ContentError, readJson } from './content.mjs'

/**
 * The country codes the order form offers for the mobile number.
 *
 * The list is the licence server's own (server-php/app/src/Order/
 * calling-codes.json), read at build time rather than copied, so the form can
 * never offer a country the server would refuse. It maps ISO 3166-1 alpha-2
 * codes to calling codes; several countries share one (+1, +7, +44 …), which
 * is why the form posts the ISO code and the server looks the calling code up.
 * Country names come from the runtime's own region names in English.
 */

const SOURCE = fileURLToPath(
  new URL('../../server-php/app/src/Order/calling-codes.json', import.meta.url),
)

/** The country selected when the form opens. */
export const DEFAULT_PHONE_COUNTRY = 'IN'

/**
 * The browser's check of the national number (the `pattern` attribute):
 * digits, spaces, brackets and hyphens, 4 to 20 characters. No `+` — the
 * country code comes from the list. Browsers compile `pattern` with the `v`
 * flag, so the brackets and the hyphen are escaped inside the class. The
 * server applies the same rule and then counts the digits (E.164).
 */
export const PHONE_PATTERN = String.raw`[0-9 \(\)\-]{4,20}`

/**
 * @typedef {object} PhoneCountry
 * @property {string} iso ISO 3166-1 alpha-2 code: the value the form posts.
 * @property {string} dial Calling code, digits only.
 * @property {string} name The country's name in English.
 */

/** @type {readonly PhoneCountry[] | null} */
let cached = null

/**
 * Every country in the server's list, sorted by name.
 *
 * @returns {readonly PhoneCountry[]}
 */
export function phoneCountries() {
  cached ??= readPhoneCountries(SOURCE)
  return cached
}

/**
 * @param {string} source Path of a calling-codes.json.
 * @returns {readonly PhoneCountry[]}
 */
export function readPhoneCountries(source) {
  const data = readJson(source)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ContentError(`${source}: expected an object of ISO code → calling code`)
  }

  const regions = new Intl.DisplayNames(['en'], { type: 'region' })
  const countries = Object.entries(data).map(([iso, dial]) => {
    if (!/^[A-Z]{2}$/u.test(iso) || typeof dial !== 'string' || !/^[1-9][0-9]{0,2}$/u.test(dial)) {
      throw new ContentError(
        `${source}: ${JSON.stringify(iso)} → ${JSON.stringify(dial)} is not an ISO code and a calling code`,
      )
    }
    const name = regions.of(iso)
    // DisplayNames answers with the code itself for a region it does not know.
    if (name === undefined || name === iso) {
      throw new ContentError(`${source}: no English name for the region ${iso}`)
    }
    return { iso, dial, name }
  })

  if (!countries.some((country) => country.iso === DEFAULT_PHONE_COUNTRY)) {
    throw new ContentError(`${source}: the default country ${DEFAULT_PHONE_COUNTRY} is missing`)
  }

  return countries.sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.iso.localeCompare(b.iso, 'en'),
  )
}

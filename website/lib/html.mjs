/**
 * Escaping, and the one way pages put markup together.
 *
 * Every page on the site is a template literal, and the classic failure of
 * that style is an interpolation that forgets to escape: one product name with
 * an ampersand, or one line of the privacy policy with a `<`, and the page is
 * malformed or worse. So templates go through `markup`, which escapes every
 * value it is given unless that value is itself the output of `markup` (or of
 * `trusted`, which exists for the converters and the logo). Safe is the
 * default; raw HTML has to be asked for by name, which makes it greppable.
 */

/**
 * Markup that has already been built safely and may be inserted as is.
 *
 * A class rather than a branded string, so a plain string can never pass for
 * one by accident.
 */
export class Html {
  /** @param {string} value */
  constructor(value) {
    /** @readonly */
    this.value = value
  }

  toString() {
    return this.value
  }
}

/**
 * Anything a template may interpolate. `null`, `undefined` and `false` render
 * as nothing, so optional fragments read as `${condition && markup`…`}`.
 * Arrays may nest; their items are checked as they are rendered (JSDoc cannot
 * spell a recursive type), and anything else — a stray object — is refused
 * rather than printed as "[object Object]".
 *
 * @typedef {Html | string | number | boolean | null | undefined | readonly unknown[]} Fragment
 */

const ESCAPES = /** @type {const} */ ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})

/**
 * Escape text for use in element content or in a double- or single-quoted
 * attribute. One function for both, because the cost of also escaping quotes
 * in text is nothing and the cost of choosing wrongly is an injection.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/gu, (character) => ESCAPES[/** @type {keyof ESCAPES} */ (character)])
}

/**
 * Mark a string as markup. Only for strings this site produced itself — the
 * markdown converter's output, the inline logo — never for content read from
 * a file.
 *
 * @param {string} value
 * @returns {Html}
 */
export function trusted(value) {
  return new Html(value)
}

/**
 * @param {unknown} fragment
 * @returns {string}
 */
function render(fragment) {
  if (fragment === null || fragment === undefined || typeof fragment === 'boolean') return ''
  if (fragment instanceof Html) return fragment.value
  if (typeof fragment === 'number') return String(fragment)
  if (typeof fragment === 'string') return escapeHtml(fragment)
  if (Array.isArray(fragment)) return fragment.map(render).join('')
  throw new TypeError(`A template was given something it cannot render: ${typeof fragment}`)
}

/**
 * The template tag every page is written with.
 *
 * @param {TemplateStringsArray} strings
 * @param {readonly Fragment[]} values
 * @returns {Html}
 */
export function markup(strings, ...values) {
  let out = strings[0] ?? ''

  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '')
  })

  return new Html(out)
}

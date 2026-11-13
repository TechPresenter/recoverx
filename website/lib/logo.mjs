import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import { trusted } from './html.mjs'

/**
 * The product mark, for the web.
 *
 * The same drawing as the application icon — a white shield with a tick
 * punched out of it, on a rounded square running from the accent blue to the
 * accent violet — so the site and the taskbar can never disagree about what
 * the product looks like. The geometry is copied from
 * scripts/generate-icon.mjs, which draws the .ico and the Store art, rather
 * than imported from it, because that script writes files as soon as it is
 * loaded. **Change the two together.**
 *
 * The icon script describes the shield as a function of height (a flat top
 * that flares slightly over its upper 30 %, then a quarter ellipse down to
 * the point); in a 64-unit box that is exactly the path below, two straight
 * edges and two elliptical arcs, so the vector mark is the raster one, not a
 * lookalike.
 */

export const GRADIENT_FROM = '#3B6FE0'
export const GRADIENT_TO = '#7C4DE8'

/** The shield, in a 64 × 64 box. See `insideShield` for the same shape. */
const SHIELD_PATH =
  'M17.862 12.8H46.138L47.04 24.704A15.04 27.776 0 0 1 32 52.48A15.04 27.776 0 0 1 16.96 24.704Z'

/** The tick: two strokes with round ends, as `insideTick` measures them. */
const TICK_PATH = 'M27.2 33.92 30.592 38.4 37.44 28.16'
const TICK_WIDTH = 3.968

/**
 * The mark as an SVG document or fragment.
 *
 * `id` keeps the gradient and mask ids unique when the mark appears more than
 * once on a page. `radius` is the corner radius as a fraction of the size:
 * the icon script uses 0.24 at favicon sizes, where a smaller radius reads as
 * a square, and 0.21 above.
 *
 * `className` is for the page's stylesheet (the glowing mark above the final
 * call to action is `cta-mark`); it is a fixed word from a template, never
 * text from a file.
 *
 * @param {{ id: string, size?: number, radius?: number, standalone?: boolean, className?: string | undefined }} options
 * @returns {string}
 */
export function logoSvg({ id, size = 32, radius = 0.21, standalone = false, className }) {
  const namespace = standalone ? ' xmlns="http://www.w3.org/2000/svg"' : ''
  const presentation = standalone ? '' : ' aria-hidden="true" focusable="false"'
  const classes = className === undefined ? '' : ` class="${className}"`
  const r = String(Math.round(radius * 64 * 100) / 100)

  return (
    `<svg${namespace}${classes} viewBox="0 0 64 64" width="${size}" height="${size}"${presentation}>` +
    `<defs>` +
    `<linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${GRADIENT_FROM}"/><stop offset="1" stop-color="${GRADIENT_TO}"/>` +
    `</linearGradient>` +
    `<mask id="${id}-m"><rect width="64" height="64" fill="#fff"/>` +
    `<path d="${TICK_PATH}" fill="none" stroke="#000" stroke-width="${TICK_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</mask>` +
    `</defs>` +
    `<rect width="64" height="64" rx="${r}" fill="url(#${id}-g)"/>` +
    `<path d="${SHIELD_PATH}" fill="#fff" mask="url(#${id}-m)"/>` +
    `</svg>`
  )
}

/**
 * The mark for use inside a page.
 *
 * @param {string} id
 * @param {number} [size]
 * @param {string} [className]
 */
export function inlineLogo(id, size = 32, className) {
  return trusted(logoSvg({ id, size, className }))
}

/** `favicon.svg`: the small-size corner radius, as the .ico uses at 16–32 px. */
export function faviconSvg() {
  return `${logoSvg({ id: 'rx', size: 64, radius: 0.24, standalone: true })}\n`
}

// --- Raster versions ----------------------------------------------------------
//
// Two images cannot be SVG: the Open Graph preview (chat apps and social sites
// do not render SVG) and the Apple touch icon. Both are drawn here with the
// icon script's own shape tests and written as PNG by hand, as that script
// does — an image library to draw one shape is not worth the dependency.

/**
 * @param {number} x Normalised 0..1.
 * @param {number} y Normalised 0..1.
 */
function insideShield(x, y) {
  const top = 0.2
  const bottom = 0.82
  const halfWidth = 0.235
  if (y < top || y > bottom) return false

  const t = (y - top) / (bottom - top)
  const dx = Math.abs(x - 0.5)
  let width
  if (t < 0.3) {
    width = halfWidth * (0.94 + 0.06 * (t / 0.3))
  } else {
    const taper = (t - 0.3) / 0.7
    width = halfWidth * Math.sqrt(Math.max(0, 1 - taper * taper))
  }
  return dx <= width
}

/**
 * @param {number} px
 * @param {number} py
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared))
  const nx = x1 + t * dx - px
  const ny = y1 + t * dy - py
  return Math.sqrt(nx * nx + ny * ny)
}

/**
 * @param {number} x
 * @param {number} y
 */
function insideTick(x, y) {
  return (
    distanceToSegment(x, y, 0.425, 0.53, 0.478, 0.6) <= 0.031 ||
    distanceToSegment(x, y, 0.478, 0.6, 0.585, 0.44) <= 0.031
  )
}

/** @param {string} hex */
function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/**
 * Draw the mark full-bleed: the gradient fills the whole image, corner to
 * corner, and the shield sits centred in a square `markSize` pixels wide.
 * No rounded corners — iOS rounds a touch icon itself, and a preview card
 * is cropped by whoever shows it.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} markSize
 * @returns {Buffer} RGB, 3 bytes per pixel.
 */
function drawMark(width, height, markSize) {
  const pixels = Buffer.alloc(width * height * 3)
  const from = rgb(GRADIENT_FROM)
  const to = rgb(GRADIENT_TO)
  const left = (width - markSize) / 2
  const top = (height - markSize) / 2
  const samples = 4

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      let coverage = 0
      const nearMark =
        px >= left - 1 && px <= left + markSize + 1 && py >= top - 1 && py <= top + markSize + 1

      if (nearMark) {
        for (let sy = 0; sy < samples; sy += 1) {
          for (let sx = 0; sx < samples; sx += 1) {
            const x = (px + (sx + 0.5) / samples - left) / markSize
            const y = (py + (sy + 0.5) / samples - top) / markSize
            if (insideShield(x, y) && !insideTick(x, y)) coverage += 1
          }
        }
        coverage /= samples * samples
      }

      const mix = (px / width + py / height) / 2
      const offset = (py * width + px) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        const a = from[channel] ?? 0
        const b = to[channel] ?? 0
        const background = a + (b - a) * mix
        pixels[offset + channel] = Math.round(background + (255 - background) * coverage)
      }
    }
  }

  return pixels
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgbPixels
 */
function encodePng(width, height, rgbPixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  // Compression, filter and interlace methods are all 0.

  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0 // filter: none
    rgbPixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The Open Graph preview image, 1200 × 630 — the size every network crops to. */
export function openGraphPng() {
  return encodePng(1200, 630, drawMark(1200, 630, 560))
}

/** The Apple touch icon, 180 × 180. */
export function touchIconPng() {
  return encodePng(180, 180, drawMark(180, 180, 200))
}

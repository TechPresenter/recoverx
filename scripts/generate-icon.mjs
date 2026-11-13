#!/usr/bin/env node
import { deflateSync } from 'node:zlib'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Generate the application icon and the Microsoft Store artwork.
 *
 * Run with `npm run icon`. Writes:
 *
 *  - `build/icon.ico` and `build/icon.png` — embedded by electron-builder in the
 *    executable and the installer.
 *  - `build/store/` — the Partner Center listing art: the required 1:1 box art
 *    (1080 and 2160 px) and a 300 px Store logo. Uploaded by hand; see
 *    docs/MICROSOFT-STORE.md.
 *  - `build/appx/` — the tile and logo set an MSIX package needs. electron-builder
 *    reads this directory for the optional MSIX route, and silently substitutes
 *    its own "SampleAppx" placeholder images for any of the four required logos
 *    it does not find here — placeholders that would then ship to customers.
 *
 * The icon is drawn here rather than checked in as a binary for one practical
 * reason: an .ico is opaque to review. A change to a committed binary is
 * invisible in a diff, so nobody can tell whether the shipped icon is the one
 * that was approved. Generating it means the *drawing* is reviewable, and the
 * artefact is reproducible from it. The Store artwork is generated from the
 * same drawing for the same reason, and so the listing can never drift from the
 * icon on the customer's taskbar.
 *
 * PNG and ICO are both written by hand. Both are simple container formats, and
 * an image dependency to draw one shape is not worth the supply chain.
 */

// --- Geometry --------------------------------------------------------------

/** Sizes Windows asks for: taskbar, Explorer at every zoom, and the installer. */
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Samples per axis. Nothing here is curved enough to need more than 4. */
const SUPERSAMPLE = 4

/** Accent endpoints, matching --rx-accent / --rx-accent-alt for the blue theme. */
const GRADIENT_FROM = [59, 111, 224]
const GRADIENT_TO = [124, 77, 232]

/**
 * Is this point inside the rounded square?
 *
 * Coordinates are normalised to 0..1 across the canvas.
 */
function insideSquircle(x, y, radius) {
  const dx = Math.min(x, 1 - x)
  const dy = Math.min(y, 1 - y)

  if (dx >= radius || dy >= radius) return true

  // Only the corner quadrants need the distance test.
  const cx = radius - dx
  const cy = radius - dy
  return cx * cx + cy * cy <= radius * radius
}

/**
 * Is this point inside the shield?
 *
 * The shield is the product mark: a flat top with rounded shoulders that tapers
 * to a point. Width is described as a function of height, which keeps the
 * silhouette identical at every size instead of drifting as it is rescaled.
 */
function insideShield(x, y) {
  // Normalise into the shield's own box.
  const top = 0.2
  const bottom = 0.82
  const halfWidth = 0.235

  if (y < top || y > bottom) return false

  const t = (y - top) / (bottom - top)
  const dx = Math.abs(x - 0.5)

  // The upper 30% is a rounded-shoulder rectangle; below that it tapers along
  // an ellipse to a point, which is what reads as a shield rather than a badge.
  let width
  if (t < 0.3) {
    const shoulder = t / 0.3
    width = halfWidth * (0.94 + 0.06 * shoulder)
  } else {
    const taper = (t - 0.3) / 0.7
    width = halfWidth * Math.sqrt(Math.max(0, 1 - taper * taper))
  }

  return dx <= width
}

/** The tick inside the shield. Drawn as two thick strokes. */
function insideTick(x, y) {
  const strokes = [
    // [x1, y1, x2, y2, half-thickness]
    [0.425, 0.53, 0.478, 0.6, 0.031],
    [0.478, 0.6, 0.585, 0.44, 0.031],
  ]

  return strokes.some(([x1, y1, x2, y2, half]) => distanceToSegment(x, y, x1, y1, x2, y2) <= half)
}

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

// --- Rasterising -----------------------------------------------------------

function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4)
  // Small icons need a proportionally larger corner radius or they read square.
  const radius = size <= 32 ? 0.24 : 0.21
  const step = 1 / (size * SUPERSAMPLE)

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let alpha = 0
      let markCoverage = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step
          const y = (py * SUPERSAMPLE + sy + 0.5) * step

          if (!insideSquircle(x, y, radius)) continue
          alpha += 1

          // The tick is punched out of the shield rather than drawn over it, so
          // it stays crisp at 16 pixels where an outline would turn to mud.
          if (insideShield(x, y) && !insideTick(x, y)) markCoverage += 1
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE
      const offset = (py * size + px) * 4

      if (alpha === 0) continue

      // The gradient runs corner to corner, matching the 135° CSS gradient.
      const mix = (px / size + py / size) / 2
      const background = [
        Math.round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * mix),
        Math.round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * mix),
        Math.round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * mix),
      ]

      const mark = markCoverage / samples
      pixels[offset] = Math.round(background[0] + (255 - background[0]) * mark)
      pixels[offset + 1] = Math.round(background[1] + (255 - background[1]) * mark)
      pixels[offset + 2] = Math.round(background[2] + (255 - background[2]) * mark)
      pixels[offset + 3] = Math.round((alpha / samples) * 255)
    }
  }

  return pixels
}

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)

  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }

  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)

  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))

  return Buffer.concat([length, body, crc])
}

/**
 * Encode RGBA pixels as a PNG.
 *
 * `filtered` selects per-scanline adaptive filtering. The application icon is
 * written unfiltered, exactly as it always has been, so its bytes do not change
 * under this script's growth. The Store artwork needs the filters: a 620 px
 * gradient tile is several hundred kilobytes unfiltered, and MSIX tile assets
 * must stay under 200 KB.
 */
function encodePng(width, height, rgba, filtered = false) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(6, 9) // colour type: RGBA
  header.writeUInt8(0, 10)
  header.writeUInt8(0, 11)
  header.writeUInt8(0, 12)

  const raw = filtered
    ? filterScanlines(width, height, rgba)
    : unfilteredScanlines(width, height, rgba)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function unfilteredScanlines(width, height, rgba) {
  // Each scanline is prefixed with its filter type. Zero — no filtering — costs
  // a little size on a gradient and keeps this encoder trivially verifiable.
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return raw
}

/**
 * Apply the PNG filter that suits each scanline best.
 *
 * The standard heuristic from the PNG specification (section 12.8): try all
 * five filters and keep the one whose output has the smallest sum of absolute
 * values, read as signed bytes. A smooth gradient becomes runs of near-zero
 * residuals under Sub or Up, which deflate collapses almost entirely.
 */
function filterScanlines(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  const candidate = Buffer.alloc(stride)
  const best = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    const previous = y === 0 ? -1 : row - stride
    let bestType = 0
    let bestScore = Infinity

    for (let type = 0; type <= 4; type += 1) {
      let score = 0

      for (let i = 0; i < stride; i += 1) {
        const value = rgba[row + i]
        const left = i >= 4 ? rgba[row + i - 4] : 0
        const up = previous >= 0 ? rgba[previous + i] : 0
        const upLeft = previous >= 0 && i >= 4 ? rgba[previous + i - 4] : 0

        let predicted = 0
        if (type === 1) predicted = left
        else if (type === 2) predicted = up
        else if (type === 3) predicted = (left + up) >> 1
        else if (type === 4) predicted = paeth(left, up, upLeft)

        const residual = (value - predicted) & 0xff
        candidate[i] = residual
        score += residual < 128 ? residual : 256 - residual
      }

      if (score < bestScore) {
        bestScore = score
        bestType = type
        candidate.copy(best)
      }
    }

    raw[y * (stride + 1)] = bestType
    best.copy(raw, y * (stride + 1) + 1)
  }

  return raw
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)

  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  if (toUp <= toUpLeft) return up
  return upLeft
}

// --- ICO -------------------------------------------------------------------

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let offset = header.length + directory.length

  entries.forEach((entry, index) => {
    const base = index * 16
    // 256 is stored as 0: the field is one byte and 256 does not fit.
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base)
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1)
    directory.writeUInt8(0, base + 2) // palette size
    directory.writeUInt8(0, base + 3)
    directory.writeUInt16LE(1, base + 4) // colour planes
    directory.writeUInt16LE(32, base + 6) // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

// --- Store artwork -----------------------------------------------------------

/**
 * Paint the product mark onto a canvas of any shape.
 *
 * `renderRgba` above stays exactly as it was, because the icon's bytes must not
 * change when this script learns new tricks. This is the same drawing — the same
 * squircle, shield and tick functions — placed inside a larger canvas:
 *
 *  - `mark` is the square, in canvas pixels, that the icon's unit coordinates
 *    map onto. Tiles leave margin around it; box art fills the canvas with it.
 *  - `plate: true` draws the icon as it appears on the taskbar: the gradient
 *    rounded square with the white shield. `plate: false` draws only the white
 *    shield, for a canvas whose background is already the gradient.
 *  - `background` is `'transparent'` or `'gradient'` (full bleed, opaque).
 *
 * Samples are composited with premultiplied alpha, so an anti-aliased edge over
 * a transparent background does not pick up a dark fringe.
 */
function renderArtwork({ width, height, background, mark, plate }) {
  const pixels = Buffer.alloc(width * height * 4)
  const radius = mark.size <= 32 ? 0.24 : 0.21
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      // Gradients are evaluated once per pixel, as the icon does: banding is
      // not visible at one step per pixel, and it keeps large canvases quick.
      const canvasColour = gradientAt((px / width + py / height) / 2)
      const plateColour = gradientAt(
        ((px - mark.left) / mark.size + (py - mark.top) / mark.size) / 2,
      )

      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px + (sx + 0.5) / SUPERSAMPLE
          const y = py + (sy + 0.5) / SUPERSAMPLE
          const u = (x - mark.left) / mark.size
          const v = (y - mark.top) / mark.size
          const inBox = u >= 0 && u <= 1 && v >= 0 && v <= 1
          const onShield = inBox && insideShield(u, v) && !insideTick(u, v)

          // Painted back to front. The shield lies well inside the squircle, so
          // it needs no clipping against the plate.
          let colour = background === 'gradient' ? canvasColour : null
          if (plate && inBox && insideSquircle(u, v, radius)) colour = plateColour
          if (onShield) colour = WHITE

          if (colour === null) continue
          red += colour[0]
          green += colour[1]
          blue += colour[2]
          alpha += 1
        }
      }

      if (alpha === 0) continue

      const offset = (py * width + px) * 4
      pixels[offset] = Math.round(red / alpha)
      pixels[offset + 1] = Math.round(green / alpha)
      pixels[offset + 2] = Math.round(blue / alpha)
      pixels[offset + 3] = Math.round((alpha / samples) * 255)
    }
  }

  return pixels
}

const WHITE = [255, 255, 255]

function gradientAt(mix) {
  const t = Math.max(0, Math.min(1, mix))
  return [
    Math.round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t),
    Math.round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t),
    Math.round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t),
  ]
}

/**
 * A canvas with the plated icon centred in it.
 *
 * `fill` is the share of the canvas's shorter side the icon occupies. Tiles
 * leave margin, as the Windows tile guidelines ask, so the mark does not touch
 * the tile edge; logos and app-list icons fill their canvas, because the
 * squircle already carries its own visual margin.
 */
function centredIcon(width, height, fill) {
  const size = Math.round(Math.min(width, height) * fill)
  return renderArtwork({
    width,
    height,
    background: 'transparent',
    plate: true,
    mark: { left: (width - size) / 2, top: (height - size) / 2, size },
  })
}

/**
 * The 1:1 box art Partner Center requires for every listing.
 *
 * Opaque and full bleed: the Store shows it on light and dark pages alike and
 * on its own coloured cards, where a transparent edge would look unfinished.
 * The shield is drawn bare on the gradient rather than on a second plate,
 * which would read as an icon pasted onto a background. It is inset a little
 * from the icon's own proportions because the Store crops box art to rounded
 * and circular shapes in some layouts.
 */
function boxArt(size) {
  const inset = size * 0.05
  return renderArtwork({
    width: size,
    height: size,
    background: 'gradient',
    plate: false,
    mark: { left: inset, top: inset, size: size - inset * 2 },
  })
}

/**
 * The MSIX visual asset set, as `[file name, width, height, fill]`.
 *
 * File names carry MRT qualifiers (`scale-200`, `targetsize-48`,
 * `altform-unplated`); electron-builder runs makepri over this directory when it
 * finds them, and Windows picks the closest match for the display. The four
 * logos the manifest names — StoreLogo, Square44x44Logo, Square150x150Logo and
 * Wide310x150Logo — must all be present, or the placeholders described at the
 * top of this file are used. SmallTile and LargeTile are optional; providing
 * them stops Windows 10 from upscaling the medium tile.
 *
 * The plated and unplated `targetsize` variants are the same image. The icon
 * already sits on its own rounded plate, so there is nothing for the
 * "unplated" form to remove — but Windows only uses an unplated asset for the
 * taskbar and Start when the file exists, and draws the plated one on an
 * accent-coloured square otherwise.
 */
const APPX_ASSETS = [
  ...scaled('StoreLogo', 50, 50, 1, [100, 200, 400]),
  ...scaled('Square44x44Logo', 44, 44, 1, [100, 200, 400]),
  ...[16, 24, 32, 48, 256].flatMap((size) => [
    [`Square44x44Logo.targetsize-${String(size)}.png`, size, size, 1],
    [`Square44x44Logo.targetsize-${String(size)}_altform-unplated.png`, size, size, 1],
  ]),
  ...scaled('Square150x150Logo', 150, 150, 0.6, [100, 200, 400]),
  ...scaled('Wide310x150Logo', 310, 150, 0.6, [100, 200, 400]),
  ...scaled('SmallTile', 71, 71, 0.72, [100, 200]),
  ...scaled('LargeTile', 310, 310, 0.5, [100, 200]),
]

function scaled(name, width, height, fill, scales) {
  return scales.map((scale) => [
    `${name}.scale-${String(scale)}.png`,
    Math.round((width * scale) / 100),
    Math.round((height * scale) / 100),
    fill,
  ])
}

/** The Store rejects any MSIX visual asset over this size. */
const APPX_ASSET_LIMIT_BYTES = 200 * 1024

// --- Output ----------------------------------------------------------------

const buildDir = resolve(process.cwd(), 'build')

const entries = SIZES.map((size) => ({ size, png: encodePng(size, size, renderRgba(size)) }))
const ico = encodeIco(entries)

const target = join(buildDir, 'icon.ico')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, ico)

// A 256px PNG alongside it, for the README and the web site.
writeFileSync(join(buildDir, 'icon.png'), entries[entries.length - 1].png)

process.stdout.write(
  `Wrote ${target} (${SIZES.join(', ')} px, ${(ico.length / 1024).toFixed(1)} KB)\n`,
)

// Both artwork directories are recreated rather than overwritten, so an asset
// dropped from the lists above cannot linger and be packaged by mistake.
const storeDir = join(buildDir, 'store')
rmSync(storeDir, { recursive: true, force: true })
mkdirSync(storeDir, { recursive: true })

const storeArt = [
  ['box-art-1080.png', 1080, () => boxArt(1080)],
  ['box-art-2160.png', 2160, () => boxArt(2160)],
  ['store-logo-300.png', 300, () => centredIcon(300, 300, 1)],
]

for (const [name, size, draw] of storeArt) {
  const png = encodePng(size, size, draw(), true)
  writeFileSync(join(storeDir, name), png)
  process.stdout.write(`Wrote ${join(storeDir, name)} (${String(size)} px, ${kb(png)})\n`)
}

const appxDir = join(buildDir, 'appx')
rmSync(appxDir, { recursive: true, force: true })
mkdirSync(appxDir, { recursive: true })

let appxBytes = 0
for (const [name, width, height, fill] of APPX_ASSETS) {
  const png = encodePng(width, height, centredIcon(width, height, fill), true)

  // Fail the run rather than let an oversized asset reach Partner Center, where
  // the whole package upload would be rejected for it.
  if (png.length > APPX_ASSET_LIMIT_BYTES) {
    throw new Error(`${name} is ${kb(png)}, over the 200 KB limit for MSIX visual assets`)
  }

  writeFileSync(join(appxDir, name), png)
  appxBytes += png.length
}

process.stdout.write(
  `Wrote ${appxDir} (${String(APPX_ASSETS.length)} MSIX assets, ${(appxBytes / 1024).toFixed(1)} KB)\n`,
)

function kb(buffer) {
  return `${(buffer.length / 1024).toFixed(1)} KB`
}

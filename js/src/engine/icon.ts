import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-profile window icon: concentric rings hashed from the profile name, written
 * as a Windows `.ico`. Windows only; on failure the default icon stays.
 */

// The same name always yields the same rings.
function seed(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

// Brand palette.
const TILE = { r: 0x14, g: 0x18, b: 0x10 } // dark rounded tile background
const BORDER = { r: 0xc6, g: 0xe7, b: 0x6b } // --acc lime, edge definition
const RING = { r: 0xec, g: 0xec, b: 0xe6 } // --text, the sigil rings
const DOT = { r: 0xc6, g: 0xe7, b: 0x6b } // --acc lime center dot

// Supersampling factor per axis.
const SS = 4

// Sizes embedded in the .ico; the OS picks the closest match.
const ICON_SIZES = [16, 24, 32, 48, 64]

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

/** Standard rounded-rectangle containment test (clamp point to nearest corner center). */
function insideRRect(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rad: number,
): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cxr = x < x0 + rad ? x0 + rad : x > x1 - rad ? x1 - rad : x
  const cyr = y < y0 + rad ? y0 + rad : y > y1 - rad ? y1 - rad : y
  const dx = x - cxr
  const dy = y - cyr
  return dx * dx + dy * dy <= rad * rad
}

interface Ring {
  r: number
  gapAngle: number
  rotRad: number
  op: number
}

/** Render one square icon size to a top-down RGBA byte buffer (w*h*4). */
function renderRGBA(size: number, sd: number): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  const cx = size / 2
  const cy = size / 2

  // Tile geometry (a small inset keeps the accent border off the very edge).
  const inset = 0.5
  const ox0 = inset
  const oy0 = inset
  const ox1 = size - inset
  const oy1 = size - inset
  const rrRad = size * 0.22
  const borderW = Math.max(size * 0.02, 0.8)
  const irad = Math.max(rrRad - borderW, 0)

  // Sigil geometry inside a padded inner box (same ratios as Sigil.tsx, scaled).
  const pad = size * 0.14
  const s2 = size - 2 * pad
  const rings: Ring[] = []
  for (let i = 0; i < 4; i++) {
    rings.push({
      r: s2 * (0.10625 + i * 0.125),
      gapAngle: 2 * Math.PI * (0.16 + ((sd >> (i * 3)) % 9) / 44),
      rotRad: (((sd * (i + 2) * 37) % 360) * Math.PI) / 180,
      op: 0.9 - i * 0.14,
    })
  }
  const halfStroke = Math.max(size * 0.05, 1.0) / 2
  const dotR = Math.max(size * 0.045, 1.0)
  const twoPi = 2 * Math.PI

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Accumulate premultiplied color so rounded-corner AA (opaque tile over
      // transparent background) blends correctly.
      let pr = 0
      let pg = 0
      let pb = 0
      let pa = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS
          const y = py + (sy + 0.5) / SS
          let cr = 0
          let cg = 0
          let cb = 0
          let ca = 0

          if (insideRRect(x, y, ox0, oy0, ox1, oy1, rrRad)) {
            cr = TILE.r
            cg = TILE.g
            cb = TILE.b
            ca = 1
            // Accent border band = inside outer rrect but outside the shrunk one.
            if (!insideRRect(x, y, ox0 + borderW, oy0 + borderW, ox1 - borderW, oy1 - borderW, irad)) {
              const ba = 0.65
              cr = BORDER.r * ba + cr * (1 - ba)
              cg = BORDER.g * ba + cg * (1 - ba)
              cb = BORDER.b * ba + cb * (1 - ba)
            }

            const dx = x - cx
            const dy = y - cy
            const dist = Math.sqrt(dx * dx + dy * dy)
            let theta = Math.atan2(dy, dx)
            if (theta < 0) theta += twoPi
            for (let i = 0; i < rings.length; i++) {
              const rg = rings[i]
              if (Math.abs(dist - rg.r) <= halfStroke) {
                let rel = (theta - rg.rotRad) % twoPi
                if (rel < 0) rel += twoPi
                // Single dash covering (2π - gapAngle); the gap sits at the end.
                if (rel <= twoPi - rg.gapAngle) {
                  const a = rg.op
                  cr = RING.r * a + cr * (1 - a)
                  cg = RING.g * a + cg * (1 - a)
                  cb = RING.b * a + cb * (1 - a)
                }
              }
            }

            if (dist <= dotR) {
              cr = DOT.r
              cg = DOT.g
              cb = DOT.b
            }
          }

          pr += cr * ca
          pg += cg * ca
          pb += cb * ca
          pa += ca
        }
      }

      const n = SS * SS
      const idx = (py * size + px) * 4
      if (pa > 0) {
        out[idx] = clamp255(pr / pa)
        out[idx + 1] = clamp255(pg / pa)
        out[idx + 2] = clamp255(pb / pa)
      }
      out[idx + 3] = clamp255((pa / n) * 255)
    }
  }
  return out
}

/** Encode a single size as an ICO image entry: BITMAPINFOHEADER + bottom-up BGRA + AND mask. */
function dibForImage(size: number, rgba: Uint8Array): Buffer {
  const w = size
  const h = size
  const colorSize = w * 4 * h
  const maskRow = ((w + 31) >> 5) * 4 // 1 bpp, rows padded to 32 bits
  const maskSize = maskRow * h

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(w, 4) // biWidth
  header.writeInt32LE(h * 2, 8) // biHeight = color rows + mask rows
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB
  header.writeUInt32LE(colorSize + maskSize, 20) // biSizeImage

  // DIB rows are bottom-up: file row 0 is the image's bottom row.
  const color = Buffer.alloc(colorSize)
  const mask = Buffer.alloc(maskSize)
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 4
      const d = (y * w + x) * 4
      color[d] = rgba[s + 2] // B
      color[d + 1] = rgba[s + 1] // G
      color[d + 2] = rgba[s] // R
      color[d + 3] = rgba[s + 3] // A
      // AND mask: bit set = transparent. Keep it aligned with the alpha channel
      // for legacy renderers that still consult it.
      if (rgba[s + 3] < 128) {
        mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  return Buffer.concat([header, color, mask])
}

/** Build a multi-size Windows .ico from the profile name. */
export function buildIco(seedName: string, sizes: number[] = ICON_SIZES): Buffer {
  const sd = seed(seedName)
  const images = sizes.map((s) => dibForImage(s, renderRGBA(s, sd)))
  const count = images.length

  const dir = Buffer.alloc(6 + count * 16)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type = 1 (icon)
  dir.writeUInt16LE(count, 4)

  let offset = 6 + count * 16
  images.forEach((img, i) => {
    const s = sizes[i]
    const e = 6 + i * 16
    dir.writeUInt8(s >= 256 ? 0 : s, e) // width (0 == 256)
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1) // height
    dir.writeUInt8(0, e + 2) // color count (0 == truecolor)
    dir.writeUInt8(0, e + 3) // reserved
    dir.writeUInt16LE(1, e + 4) // planes
    dir.writeUInt16LE(32, e + 6) // bit count
    dir.writeUInt32LE(img.length, e + 8) // bytes in resource
    dir.writeUInt32LE(offset, e + 12) // image offset
    offset += img.length
  })

  return Buffer.concat([dir, ...images])
}

/** Writes `<profileDir>/fp-window-icon.ico`; null on any failure. */
export function writeWindowIcon(profileDir: string, seedName: string): string | null {
  try {
    const iconPath = path.join(profileDir, 'fp-window-icon.ico')
    fs.writeFileSync(iconPath, buildIco(seedName))
    return iconPath
  } catch {
    return null
  }
}

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Per-profile window icon: concentric rings hashed from the profile name. The
 * kernel loads it through a different decoder on each platform, so the file has
 * to match: Windows takes an `.ico`, macOS and Linux a `.png`. A format the
 * decoder cannot read is not an error there - the icon silently stays default.
 */

// The same name always yields the same rings.
function seed(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

// The same layers as the app icon - graded face, dark inset panel, lime sigil -
// so a profile's window reads as part of the family instead of an unrelated
// tile. Only the sigil's gaps and rotation vary per profile.
const FACE_A = { r: 0x2f, g: 0x63, b: 0x50 }
const FACE_B = { r: 0x1b, g: 0x33, b: 0x55 }
const FACE_C = { r: 0x0b, g: 0x12, b: 0x26 }
const PANEL = { r: 0x05, g: 0x0b, b: 0x14 }
const MARK_A = { r: 0xf4, g: 0xff, b: 0xd2 }
const MARK_B = { r: 0xc0, g: 0xe4, b: 0x65 }
const PANEL_ALPHA = 0.62
// Light along the top edge, the way the app icon's rim does it. A saturated
// keyline all the way round is what made the old tile look pasted on.
const RIM_ALPHA = 0.22

interface Rgb { r: number; g: number; b: number }
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
}
/** Face gradient at a point, as a fraction along the top-left → bottom-right diagonal. */
function faceAt(t: number): Rgb {
  return t < 0.5 ? mix(FACE_A, FACE_B, t * 2) : mix(FACE_B, FACE_C, (t - 0.5) * 2)
}

// Supersampling factor per axis.
const SS = 4

// Sizes embedded in the .ico; the OS picks the closest match.
const ICON_SIZES = [16, 24, 32, 48, 64]

// PNG carries a single size. The macOS Dock draws it at 128pt, so 256px covers
// a Retina display without asking for a slower render than that.
const PNG_SIZE = 256

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

/**
 * Continuous-curvature corner, as a superellipse centred on (cx, cy) with
 * half-width `half`. An approximation of the shape the app icon uses (which is
 * built from arcs and beziers, not expressible as a containment test) - close
 * enough that the two read as the same family, and far closer than the plain
 * rounded rectangle this replaced.
 */
const SQUIRCLE_N = 5.5
function insideSquircle(x: number, y: number, cx: number, cy: number, half: number): boolean {
  if (half <= 0) return false
  const dx = Math.abs(x - cx) / half
  const dy = Math.abs(y - cy) / half
  if (dx > 1 || dy > 1) return false
  return Math.pow(dx, SQUIRCLE_N) + Math.pow(dy, SQUIRCLE_N) <= 1
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
  const c = size / 2
  const half = size / 2

  // Panel and rim are detail that only muddies the smallest .ico entries, where
  // the icon is a handful of pixels and the sigil alone has to carry it.
  const detailed = size >= 32
  const panelHalf = size * 0.3
  const rimBand = Math.max(size * 0.012, 0.75)

  // Sigil ratios copied from the app icon so the two marks are the same mark.
  // The seed only moves each ring's gap and rotation, which is what tells one
  // profile from another.
  const rings: Ring[] = [0.191, 0.121].map((f, i) => ({
    r: size * f,
    gapAngle: 2 * Math.PI * (0.16 + ((sd >> (i * 3)) % 9) / 44),
    rotRad: (((sd * (i + 2) * 37) % 360) * Math.PI) / 180,
    op: 1,
  }))
  const halfStroke = Math.max(size * 0.0195, 0.6)
  const dotR = Math.max(size * 0.035, 1.0)
  const twoPi = 2 * Math.PI

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Premultiplied, so the rounded corners blend correctly against the
      // transparent surround.
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

          if (insideSquircle(x, y, c, c, half)) {
            const t = Math.min(1, Math.max(0, (x + y) / (2 * size)))
            const face = faceAt(t)
            cr = face.r
            cg = face.g
            cb = face.b
            ca = 1

            if (detailed && !insideSquircle(x, y, c, c, half - rimBand)) {
              // Top-lit only: full strength at the top, gone by the bottom.
              const a = RIM_ALPHA * Math.max(0, 1 - y / size)
              cr = 255 * a + cr * (1 - a)
              cg = 255 * a + cg * (1 - a)
              cb = 255 * a + cb * (1 - a)
            }

            if (detailed && insideSquircle(x, y, c, c, panelHalf)) {
              cr = PANEL.r * PANEL_ALPHA + cr * (1 - PANEL_ALPHA)
              cg = PANEL.g * PANEL_ALPHA + cg * (1 - PANEL_ALPHA)
              cb = PANEL.b * PANEL_ALPHA + cb * (1 - PANEL_ALPHA)
            }

            const dx = x - c
            const dy = y - c
            const dist = Math.sqrt(dx * dx + dy * dy)
            let theta = Math.atan2(dy, dx)
            if (theta < 0) theta += twoPi
            const mark = mix(MARK_A, MARK_B, t)
            for (let i = 0; i < rings.length; i++) {
              const rg = rings[i]
              if (Math.abs(dist - rg.r) <= halfStroke) {
                let rel = (theta - rg.rotRad) % twoPi
                if (rel < 0) rel += twoPi
                // One dash spanning (2pi - gapAngle); the gap sits at the end.
                if (rel <= twoPi - rg.gapAngle) {
                  cr = mark.r
                  cg = mark.g
                  cb = mark.b
                }
              }
            }

            if (dist <= dotR) {
              cr = mark.r
              cg = mark.g
              cb = mark.b
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

/** CRC-32 over `type + payload`, the checksum every PNG chunk ends with. */
const crc32: (data: Buffer) => number =
  typeof zlib.crc32 === 'function'
    ? (data) => zlib.crc32(data)
    : (() => {
        const table = new Uint32Array(256)
        for (let n = 0; n < 256; n++) {
          let c = n
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
          table[n] = c >>> 0
        }
        return (data: Buffer) => {
          let c = 0xffffffff
          for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8)
          return (c ^ 0xffffffff) >>> 0
        }
      })()

function pngChunk(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0)
  return Buffer.concat([head, payload, crc])
}

/** Build a single-size 8-bit RGBA PNG from the profile name. */
export function buildPng(seedName: string, size: number = PNG_SIZE): Buffer {
  const rgba = renderRGBA(size, seed(seedName))
  // One "filter type 0 (None)" byte per scanline. Predictors would compress
  // better, but this image is a few KB either way.
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const dst = y * (1 + size * 4)
    raw[dst] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, dst + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // colour type: truecolour with alpha
  ihdr.writeUInt8(0, 10) // compression: deflate
  ihdr.writeUInt8(0, 11) // filter method 0
  ihdr.writeUInt8(0, 12) // no interlacing

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Writes the icon this platform's kernel can decode; null on any failure. */
export function writeWindowIcon(
  profileDir: string,
  seedName: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    const win = platform === 'win32'
    const iconPath = path.join(profileDir, win ? 'fp-window-icon.ico' : 'fp-window-icon.png')
    fs.writeFileSync(iconPath, win ? buildIco(seedName) : buildPng(seedName))
    return iconPath
  } catch {
    return null
  }
}

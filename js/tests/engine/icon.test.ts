import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { buildIco, buildPng, writeWindowIcon } from '../../src/engine/icon'

const SIZES = [16, 24, 32, 48, 64]

function parseIco(buf: Buffer) {
  expect(buf.readUInt16LE(0)).toBe(0) // reserved
  expect(buf.readUInt16LE(2)).toBe(1) // type = icon
  const count = buf.readUInt16LE(4)
  const entries = []
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16
    entries.push({
      width: buf.readUInt8(e), // 0 == 256
      height: buf.readUInt8(e + 1),
      planes: buf.readUInt16LE(e + 4),
      bitCount: buf.readUInt16LE(e + 6),
      bytesInRes: buf.readUInt32LE(e + 8),
      offset: buf.readUInt32LE(e + 12),
    })
  }
  return { count, entries }
}

describe('window icon (.ico) generator', () => {
  it('produces a valid multi-size 32-bit ICO', () => {
    const buf = buildIco('Amazon-US-01')
    const { count, entries } = parseIco(buf)

    expect(count).toBe(SIZES.length)
    entries.forEach((en, i) => {
      const size = SIZES[i]
      expect(en.width).toBe(size)
      expect(en.height).toBe(size)
      expect(en.planes).toBe(1)
      expect(en.bitCount).toBe(32)
      // Each entry points at a real slice inside the buffer.
      expect(en.offset + en.bytesInRes).toBeLessThanOrEqual(buf.length)
      // DIB header: biWidth = size, biHeight = 2*size (color rows + AND mask).
      const dib = buf.subarray(en.offset, en.offset + en.bytesInRes)
      expect(dib.readUInt32LE(0)).toBe(40) // biSize
      expect(dib.readInt32LE(4)).toBe(size) // biWidth
      expect(dib.readInt32LE(8)).toBe(size * 2) // biHeight
      expect(dib.readUInt16LE(14)).toBe(32) // biBitCount
    })
  })

  it('is deterministic per name and varies across names', () => {
    expect(buildIco('same-profile').equals(buildIco('same-profile'))).toBe(true)
    expect(buildIco('profile-a').equals(buildIco('profile-b'))).toBe(false)
  })

  it('renders non-empty (non-transparent) pixels', () => {
    // The 32px color plane starts right after its 40-byte DIB header; some
    // pixel must be opaque (alpha > 0), otherwise we drew nothing.
    const buf = buildIco('visible-check')
    const { entries } = parseIco(buf)
    const en = entries.find((_, i) => SIZES[i] === 32)!
    const color = buf.subarray(en.offset + 40, en.offset + 40 + 32 * 32 * 4)
    let opaque = 0
    for (let p = 3; p < color.length; p += 4) if (color[p] > 0) opaque++
    expect(opaque).toBeGreaterThan(0)
  })

  it('writeWindowIcon writes fp-window-icon.ico on Windows and returns its path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'))
    const p = writeWindowIcon(dir, 'Whoer-Test', 'win32')
    expect(p).toBe(path.join(dir, 'fp-window-icon.ico'))
    const disk = fs.readFileSync(p!)
    // ICONDIR magic: reserved=0, type=1.
    expect(disk.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]))
    expect(disk.length).toBeGreaterThan(6 + SIZES.length * 16)
  })
})

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function parsePng(buf: Buffer) {
  expect(buf.subarray(0, 8)).toEqual(PNG_MAGIC)
  const chunks: { type: string; data: Buffer }[] = []
  let off = 8
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    // The CRC covers the type plus the payload; a wrong one makes decoders bail.
    expect(buf.readUInt32BE(off + 8 + len)).toBe(zlib.crc32(buf.subarray(off + 4, off + 8 + len)))
    chunks.push({ type, data })
    off += 12 + len
  }
  return chunks
}

describe('window icon (.png) generator', () => {
  it('produces a valid 8-bit RGBA PNG of the requested size', () => {
    const chunks = parsePng(buildPng('Amazon-US-01', 64))
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const ihdr = chunks[0].data
    expect(ihdr.readUInt32BE(0)).toBe(64) // width
    expect(ihdr.readUInt32BE(4)).toBe(64) // height
    expect(ihdr.readUInt8(8)).toBe(8) // bit depth
    expect(ihdr.readUInt8(9)).toBe(6) // colour type = truecolour + alpha
    expect(ihdr.readUInt8(12)).toBe(0) // not interlaced
  })

  it('inflates back to filter-0 scanlines with visible pixels', () => {
    const size = 32
    const chunks = parsePng(buildPng('visible-check', size))
    const raw = zlib.inflateSync(chunks[1].data)
    expect(raw.length).toBe(size * (1 + size * 4))
    let opaque = 0
    for (let y = 0; y < size; y++) {
      const row = y * (1 + size * 4)
      expect(raw[row]).toBe(0) // filter type "None" on every scanline
      for (let x = 0; x < size; x++) if (raw[row + 1 + x * 4 + 3] > 0) opaque++
    }
    expect(opaque).toBeGreaterThan(0)
  })

  it('is deterministic per name and varies across names', () => {
    expect(buildPng('same-profile', 32).equals(buildPng('same-profile', 32))).toBe(true)
    expect(buildPng('profile-a', 32).equals(buildPng('profile-b', 32))).toBe(false)
  })

  it('writeWindowIcon writes a .png everywhere else — the ico only decodes on Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'))
      const p = writeWindowIcon(dir, 'Whoer-Test', platform)
      expect(p).toBe(path.join(dir, 'fp-window-icon.png'))
      expect(fs.readFileSync(p!).subarray(0, 8)).toEqual(PNG_MAGIC)
    }
  })
})

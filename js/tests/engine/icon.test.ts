import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildIco, writeWindowIcon } from '../../src/engine/icon'

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

  it('writeWindowIcon writes fp-window-icon.ico and returns its path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'))
    const p = writeWindowIcon(dir, 'Whoer-Test')
    expect(p).toBe(path.join(dir, 'fp-window-icon.ico'))
    const disk = fs.readFileSync(p!)
    // ICONDIR magic: reserved=0, type=1.
    expect(disk.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]))
    expect(disk.length).toBeGreaterThan(6 + SIZES.length * 16)
  })
})

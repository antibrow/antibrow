import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractKernelZip, resolveEntryPath } from '../../src/engine/downloader'

/**
 * extractKernelZip short-circuits to `ditto` on darwin, so the JS unzip path
 * only runs when the reported platform is win32/linux. These tests exercise
 * that path, which means pinning process.platform for the duration.
 */
function withPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => Object.defineProperty(process, 'platform', original)
}

let tmp: string
let restorePlatform: (() => void) | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-zip-'))
})

afterEach(() => {
  restorePlatform?.()
  restorePlatform = undefined
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeZip(name: string, entries: Array<[string, string]>): string {
  const zip = new AdmZip()
  for (const [entryName, body] of entries) zip.addFile(entryName, Buffer.from(body))
  const zipPath = path.join(tmp, name)
  zip.writeZip(zipPath)
  return zipPath
}

/**
 * Write a zip carrying a genuinely hostile entry name.
 *
 * adm-zip normalises `../` away as it writes, so the archive has to be patched
 * afterwards: build it with a same-length placeholder, then swap the bytes in
 * place. The name is stored twice (local header + central directory) and equal
 * lengths keep every recorded offset valid.
 */
function writeZipWithRawName(
  name: string,
  placeholder: string,
  rawName: string,
  entries: Array<[string, string]>,
): string {
  if (placeholder.length !== rawName.length) {
    throw new Error(`placeholder ${placeholder} and rawName ${rawName} must be the same length`)
  }
  const zipPath = writeZip(name, entries)
  const patched = Buffer.from(
    fs.readFileSync(zipPath).toString('latin1').split(placeholder).join(rawName),
    'latin1',
  )
  fs.writeFileSync(zipPath, patched)
  return zipPath
}

describe('resolveEntryPath', () => {
  it('resolves ordinary entries under the destination', () => {
    const dest = path.join(tmp, 'kernel')
    expect(resolveEntryPath(dest, 'Chromium/chrome.exe')).toBe(
      path.join(dest, 'Chromium', 'chrome.exe'),
    )
  })

  it('rejects parent-directory traversal', () => {
    const dest = path.join(tmp, 'kernel')
    expect(() => resolveEntryPath(dest, '../../evil.txt')).toThrow(/outside the kernel directory/)
  })

  it('rejects backslash traversal, which POSIX would otherwise treat as a filename', () => {
    const dest = path.join(tmp, 'kernel')
    expect(() => resolveEntryPath(dest, '..\\..\\evil.txt')).toThrow(
      /outside the kernel directory/,
    )
  })

  it('rejects absolute entry names', () => {
    const dest = path.join(tmp, 'kernel')
    const absolute = process.platform === 'win32' ? 'C:\\Windows\\evil.txt' : '/tmp/evil.txt'
    expect(() => resolveEntryPath(dest, absolute)).toThrow(/outside the kernel directory/)
  })

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    const dest = path.join(tmp, 'kernel')
    expect(() => resolveEntryPath(dest, '../kernel-evil/x.txt')).toThrow(
      /outside the kernel directory/,
    )
  })
})

describe('extractKernelZip', () => {
  it('extracts a well-formed archive and reports progress', async () => {
    restorePlatform = withPlatform('linux')
    const zipPath = writeZip('good.zip', [
      ['Chromium/chrome', 'binary'],
      ['Chromium/locales/en-US.pak', 'pak'],
    ])
    const dest = path.join(tmp, 'kernel')
    const messages: string[] = []

    await extractKernelZip(zipPath, dest, (m) => messages.push(m))

    expect(fs.readFileSync(path.join(dest, 'Chromium', 'chrome'), 'utf8')).toBe('binary')
    expect(fs.readFileSync(path.join(dest, 'Chromium', 'locales', 'en-US.pak'), 'utf8')).toBe('pak')
    expect(messages).toContain('Extracted 2 files')
  })

  it('refuses a Zip Slip archive and writes nothing outside the destination', async () => {
    restorePlatform = withPlatform('linux')
    const zipPath = writeZipWithRawName('evil.zip', 'AA/BB/pwned.txt', '../../pwned.txt', [
      ['Chromium/chrome', 'binary'],
      ['AA/BB/pwned.txt', 'owned'],
    ])
    const dest = path.join(tmp, 'nested', 'kernel')

    // Two layers reject this: yauzl validates entry names itself ("invalid
    // relative path") and resolveEntryPath re-checks the resolved path. Either
    // message is a pass; what matters is that nothing lands outside dest.
    await expect(extractKernelZip(zipPath, dest, () => {})).rejects.toThrow(
      /outside the kernel directory|invalid relative path/,
    )
    expect(fs.existsSync(path.join(tmp, 'pwned.txt'))).toBe(false)
  })

  it('refuses backslash traversal, which a POSIX host would treat as a filename', async () => {
    restorePlatform = withPlatform('linux')
    const zipPath = writeZipWithRawName('evil-bs.zip', 'AA/BB/pwned.txt', '..\\..\\pwned.txt', [
      ['AA/BB/pwned.txt', 'owned'],
    ])
    const dest = path.join(tmp, 'nested', 'kernel')

    // Two layers reject this: yauzl validates entry names itself ("invalid
    // relative path") and resolveEntryPath re-checks the resolved path. Either
    // message is a pass; what matters is that nothing lands outside dest.
    await expect(extractKernelZip(zipPath, dest, () => {})).rejects.toThrow(
      /outside the kernel directory|invalid relative path/,
    )
    expect(fs.existsSync(path.join(tmp, 'pwned.txt'))).toBe(false)
  })
})

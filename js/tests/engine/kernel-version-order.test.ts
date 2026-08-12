import { describe, it, expect } from 'vitest'
import {
  allKernelVersions,
  registerKernelVersions,
  kernelVersionAtLeast,
  fetchRemoteKernelVersions,
} from '../../src/engine/downloader'

const asset = { downloadUrl: 'https://x/k.zip', exeRelPath: 'chrome.exe' }

// Majors of unequal digit count are the only inputs that separate numeric from
// string ordering, and they are exactly what a Chrome major rollover produces.
// Sorted as text the newest kernel stops being newest.
describe('catalogue ordering is numeric', () => {
  it('puts 100 ahead of 10 and 9', () => {
    registerKernelVersions([
      { version: '9', label: 'Chrome 9', platforms: { win32: { ...asset } } },
      { version: '100', label: 'Chrome 100', platforms: { win32: { ...asset } } },
      { version: '10', label: 'Chrome 10', platforms: { win32: { ...asset } } },
    ])
    expect(allKernelVersions().map((kv) => kv.version)).toEqual(['150', '100', '10', '9'])
  })

  it('kernelVersionAtLeast compares numbers, not text', () => {
    expect(kernelVersionAtLeast('100', '99')).toBe(true)
    expect(kernelVersionAtLeast('99', '100')).toBe(false)
  })
})

// Upstream republishing a major means two full versions of one major arrive on
// the same platform. The parser keeps the first asset it sees per platform, so
// the row order decides which build every client downloads for that major.
describe('same-major collapse takes the newest build', () => {
  const MANIFEST = JSON.stringify({
    versions: [
      { version: '150.0.0.9', platform: 'win64', download_url: 'old.zip', build: '2026-07-01 10:00' },
      { version: '150.0.0.10', platform: 'win64', download_url: 'new.zip', build: '2026-08-01 10:00' },
    ],
  })

  it('picks the newer build even though it sorts lower as text', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response(MANIFEST, { status: 200 })) as typeof fetch
    try {
      const versions = await fetchRemoteKernelVersions('https://example.test/fp-browser-versions.json')
      expect(versions.map((kv) => kv.version)).toEqual(['150'])
      expect(versions[0].platforms.win32?.downloadUrl).toBe('https://example.test/new.zip')
      expect(versions[0].platforms.win32?.build).toBe('2026-08-01 10:00')
    } finally {
      globalThis.fetch = orig
    }
  })
})

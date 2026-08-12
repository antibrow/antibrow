import { describe, it, expect } from 'vitest'
import {
  normalizeKernelVersion,
  KERNEL_VERSIONS,
  ANDROID_MIN_KERNEL_VERSION,
  APP_LOCALE_MIN_KERNEL_VERSION,
  findKernelVersion,
  findKernelVersionStrict,
  kernelDir,
  kernelVersionAtLeast,
  fetchRemoteKernelVersions,
  registerKernelVersions,
  allKernelVersions,
} from '../../src/engine/downloader'

describe('normalizeKernelVersion', () => {
  it('keeps only the Chrome major', () => {
    expect(normalizeKernelVersion('150.0.0.0')).toBe('150')
    expect(normalizeKernelVersion('151.0.0.0')).toBe('151')
    expect(normalizeKernelVersion('150')).toBe('150')
  })

  it('leaves shapes it does not understand alone', () => {
    expect(normalizeKernelVersion(undefined)).toBe('')
    expect(normalizeKernelVersion('')).toBe('')
    expect(normalizeKernelVersion('nightly')).toBe('nightly')
  })
})

describe('baseline', () => {
  it('is identified by the major alone', () => {
    expect(KERNEL_VERSIONS.map((kv) => kv.version)).toEqual(['150'])
    expect(KERNEL_VERSIONS[0].label).toBe('Chrome 150')
    expect(ANDROID_MIN_KERNEL_VERSION).toBe('151')
    expect(APP_LOCALE_MIN_KERNEL_VERSION).toBe('151')
  })
})

describe('lookups accept legacy full version strings', () => {
  it('findKernelVersion resolves an old persona pin', () => {
    expect(findKernelVersion('150.0.0.0').version).toBe('150')
  })

  it('findKernelVersionStrict does not throw on an old pin', () => {
    expect(findKernelVersionStrict('150.0.0.0').version).toBe('150')
  })

  it('kernelDir never contains a full version string', () => {
    expect(kernelDir('/cache', '150.0.0.0')).toBe(kernelDir('/cache', '150'))
    expect(kernelDir('/cache', '150.0.0.0')).toMatch(/kernels[\\/]150$/)
  })

  it('kernelVersionAtLeast compares majors across mixed shapes', () => {
    expect(kernelVersionAtLeast('151.0.0.0', '151')).toBe(true)
    expect(kernelVersionAtLeast('150.0.0.0', '151')).toBe(false)
    expect(kernelVersionAtLeast('152', '151.0.0.0')).toBe(true)
    expect(kernelVersionAtLeast(undefined, '151')).toBe(false)
  })

  it('findKernelVersionStrict resolves a legacy pin that only exists in the manifest', () => {
    registerKernelVersions([
      { version: '151.0.0.0', label: 'Chrome 151', platforms: { win32: { downloadUrl: 'https://x/151.zip', exeRelPath: 'chrome.exe' } } },
    ])
    expect(() => findKernelVersionStrict('151.0.0.0')).not.toThrow()
    expect(findKernelVersionStrict('151.0.0.0').version).toBe('151')
  })
})

describe('manifest ingest', () => {
  const MANIFEST = JSON.stringify({
    versions: [
      { version: '151.0.0.0', label: 'Chrome 151', platform: 'win64', download_url: 'fp-chromium-151-win64.zip', build: '2026-08-07 05:17' },
      { version: '151.0.0.0', label: 'Chrome 151', platform: 'mac-universal', download_url: 'fp-chromium-151-mac-universal.zip', build: '2026-08-07 14:59' },
      { version: '149.0.0.0', platform: 'win64', download_url: 'fp-chromium-149-win64.zip', build: '2026-07-28' },
    ],
  })

  it('normalizes versions on the way in and labels the unlabelled', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response(MANIFEST, { status: 200 })) as typeof fetch
    try {
      const versions = await fetchRemoteKernelVersions('https://example.test/fp-browser-versions.json')
      const v151 = versions.find((kv) => kv.version === '151')
      expect(v151).toBeDefined()
      expect(Object.keys(v151!.platforms).sort()).toEqual(['darwin', 'win32'])
      expect(v151!.platforms.win32?.downloadUrl).toBe('https://example.test/fp-chromium-151-win64.zip')
      const v149 = versions.find((kv) => kv.version === '149')
      expect(v149?.label).toBe('Chrome 149')
      expect(versions.some((kv) => kv.version.includes('.'))).toBe(false)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('registerKernelVersions normalizes a stale cache entry', () => {
    registerKernelVersions([
      { version: '152.0.0.0', label: 'Chrome 152', platforms: { win32: { downloadUrl: 'https://x/152.zip', exeRelPath: 'chrome.exe' } } },
    ])
    expect(allKernelVersions().some((kv) => kv.version === '152')).toBe(true)
    expect(allKernelVersions().some((kv) => kv.version === '152.0.0.0')).toBe(false)
  })
})

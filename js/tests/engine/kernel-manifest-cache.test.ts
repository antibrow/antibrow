import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  refreshKernelVersions,
  loadCachedKernelVersions,
  kernelsForPlatform,
  kernelAsset,
  KERNEL_VERSION_CACHE_FILE,
} from '../../src/engine/downloader'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kmc-'))
}

function manifest(version: string, build: string): string {
  return JSON.stringify({
    versions: [
      { version, label: `Chrome ${version.split('.')[0]}`, platform: 'win64', download_url: `fp-chromium-${version}-win64.zip`, exe_rel_path: 'chrome.exe', build },
      { version, label: `Chrome ${version.split('.')[0]}`, platform: 'linuxarm64', download_url: `fp-chromium-${version}-linuxarm64.zip`, exe_rel_path: 'chrome', build },
    ],
  })
}

const MANIFEST_URL = 'https://download.antibrow.com/fp-browser-versions.json'
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(manifest('900.0.0.1', 'b1'), { status: 200 }))
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('refreshKernelVersions', () => {
  it('registers manifest versions and caches them as a bare array', async () => {
    const dir = tmp()
    await refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const discovered = kernelsForPlatform('win32').find((kv) => kv.version === '900.0.0.1')
    expect(discovered).toBeDefined()
    expect(kernelAsset(discovered!, 'win32').build).toBe('b1')

    const raw = JSON.parse(fs.readFileSync(path.join(dir, KERNEL_VERSION_CACHE_FILE), 'utf8'))
    expect(Array.isArray(raw)).toBe(true) // desktop's loadCache() requires an array
    expect(loadCachedKernelVersions(dir).map((kv) => kv.version)).toContain('900.0.0.1')
  })

  it('resolves relative download_url against the manifest origin', async () => {
    const dir = tmp()
    await refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL })
    const kv = kernelsForPlatform('win32').find((v) => v.version === '900.0.0.1')!
    expect(kernelAsset(kv, 'win32').downloadUrl).toBe(
      'https://download.antibrow.com/fp-chromium-900.0.0.1-win64.zip',
    )
  })

  it('serves a fresh cache without hitting the network, and re-fetches when forced', async () => {
    const dir = tmp()
    await refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL })
    expect(fetchSpy).toHaveBeenCalledTimes(1) // within TTL: no second request

    await refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL, force: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('re-fetches once the cached manifest is older than the ttl', async () => {
    const dir = tmp()
    await refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL })
    // Freshness is the file mtime (the cache stays a bare array for the desktop app).
    const stale = new Date(Date.now() - 10 * 60 * 1000)
    fs.utimesSync(path.join(dir, KERNEL_VERSION_CACHE_FILE), stale, stale)

    await refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL, ttlMs: 60_000 })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('falls back to the cache when the fetch fails, and never throws', async () => {
    const dir = tmp()
    await refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL })
    fetchSpy.mockRejectedValue(new Error('offline'))

    await expect(refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL, force: true })).resolves.toBeUndefined()
    // The cache survived the failed refresh rather than being cleared.
    expect(loadCachedKernelVersions(dir).map((kv) => kv.version)).toContain('900.0.0.1')
  })

  it('tolerates an unreadable cache and a non-200 manifest', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, KERNEL_VERSION_CACHE_FILE), 'not json', 'utf8')
    expect(loadCachedKernelVersions(dir)).toEqual([])

    fetchSpy.mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(refreshKernelVersions(dir, { manifestUrl: MANIFEST_URL })).resolves.toBeUndefined()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Where the proxy URL comes from, and WHEN. A managed credential is
// single-session, and a first launch on a new machine spends many minutes
// downloading a kernel before a browser exists - one taken before that download
// can be revoked or stale by the time the kernel reads it.

const order: string[] = []

vi.mock('../../src/engine/geoip', () => ({
  lookupProxyGeo: async () => null,
  lookupDirectGeo: async () => null,
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))

vi.mock('../../src/engine/downloader', () => ({
  defaultKernelVersion: () => ({ version: '150.0.0.0', label: 'Chrome 150', platforms: {} }),
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: async () => { order.push('kernel'); return 'C:/kernels/chrome.exe' },
  refreshKernelVersions: async () => undefined,
  kernelUpdateStatus: () => null,
  installedKernelBuild: () => undefined,
  kernelReadsAppLocaleFromConfig: () => false,
}))

vi.mock('../../src/engine/persona', () => ({
  readPersona: () => undefined,
  loadOrGeneratePersona: () => ({ kernelVersion: '150.0.0.0', chromeMajor: 150, timezone: 'UTC', languages: ['en-US'] }),
}))

const launchSpy = vi.fn()
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: async (opts: { proxyUrl?: string }) => {
    order.push('launch')
    launchSpy(opts)
    return {
      context: { pages: () => [], newPage: vi.fn() },
      profileDir: '',
      onExit: () => {},
      close: vi.fn(async () => undefined),
    }
  },
}))

import { openProfile } from '../../src/engine/index'

const base = () => ({
  cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'opp-')),
  profileName: 'p',
  licenseToken: 'tok',
})

beforeEach(() => {
  order.length = 0
  launchSpy.mockClear()
})

describe('openProfile proxy resolution', () => {
  it('hands the kernel a plain proxyUrl unchanged', async () => {
    await openProfile({ ...base(), proxyUrl: 'http://u:p@host:8080' })
    expect(launchSpy.mock.calls[0][0].proxyUrl).toBe('http://u:p@host:8080')
  })

  it('mints from getProxyUrl only after the kernel is in place', async () => {
    const getProxyUrl = vi.fn(async () => {
      order.push('issue')
      return 'relay://px1:tkt@proxy.antibrow.com'
    })

    await openProfile({ ...base(), proxyUrl: 'relay://px1:stale@proxy.antibrow.com', getProxyUrl })

    expect(getProxyUrl).toHaveBeenCalledTimes(1)
    // The whole point: nothing is issued while the kernel downloads.
    expect(order).toEqual(['kernel', 'issue', 'launch'])
    expect(launchSpy.mock.calls[0][0].proxyUrl).toBe('relay://px1:tkt@proxy.antibrow.com')
  })

  it('launches direct when the mint declines to produce a URL', async () => {
    await openProfile({ ...base(), getProxyUrl: async () => undefined })
    expect(launchSpy.mock.calls[0][0].proxyUrl).toBeUndefined()
  })
})

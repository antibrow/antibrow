import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../src/engine/downloader', () => ({
  defaultKernelVersion: () => ({ version: '152', label: 'Chrome 152', platforms: {} }),
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: async () => 'C:/kernels/chrome.exe',
  refreshKernelVersions: async () => undefined,
  kernelUpdateStatus: () => null,
  installedKernelBuild: () => undefined,
  kernelReadsAppLocaleFromConfig: () => false,
  normalizeKernelVersion: (v?: string) => v ?? '',
}))

vi.mock('../../src/engine/persona', () => ({
  readPersona: () => undefined,
  loadOrGeneratePersona: () => ({ kernelVersion: '152', chromeMajor: 152, timezone: 'America/Los_Angeles', languages: ['en-US'] }),
}))

const direct = { ip: '203.0.113.7', country: 'Germany', countryCode: 'DE', city: 'Berlin', timezone: 'Europe/Berlin', rttMs: 42 }
const lookups: string[] = []
vi.mock('../../src/engine/geoip', () => ({
  lookupProxyGeo: async (url: string) => { lookups.push(`proxy:${url}`); return { ...direct, ip: '198.51.100.9', timezone: 'America/Chicago' } },
  lookupDirectGeo: async () => { lookups.push('direct'); return direct },
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))

const launches: Array<{ timezone: string; publicIp?: string; rttMs?: number }> = []
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: async (opts: { timezone: string; publicIp?: string; rttMs?: number; profileDir: string }) => {
    launches.push({ timezone: opts.timezone, publicIp: opts.publicIp, rttMs: opts.rttMs })
    return { context: { pages: () => [], newPage: vi.fn() }, profileDir: opts.profileDir, onExit: () => undefined, close: vi.fn(async () => undefined) }
  },
}))

import { openProfile } from '../../src/engine/index'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dgeo-'))

beforeEach(() => { launches.length = 0; lookups.length = 0 })

describe('a launch with no proxy still agrees with its own exit', () => {
  it('takes the timezone and the WebRTC public IP from a direct lookup', async () => {
    // Without the IP the kernel is told to switch WebRTC off, which no real
    // browser is, and the timezone stays on the persona's default while the
    // address says somewhere else.
    const session = await openProfile({ cacheDir: tmp(), profileName: 'p', licenseToken: 'tok' })
    expect(lookups).toEqual(['direct'])
    expect(launches[0]).toEqual({ timezone: 'Europe/Berlin', publicIp: '203.0.113.7', rttMs: 42 })
    // `geo` on the session means the proxy's exit; a direct answer is not one.
    expect(session.geo).toBeUndefined()
  })

  it('leaves the proxy path alone', async () => {
    await openProfile({ cacheDir: tmp(), profileName: 'p', licenseToken: 'tok', proxyUrl: 'http://u:p@h.io:8080' })
    expect(lookups).toEqual(['proxy:http://u:p@h.io:8080'])
    expect(launches[0].timezone).toBe('America/Chicago')
    expect(launches[0].publicIp).toBe('198.51.100.9')
  })
})

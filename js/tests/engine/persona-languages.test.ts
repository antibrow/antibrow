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
  normalizeKernelVersion: (v?: string) => (v ?? '').split('.')[0],
}))

let exit: { countryCode: string; timezone: string } | null = null
vi.mock('../../src/engine/geoip', () => ({
  lookupProxyGeo: async () => (exit ? { ip: '198.51.100.9', country: '', city: '', ...exit } : null),
  lookupDirectGeo: async () => (exit ? { ip: '203.0.113.7', country: '', city: '', ...exit } : null),
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))

const launched: string[][] = []
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: async (opts: { persona: { languages: string[] }; profileDir: string }) => {
    launched.push(opts.persona.languages)
    return { context: { pages: () => [], newPage: vi.fn() }, profileDir: opts.profileDir, onExit: () => undefined, close: vi.fn(async () => undefined) }
  },
}))

import { openProfile } from '../../src/engine/index'
import { generatePersona, settlePersonaLanguages } from '../../src/engine/persona'
import { chromeLocale, languagesForCountry } from '../../src/geo'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plang-'))
const onDisk = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8'))

beforeEach(() => { launched.length = 0; exit = null })

describe('languagesForCountry', () => {
  it('follows the Accept-Language order without q-values', () => {
    expect(languagesForCountry('CN')).toEqual(['zh-CN', 'zh', 'en'])
    expect(languagesForCountry('us')).toEqual(['en-US', 'en'])
    expect(languagesForCountry('ZZ')).toBeUndefined()
  })

  it('leads with a locale pack the kernel ships, or macOS aborts at startup', () => {
    expect(languagesForCountry('SG')).toEqual(['en-US', 'en', 'zh'])
    expect(languagesForCountry('DE')).toEqual(['de', 'en'])
    expect(languagesForCountry('HK')).toEqual(['zh-TW', 'zh', 'en'])
    expect(languagesForCountry('MX')).toEqual(['es-419', 'es', 'en'])
    expect(languagesForCountry('IS')).toEqual(['en-US', 'is', 'en'])
    for (const cc of ['US', 'CN', 'JP', 'BR', 'CA', 'NO', 'IL', 'AU']) {
      const first = languagesForCountry(cc)![0]
      expect(chromeLocale(first)).toBe(first)
    }
  })
})

describe('settlePersonaLanguages', () => {
  it('settles a new persona once and persists it', () => {
    const dir = tmp()
    const fresh = generatePersona(152, '152')
    expect(fresh.languagesPending).toBe(true)
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ ...fresh, kernelVersion: 'as-written' }))
    const settled = settlePersonaLanguages(dir, fresh, 'CN')
    expect(settled.languages).toEqual(['zh-CN', 'zh', 'en'])
    expect(settled.languagesPending).toBeUndefined()
    const file = onDisk(dir)
    expect(file.languages).toEqual(['zh-CN', 'zh', 'en'])
    expect('languagesPending' in file).toBe(false)
    // The file keeps the version string it had.
    expect(file.kernelVersion).toBe('as-written')
  })

  it('leaves a profile from before the flag alone', () => {
    const dir = tmp()
    const { languagesPending: _, ...legacy } = generatePersona(152, '152')
    expect(settlePersonaLanguages(dir, legacy, 'CN')).toBe(legacy)
    expect(fs.existsSync(path.join(dir, 'persona.json'))).toBe(false)
  })

  it('waits when the exit country is unknown, settles on the default for an unlisted one', () => {
    const dir = tmp()
    const fresh = generatePersona(152, '152')
    expect(settlePersonaLanguages(dir, fresh, undefined)).toBe(fresh)
    const settled = settlePersonaLanguages(dir, fresh, 'ZZ')
    expect(settled.languages).toEqual(['en-US', 'en'])
    expect(settled.languagesPending).toBeUndefined()
  })
})

describe('openProfile', () => {
  it('takes the first exit country and keeps it when the proxy changes', async () => {
    const cacheDir = tmp()
    exit = { countryCode: 'CN', timezone: 'Asia/Shanghai' }
    await openProfile({ cacheDir, profileName: 'p', licenseToken: 'tok', proxyUrl: 'http://h.io:8080' })
    exit = { countryCode: 'US', timezone: 'America/Chicago' }
    await openProfile({ cacheDir, profileName: 'p', licenseToken: 'tok', proxyUrl: 'http://h.io:8080' })
    expect(launched).toEqual([['zh-CN', 'zh', 'en'], ['zh-CN', 'zh', 'en']])
  })

  it('settles from a direct exit too, and retries after a failed lookup', async () => {
    const cacheDir = tmp()
    await openProfile({ cacheDir, profileName: 'p', licenseToken: 'tok' })
    exit = { countryCode: 'DE', timezone: 'Europe/Berlin' }
    await openProfile({ cacheDir, profileName: 'p', licenseToken: 'tok' })
    expect(launched).toEqual([['en-US', 'en'], ['de', 'en']])
  })
})

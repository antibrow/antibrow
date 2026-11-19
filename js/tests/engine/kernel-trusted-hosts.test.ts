import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Kernel downloads never reach the network here: every GET fails, or redirects when a test says so.
type Get = (url: string, opts: unknown, cb: (res: unknown) => void) => EventEmitter
const httpsGet = vi.fn<Get>()
const fakeReq = () => Object.assign(new EventEmitter(), { setTimeout() { return this }, destroy() {} })
const offline: Get = () => {
  const req = fakeReq()
  setImmediate(() => req.emit('error', new Error('offline')))
  return req
}
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>()
  return { ...actual, default: { ...actual, get: (...a: Parameters<Get>) => httpsGet(...a) } }
})

vi.mock('../../src/engine/geoip', () => ({
  lookupProxyGeo: async () => null,
  lookupDirectGeo: async () => null,
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))

let personaKernel = '150'
vi.mock('../../src/engine/persona', () => ({
  settlePersonaLanguages: (_dir: string, p: unknown) => p,
  personaHostWarnings: () => [],
  assertPersonaOs: () => {},
  readPersona: () => undefined,
  loadOrGeneratePersona: () => ({ kernelVersion: personaKernel, chromeMajor: Number(personaKernel), timezone: 'UTC', languages: ['en-US'] }),
}))

const launchKernelSpy = vi.fn(async () => ({
  context: { pages: () => [], newPage: vi.fn() },
  profileDir: '',
  onExit: vi.fn(),
  close: vi.fn(async () => undefined),
}))
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: (...a: unknown[]) => launchKernelSpy(...(a as [])),
}))

import {
  assertTrustedKernelUrl,
  UntrustedKernelSourceError,
  ensureKernel,
  refreshKernelVersions,
  findKernelVersion,
  currentPlatform,
  KERNEL_VERSION_CACHE_FILE,
} from '../../src/engine/downloader'
import { openProfile } from '../../src/engine/index'

const TRUSTED = ['download.antibrow.com']
const PLAT = currentPlatform()
const MANIFEST_PLATFORM: Record<string, string> = { win32: 'win64', darwin: 'mac-universal', linux: 'linux64', 'linux-arm64': 'linuxarm64' }

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ktrust-'))
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('nope', { status: 404 }))
  vi.stubGlobal('fetch', fetchSpy)
  launchKernelSpy.mockClear()
  httpsGet.mockReset()
  httpsGet.mockImplementation(offline)
})
afterEach(() => { vi.unstubAllGlobals() })

const manifest = (version: string, downloadUrl: string) => JSON.stringify({
  versions: [{ version, label: `Chrome ${version}`, platform: MANIFEST_PLATFORM[PLAT], download_url: downloadUrl, exe_rel_path: 'chrome', build: 'b1' }],
})

describe('assertTrustedKernelUrl', () => {
  it('allows only https on an exact host', () => {
    expect(() => assertTrustedKernelUrl('https://download.antibrow.com/k.zip', TRUSTED)).not.toThrow()
    for (const bad of [
      'https://evil.example/k.zip',
      'http://download.antibrow.com/k.zip',
      'https://download.antibrow.com.evil.example/k.zip',
      'https://user:pw@download.antibrow.com/k.zip',
      'https://download.antibrow.com:8443/k.zip',
      'file:///tmp/k.zip',
      'not a url',
    ]) expect(() => assertTrustedKernelUrl(bad, TRUSTED), bad).toThrow(UntrustedKernelSourceError)
  })
  it('is a no-op without a host list', () => {
    expect(() => assertTrustedKernelUrl('https://evil.example/k.zip')).not.toThrow()
  })
})

describe('ensureKernel with trustedKernelHosts', () => {
  it('refuses an absolute download_url on another host from the manifest, before touching the install', async () => {
    const dir = tmp()
    fetchSpy.mockImplementationOnce(async () => new Response(manifest('971', 'https://evil.example/k.zip'), { status: 200 }))
    await refreshKernelVersions(dir, { manifestUrl: 'https://download.antibrow.com/fp-browser-versions.json', force: true })
    const kv = findKernelVersion('971')
    expect(kv.version).toBe('971')
    const kDir = path.join(dir, 'kernels', '971')
    fs.mkdirSync(kDir, { recursive: true })
    fs.writeFileSync(path.join(kDir, 'marker'), 'old install')
    await expect(ensureKernel(dir, kv, undefined, { force: true, trustedKernelHosts: TRUSTED })).rejects.toThrow(UntrustedKernelSourceError)
    expect(httpsGet).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(kDir, 'marker'), 'utf8')).toBe('old install')
  })

  it('still downloads a relative download_url resolved on download.antibrow.com', async () => {
    const dir = tmp()
    fetchSpy.mockImplementationOnce(async () => new Response(manifest('972', 'fp-chromium-972.zip'), { status: 200 }))
    await refreshKernelVersions(dir, { manifestUrl: 'https://download.antibrow.com/fp-browser-versions.json', force: true })
    const err = await ensureKernel(dir, findKernelVersion('972'), undefined, { trustedKernelHosts: TRUSTED }).catch((e) => e)
    expect(err).not.toBeInstanceOf(UntrustedKernelSourceError)
    expect(String(httpsGet.mock.calls[0]?.[0])).toMatch(/^https:\/\/download\.antibrow\.com\/fp-chromium-972\.zip/)
  })

  it('refuses a redirect from the trusted host to another one', async () => {
    const dir = tmp()
    fetchSpy.mockImplementationOnce(async () => new Response(manifest('973', 'fp-chromium-973.zip'), { status: 200 }))
    await refreshKernelVersions(dir, { manifestUrl: 'https://download.antibrow.com/fp-browser-versions.json', force: true })
    httpsGet.mockImplementationOnce((_u, _o, cb) => {
      setImmediate(() => cb({ statusCode: 302, headers: { location: 'https://evil.example/k.zip' }, resume() {} }))
      return fakeReq()
    })
    await expect(ensureKernel(dir, findKernelVersion('973'), undefined, { trustedKernelHosts: TRUSTED })).rejects.toThrow(UntrustedKernelSourceError)
    expect(httpsGet.mock.calls.map((c) => String(c[0])).some((u) => u.includes('evil.example'))).toBe(false)
  })
})

describe('openProfile with a poisoned kernel catalogue cache', () => {
  function poison(dir: string, version: string) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, KERNEL_VERSION_CACHE_FILE), JSON.stringify([
      { version, label: `Chrome ${version}`, platforms: { [PLAT]: { downloadUrl: 'https://evil.example/k.zip', exeRelPath: 'chrome', build: 'evil' } } },
    ]))
  }

  it('refuses to download from the cached evil URL and never launches', async () => {
    const dir = tmp()
    poison(dir, '981')
    personaKernel = '981'
    await expect(openProfile({
      cacheDir: dir, profileName: 'p', licenseToken: 'tok', focusWindow: false,
      kernelManifestUrl: 'https://download.antibrow.com/fp-browser-versions.json', trustedKernelHosts: TRUSTED,
    })).rejects.toThrow(UntrustedKernelSourceError)
    expect(httpsGet).not.toHaveBeenCalled()
    expect(launchKernelSpy).not.toHaveBeenCalled()
  })
})

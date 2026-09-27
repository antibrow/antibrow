import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const openProfileSpy = vi.hoisted(() => vi.fn())

vi.mock('../src/engine/geoip', () => ({
  lookupProxyGeo: async () => null,
  lookupDirectGeo: async () => null,
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))
vi.mock('../src/engine', () => ({
  openProfile: openProfileSpy,
  getLicenseToken: async () => ({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 1, sync: false }),
  installedKernelUpdates: () => [],
  refreshKernelVersions: async () => undefined,
  readProfileMeta: () => undefined,
  normalizeKernelVersion: (v: string) => v,
}))
vi.mock('../src/version', () => ({
  SDK_VERSION: '9.9.9',
  checkClientVersion: async () => ({ status: 'ok', current: '9.9.9' }),
}))

import { AntiDetectBrowser } from '../src/browser'
import { classifyDownloadError, classifyLaunchError } from '../src/telemetry'

const fakeSession = {
  context: { pages: () => [{}], newPage: vi.fn(), on: vi.fn() },
  profileDir: '/tmp/p',
  kernelVersion: '152',
  close: vi.fn(async () => undefined),
}

let posted: Array<Record<string, unknown>>
const fetchSpy = vi.fn(async (url: string, init: { body: string }) => {
  if (url.endsWith('/api/v1/telemetry')) posted.push(...JSON.parse(init.body).events)
  return new Response('{}', { status: 200 })
})

beforeEach(() => {
  posted = []
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubEnv('ANTIBROW_TELEMETRY', '')
  openProfileSpy.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const ab = () => new AntiDetectBrowser({ key: 'k', server: 'https://api.test', notify: () => {} })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('launch telemetry', () => {
  it('reports a successful launch with the download that preceded it', async () => {
    openProfileSpy.mockImplementation(async (opts: { onKernelDownload?: (e: unknown) => void }) => {
      opts.onKernelDownload?.({ ok: true, version: '152' })
      return fakeSession
    })
    await ab().launch({ profile: 'p' })
    await flush()
    expect(posted).toEqual([
      expect.objectContaining({ type: 'kernel.download', ok: true, kernelVersion: '152', client: 'sdk-js', clientVersion: '9.9.9' }),
      expect.objectContaining({ type: 'kernel.launch', ok: true, kernelVersion: '152' }),
    ])
  })

  // The report has to leave before the rethrow: a script that does not catch
  // the error exits on the unhandled rejection and a detached request dies with it.
  it('reports the failure category before rethrowing', async () => {
    openProfileSpy.mockImplementation(async (opts: { onKernelDownload?: (e: unknown) => void }) => {
      const error = new Error('getaddrinfo ENOTFOUND download fetch failed')
      opts.onKernelDownload?.({ ok: false, version: '152', error })
      throw error
    })
    await expect(ab().launch({ profile: 'p' })).rejects.toThrow('ENOTFOUND')
    expect(posted.map((e) => [e.type, e.ok, e.code])).toEqual([
      ['kernel.download', false, 'network'],
      ['kernel.launch', false, 'unknown'],
    ])
  })

  it('never sends error text, only the error class for unknown failures', async () => {
    class OddError extends Error { name = 'OddError' }
    openProfileSpy.mockRejectedValue(new OddError('/Users/me/secret-profile exploded'))
    await expect(ab().launch({ profile: 'p' })).rejects.toThrow()
    expect(JSON.stringify(posted)).not.toContain('secret-profile')
    expect(posted[0]).toMatchObject({ type: 'kernel.launch', ok: false, code: 'unknown', meta: { error: 'OddError' } })
  })

  it('sends nothing when turned off in the constructor or the environment', async () => {
    openProfileSpy.mockResolvedValue(fakeSession)
    await new AntiDetectBrowser({ key: 'k', server: 'https://api.test', notify: () => {}, telemetry: false }).launch({ profile: 'a' })
    vi.stubEnv('ANTIBROW_TELEMETRY', '0')
    await ab().launch({ profile: 'b' })
    await flush()
    expect(posted).toEqual([])
  })

  it('does not turn a telemetry outage into a launch failure', async () => {
    fetchSpy.mockRejectedValue(new Error('offline'))
    openProfileSpy.mockResolvedValue(fakeSession)
    await expect(ab().launch({ profile: 'p' })).resolves.toMatchObject({ profileDir: '/tmp/p' })
  })
})

describe('error classification', () => {
  it('maps launch errors onto the server vocabulary', () => {
    expect(classifyLaunchError(new Error('Kernel refused to start: max instances reached'))).toBe('concurrency')
    expect(classifyLaunchError(new Error('Timed out waiting for CDP'))).toBe('timeout')
    expect(classifyLaunchError(new Error('Failed to obtain license token: 401'))).toBe('license')
    expect(classifyLaunchError(new Error('spawn chrome ENOENT'))).toBe('missing_binary')
  })

  it('maps download errors onto the server vocabulary', () => {
    expect(classifyDownloadError(new Error('ENOSPC: no space left on device'))).toBe('disk')
    expect(classifyDownloadError(new Error('Kernel size mismatch'))).toBe('checksum')
    expect(classifyDownloadError(new Error('codesign --verify failed'))).toBe('signature')
  })
})

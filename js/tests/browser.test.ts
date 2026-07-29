import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakePage = { url: () => 'about:blank', goto: vi.fn(async () => undefined), evaluate: vi.fn(async () => undefined) }
const fakeSession = {
  context: {
    pages: () => [fakePage],
    newPage: vi.fn(),
    addCookies: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    close: vi.fn(async () => undefined),
    on: vi.fn(),
  },
  wsEndpoint: 'ws://127.0.0.1/devtools/browser/abc',
  profileDir: 'D:/profiles/amazon-us',
  onExit: vi.fn(),
  close: vi.fn(async () => undefined),
}
const openProfileSpy = vi.fn(async () => fakeSession)
const licenseSpy = vi.fn(async () => ({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 10, sync: true }))
const installedKernelUpdatesSpy = vi.fn((): Array<Record<string, unknown>> => [])
const ensureKernelSpy = vi.fn(async () => 'C:/kernels/chrome.exe')

vi.mock('../src/engine', () => ({
  openProfile: (...args: unknown[]) => openProfileSpy(...args),
  getLicenseToken: (...args: unknown[]) => licenseSpy(...(args as [])),
  ensureKernel: (...args: unknown[]) => ensureKernelSpy(...(args as [])),
  findKernelVersion: (v: string) => ({ version: v, label: v, platforms: {} }),
  fetchRemoteKernelVersions: vi.fn(async () => []),
  registerKernelVersions: vi.fn(),
  installedKernelUpdates: (...args: unknown[]) => installedKernelUpdatesSpy(...(args as [])),
}))

vi.mock('../src/api', () => ({
  getOrCreateProfile: vi.fn(async () => ({ id: 'profile-1', name: 'amazon-us', config: null })),
  activateProxy: vi.fn(async () => ({ proxy: { id: 'px1', protocol: 'http', host: 'proxy.local', port: 8080, username: 'u', password: 'p' } })),
  managedProxyToRelayUrl: vi.fn(() => 'relay://k:px1@proxy.antibrow.com'),
  DEFAULT_RELAY_HOST: 'proxy.antibrow.com',
  getProfileArchiveUrls: vi.fn(async () => ({ downloadUrl: 'https://r2/get', uploadUrl: 'https://r2/put' })),
}))

const versionCheckSpy = vi.fn(async () => ({ status: 'ok', current: '1.0.0' }))
vi.mock('../src/version', () => ({
  SDK_VERSION: '1.0.0',
  checkClientVersion: (...args: unknown[]) => versionCheckSpy(...(args as [])),
}))

import { AntiDetectBrowser } from '../src/browser'

beforeEach(() => {
  openProfileSpy.mockClear()
  licenseSpy.mockReset()
  licenseSpy.mockResolvedValue({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 10, sync: true })
  versionCheckSpy.mockReset()
  versionCheckSpy.mockResolvedValue({ status: 'ok', current: '1.0.0' })
  installedKernelUpdatesSpy.mockReset()
  installedKernelUpdatesSpy.mockReturnValue([])
  ensureKernelSpy.mockClear()
})

/** Let the fire-and-forget kernel-update check settle. */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

describe('AntiDetectBrowser.launch (engine)', () => {
  it('requires a profile', async () => {
    const ab = new AntiDetectBrowser({ key: 'k' })
    // @ts-expect-error missing profile
    await expect(ab.launch({})).rejects.toThrow('profile')
  })

  it('launches via engine and returns context + first page', async () => {
    const ab = new AntiDetectBrowser({ key: 'k' })
    const res = await ab.launch({ profile: 'amazon-us' })
    expect(openProfileSpy).toHaveBeenCalledTimes(1)
    const params = openProfileSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params).toMatchObject({
      key: 'k',
      profileName: 'amazon-us',
      archiveGetUrl: 'https://r2/get',
      archivePutUrl: 'https://r2/put',
    })
    expect(params).not.toHaveProperty('fingerprintJson')
    expect(res.context).toBe(fakeSession.context)
    expect(res.page).toBe(fakePage)
  })

  it('rejects legacy kernel options', async () => {
    const ab = new AntiDetectBrowser({ key: 'k' })
    await expect(ab.launch({ profile: 'p', kernel: 'firefox' } as any)).rejects.toThrow(/kernel/i)
    expect(openProfileSpy).not.toHaveBeenCalled()
  })

  it('prevents duplicate sessions on the same profile', async () => {
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'dup' })
    await expect(ab.launch({ profile: 'dup' })).rejects.toThrow('already in use')
  })

  it('blocks launch when the server marks the SDK version as required-upgrade', async () => {
    versionCheckSpy.mockResolvedValue({ status: 'required', current: '1.0.0', minSupported: '2.0.0', downloadUrl: 'https://dl' })
    const ab = new AntiDetectBrowser({ key: 'k' })
    await expect(ab.launch({ profile: 'gated' })).rejects.toThrow(/no longer supported/)
    expect(openProfileSpy).not.toHaveBeenCalled()
  })

  it('applies the floating label via addInitScript when label is provided', async () => {
    fakeSession.context.addInitScript.mockClear()
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'p', label: 'acct@x.com' })
    expect(fakeSession.context.addInitScript).toHaveBeenCalled()
    const scripts = fakeSession.context.addInitScript.mock.calls.map((c) => c[0])
    expect(scripts.some((s) => typeof s === 'string' && s.includes('acct@x.com'))).toBe(true)
  })

  it('does NOT cap concurrency in the SDK — mi is enforced by the kernel', async () => {
    // mi=1, but the SDK must still let the launch proceed to the engine; the
    // kernel is the authoritative concurrency enforcer (surfaced by the launcher).
    licenseSpy.mockResolvedValue({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 1, sync: false })
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'a' })
    await ab.launch({ profile: 'b' })
    expect(openProfileSpy).toHaveBeenCalledTimes(2)
  })

  it('prints a notice (once per process) when an installed kernel has an update and the flag is off', async () => {
    installedKernelUpdatesSpy.mockReturnValue([
      { version: '150.0.7871.182', label: 'Chrome 150', installed: true, updateAvailable: true },
    ])
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'k', notify })

    await ab.launch({ profile: 'a' })
    await ab.launch({ profile: 'b' })
    await flushMicrotasks()

    expect(notify).toHaveBeenCalledTimes(1) // once per process, not per launch
    expect(notify.mock.calls[0][0]).toMatch(/kernel build is available/i)
    expect(notify.mock.calls[0][0]).toContain('Chrome 150')
    // advisory only — never updates behind the user's back
    expect(ensureKernelSpy).not.toHaveBeenCalled()
  })

  it('stays silent when no installed kernel has an update', async () => {
    installedKernelUpdatesSpy.mockReturnValue([
      { version: '150.0.7871.182', label: 'Chrome 150', installed: true, updateAvailable: false },
    ])
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'k', notify })
    await ab.launch({ profile: 'a' })
    await flushMicrotasks()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not print the advisory notice when updateKernelBeforeLaunch is set (it updates instead)', async () => {
    installedKernelUpdatesSpy.mockReturnValue([
      { version: '150.0.7871.182', label: 'Chrome 150', installed: true, updateAvailable: true },
    ])
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'k', notify })
    await ab.launch({ profile: 'a', updateKernelBeforeLaunch: true })
    await flushMicrotasks()
    expect(notify).not.toHaveBeenCalled()
    // the flag is forwarded to the engine, which performs the pre-launch update
    const params = openProfileSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.updateKernelBeforeLaunch).toBe(true)
  })

  it('updateKernel() force-downloads only the installed versions that have an update', async () => {
    installedKernelUpdatesSpy.mockReturnValue([
      { version: '150.0.7871.182', label: 'Chrome 150', installed: true, updateAvailable: true },
      { version: '149.0.7827.201', label: 'Chrome 149', installed: true, updateAvailable: false },
    ])
    const ab = new AntiDetectBrowser({ key: 'k' })
    const updated = await ab.updateKernel()
    expect(updated).toEqual(['150.0.7871.182'])
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1)
    expect(ensureKernelSpy.mock.calls[0][3]).toEqual({ force: true })
  })

  it('updateKernel(version) updates just that version, and is a no-op when it has no update', async () => {
    installedKernelUpdatesSpy.mockReturnValue([
      { version: '150.0.7871.182', label: 'Chrome 150', installed: true, updateAvailable: true },
      { version: '149.0.7827.201', label: 'Chrome 149', installed: true, updateAvailable: false },
    ])
    const ab = new AntiDetectBrowser({ key: 'k' })
    expect(await ab.updateKernel('150.0.7871.182')).toEqual(['150.0.7871.182'])
    expect(await ab.updateKernel('149.0.7827.201')).toEqual([]) // no update → nothing re-downloaded
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1)
  })

  it('hasKernelUpdate reflects whether any installed kernel is stale', async () => {
    installedKernelUpdatesSpy.mockReturnValue([{ version: '150.0.7871.182', installed: true, updateAvailable: true }])
    expect(await new AntiDetectBrowser({ key: 'k' }).hasKernelUpdate()).toBe(true)
    installedKernelUpdatesSpy.mockReturnValue([{ version: '150.0.7871.182', installed: true, updateAvailable: false }])
    expect(await new AntiDetectBrowser({ key: 'k' }).hasKernelUpdate()).toBe(false)
  })

  it('passes the license token to the engine and skips cloud sync when sync=false', async () => {
    licenseSpy.mockResolvedValue({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 5, sync: false })
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'freep' })
    const params = openProfileSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.licenseToken).toBe('tok')
    expect(params.archiveGetUrl).toBeUndefined()
    expect(params.archivePutUrl).toBeUndefined()
  })
})

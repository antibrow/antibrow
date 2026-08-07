import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `openProfile` is imported directly by name in some tests below and needs
// to be the same identity as the spy (so `.mock`/`.mockClear` work on it),
// which requires it to exist before the hoisted `vi.mock` factory runs.
const openProfileSpy = vi.hoisted(() => vi.fn())

const fakePage = { url: () => 'about:blank', goto: vi.fn(async () => undefined), evaluate: vi.fn(async () => undefined) }
// Mirrors real Playwright: closing the underlying browser fires 'close' on
// its context, which is how the SDK's per-session cleanup actually runs.
let closeListeners: Array<() => void> = []
const fakeSession = {
  context: {
    pages: () => [fakePage],
    newPage: vi.fn(),
    addCookies: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    close: vi.fn(async () => undefined),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeListeners.push(cb)
    }),
  },
  wsEndpoint: 'ws://127.0.0.1/devtools/browser/abc',
  profileDir: 'D:/profiles/amazon-us',
  onExit: vi.fn(),
  close: vi.fn(async () => {
    closeListeners.forEach((cb) => cb())
  }),
}
openProfileSpy.mockImplementation(async () => fakeSession)
const licenseSpy = vi.fn(async () => ({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 10, sync: true }))
const installedKernelUpdatesSpy = vi.fn((): Array<Record<string, unknown>> => [])
const ensureKernelSpy = vi.fn(async () => 'C:/kernels/chrome.exe')
const refreshKernelVersionsSpy = vi.fn(async () => undefined)

vi.mock('../src/engine', () => ({
  openProfile: openProfileSpy,
  getLicenseToken: (...args: unknown[]) => licenseSpy(...(args as [])),
  ensureKernel: (...args: unknown[]) => ensureKernelSpy(...(args as [])),
  findKernelVersion: (v: string) => ({ version: v, label: v, platforms: {} }),
  refreshKernelVersions: (...args: unknown[]) => refreshKernelVersionsSpy(...(args as [])),
  installedKernelUpdates: (...args: unknown[]) => installedKernelUpdatesSpy(...(args as [])),
  // A minimal stand-in for the real profile-dir reader: reads profile.json out
  // of the given directory, same shape, no dependency on the real module.
  readProfileMeta: (dir: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'))
    } catch {
      return undefined
    }
  },
}))

const getOrCreateProfileSpy = vi.fn(async () => ({ id: 'profile-1', name: 'amazon-us', config: null }))
const getProfileArchiveUrlsSpy = vi.fn(async () => ({ downloadUrl: 'https://r2/get', uploadUrl: 'https://r2/put' }))
vi.mock('../src/api', () => ({
  getOrCreateProfile: (...args: unknown[]) => getOrCreateProfileSpy(...(args as [])),
  activateProxy: vi.fn(async () => ({ proxy: { id: 'px1', protocol: 'http', host: 'proxy.local', port: 8080, username: 'u', password: 'p' } })),
  managedProxyToRelayUrl: vi.fn((proxyId: string, secret: string) => `relay://${proxyId}:${secret}@proxy.antibrow.com`),
  issueProxyTicket: vi.fn(async () => ({
    ticketId: 't1', username: 'px1', password: 'sec', host: 'proxy.antibrow.com',
    expiresAt: '2026-08-08T00:00:00.000Z',
  })),
  revokeProxyTicket: vi.fn(async () => undefined),
  DEFAULT_RELAY_HOST: 'proxy.antibrow.com',
  getProfileArchiveUrls: (...args: unknown[]) => getProfileArchiveUrlsSpy(...(args as [])),
}))

const versionCheckSpy = vi.fn(async () => ({ status: 'ok', current: '1.0.0' }))
vi.mock('../src/version', () => ({
  SDK_VERSION: '1.0.0',
  checkClientVersion: (...args: unknown[]) => versionCheckSpy(...(args as [])),
}))

import { AntiDetectBrowser } from '../src/browser'

beforeEach(() => {
  closeListeners = []
  openProfileSpy.mockClear()
  licenseSpy.mockReset()
  licenseSpy.mockResolvedValue({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 10, sync: true })
  versionCheckSpy.mockReset()
  versionCheckSpy.mockResolvedValue({ status: 'ok', current: '1.0.0' })
  installedKernelUpdatesSpy.mockReset()
  installedKernelUpdatesSpy.mockReturnValue([])
  ensureKernelSpy.mockClear()
  getOrCreateProfileSpy.mockClear()
  getProfileArchiveUrlsSpy.mockClear()
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
    // The label travels as a serialised argument, never spliced into script
    // source: the first arg is the function, the second is the data.
    const call = fakeSession.context.addInitScript.mock.calls.find(
      (c) => typeof c[0] === 'function',
    )
    expect(call).toBeDefined()
    expect(call![1]).toEqual({ labelText: 'acct@x.com', bgColor: '#333333' })
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

  it("addresses the archive by userDataDir's own recorded name, not the passed profile name", async () => {
    // Otherwise: launch({ profile: 'gmail', userDataDir: <a directory whose
    // record says "work"> }) fetches gmail's archive and restores it into
    // work's directory - a cross-profile data leak.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-userdata-'))
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id: 'uuid-x', name: 'work', origin: 'local' }), 'utf8')

    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'gmail', userDataDir: dir })

    expect(getOrCreateProfileSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'work' }))
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'work' }))
    const params = openProfileSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.profileName).toBe('work')

    // The deferred re-fetch inside getArchivePutUrl must resolve the same name.
    getProfileArchiveUrlsSpy.mockClear()
    await (params.getArchivePutUrl as () => Promise<string | undefined>)()
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'work' }))
  })

  it('falls back to the passed profile name when userDataDir carries no record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-userdata-none-'))
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'gmail', userDataDir: dir })
    expect(getOrCreateProfileSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'gmail' }))
    const params = openProfileSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.profileName).toBe('gmail')
  })
})

describe('managed proxy ticket lifecycle', () => {
  it('launches with the ticket, not the account key', async () => {
    const { openProfile } = await import('../src/engine')
    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await b.launch({ profile: 'shop-01', proxyId: 'px1' })

    const passed = (openProfile as any).mock.calls.at(-1)![0]
    expect(passed.proxyUrl).toBe('relay://px1:sec@proxy.antibrow.com')
    expect(passed.proxyUrl).not.toContain('adb_secretkey')
  })

  it('labels the ticket with the profile name', async () => {
    const { issueProxyTicket } = await import('../src/api')
    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await b.launch({ profile: 'shop-01', proxyId: 'px1' })
    expect(issueProxyTicket).toHaveBeenCalledWith(
      expect.objectContaining({ proxyId: 'px1', label: 'shop-01' }),
    )
  })

  it('revokes the ticket when the browser closes', async () => {
    const { revokeProxyTicket } = await import('../src/api')
    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    const r = await b.launch({ profile: 'shop-01', proxyId: 'px1' })
    await r.browser.close()
    expect(revokeProxyTicket).toHaveBeenCalledWith(
      expect.objectContaining({ proxyId: 'px1', ticketId: 't1' }),
    )
  })

  // Losing the network on the way out must not strand the caller in close().
  it('still closes when revoking throws', async () => {
    const { revokeProxyTicket } = await import('../src/api')
    ;(revokeProxyTicket as any).mockRejectedValueOnce(new Error('offline'))
    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    const r = await b.launch({ profile: 'shop-01', proxyId: 'px1' })
    await expect(r.browser.close()).resolves.toBeUndefined()
  })

  // Falling back to the account key here would undo the whole change, so a
  // failed issuance has to fail the launch.
  it('fails the launch when the ticket cannot be issued', async () => {
    const { issueProxyTicket } = await import('../src/api')
    const { openProfile } = await import('../src/engine')
    ;(issueProxyTicket as any).mockRejectedValueOnce(new Error('HTTP 503'))
    ;(openProfile as any).mockClear()
    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await expect(b.launch({ profile: 'shop-03', proxyId: 'px1' })).rejects.toThrow(/503/)
    expect(openProfile).not.toHaveBeenCalled()
  })

  // A launch that dies after issuance (kernel download, concurrency cap, an
  // unresolvable proxy geo) has no close hook to revoke on, so clicking Open
  // against a flaky proxy would otherwise mint a live credential per attempt.
  it('revokes the ticket when the launch fails after issuance', async () => {
    const { revokeProxyTicket } = await import('../src/api')
    const { openProfile } = await import('../src/engine')
    ;(revokeProxyTicket as any).mockClear()
    ;(openProfile as any).mockRejectedValueOnce(new Error('kernel download failed'))

    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await expect(b.launch({ profile: 'shop-04', proxyId: 'px1' }))
      .rejects.toThrow(/kernel download failed/)
    expect(revokeProxyTicket).toHaveBeenCalledWith(
      expect.objectContaining({ proxyId: 'px1', ticketId: 't1' }),
    )
  })

  it('issues no ticket for a user-supplied proxy', async () => {
    const { issueProxyTicket } = await import('../src/api')
    ;(issueProxyTicket as any).mockClear()
    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await b.launch({ profile: 'shop-02', proxy: 'http://u:p@1.2.3.4:8080' })
    expect(issueProxyTicket).not.toHaveBeenCalled()
  })
})

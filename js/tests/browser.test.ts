import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
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
// Stands in for the real openProfile, including the one ordering that matters
// here: the proxy URL is resolved inside the launch (after the kernel would be
// installed), so a mock that skips it would report "no ticket was ever issued".
const openProfileDefault = async (opts: { proxyUrl?: string; getProxyUrl?: () => Promise<string | undefined> }) => {
  if (opts.getProxyUrl) opts.proxyUrl = await opts.getProxyUrl()
  return fakeSession
}
openProfileSpy.mockImplementation(openProfileDefault)
const licenseSpy = vi.fn(async () => ({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 10, sync: true }))
const installedKernelUpdatesSpy = vi.fn((): Array<Record<string, unknown>> => [])
const ensureKernelSpy = vi.fn(async () => 'C:/kernels/chrome.exe')
const refreshKernelVersionsSpy = vi.fn(async () => undefined)

// A launch with no proxy looks up this machine's own exit; unit tests must
// not depend on that reaching the network.
vi.mock('../src/engine/geoip', () => ({
  lookupProxyGeo: async () => null,
  lookupDirectGeo: async () => null,
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))

vi.mock('../src/engine', async () => ({
  // The real one, not a stand-in: it is what decides whether a caller's legacy
  // full version reaches the majors-only catalogue.
  normalizeKernelVersion: (await vi.importActual<typeof import('../src/engine/downloader')>('../src/engine/downloader')).normalizeKernelVersion,
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
const cloudProfile = { id: 'profile-1', name: 'amazon-us', config: null }
const getProfileSpy = vi.fn(async () => cloudProfile)
const getProfileArchiveUrlsSpy = vi.fn(async () => ({ downloadUrl: 'https://r2/get', uploadUrl: 'https://r2/put' }))
const getProfileArchiveUploadUrlSpy = vi.fn(async () => 'https://r2/put-fresh' as string | undefined)
vi.mock('../src/api', () => ({
  getOrCreateProfile: (...args: unknown[]) => getOrCreateProfileSpy(...(args as [])),
  getProfile: (...args: unknown[]) => getProfileSpy(...(args as [])),
  activateProxy: vi.fn(async () => ({ proxy: { id: 'px1', protocol: 'http', host: 'proxy.local', port: 8080, username: 'u', password: 'p' } })),
  managedProxyToRelayUrl: vi.fn((proxyId: string, secret: string) => `relay://${proxyId}:${secret}@proxy.antibrow.com`),
  issueProxyTicket: vi.fn(async () => ({
    ticketId: 't1', username: 'px1', password: 'sec', host: 'proxy.antibrow.com',
    expiresAt: '2026-08-08T00:00:00.000Z',
  })),
  revokeProxyTicket: vi.fn(async () => undefined),
  DEFAULT_RELAY_HOST: 'proxy.antibrow.com',
  getProfileArchiveUrls: (...args: unknown[]) => getProfileArchiveUrlsSpy(...(args as [])),
  getProfileArchiveUploadUrl: (...args: unknown[]) => getProfileArchiveUploadUrlSpy(...(args as [])),
}))

const versionCheckSpy = vi.fn(async () => ({ status: 'ok', current: '1.0.0' }))
vi.mock('../src/version', () => ({
  SDK_VERSION: '1.0.0',
  checkClientVersion: (...args: unknown[]) => versionCheckSpy(...(args as [])),
}))

import { AntiDetectBrowser, resolveSyncMode } from '../src/browser'

beforeEach(() => {
  closeListeners = []
  openProfileSpy.mockClear()
  openProfileSpy.mockImplementation(openProfileDefault)
  licenseSpy.mockReset()
  licenseSpy.mockResolvedValue({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 10, sync: true })
  versionCheckSpy.mockReset()
  versionCheckSpy.mockResolvedValue({ status: 'ok', current: '1.0.0' })
  installedKernelUpdatesSpy.mockReset()
  installedKernelUpdatesSpy.mockReturnValue([])
  ensureKernelSpy.mockClear()
  getOrCreateProfileSpy.mockClear()
  getProfileSpy.mockClear()
  getProfileArchiveUrlsSpy.mockClear()
  getProfileArchiveUploadUrlSpy.mockClear()
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

  it('hands the label to the kernel and injects nothing into the page', async () => {
    fakeSession.context.addInitScript.mockClear()
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'p', label: 'acct@x.com' })
    expect(openProfileSpy.mock.calls.at(-1)![0]).toMatchObject({ label: 'acct@x.com' })
    // The label used to be a fixed-position div, which any page could read back
    // off the DOM. The kernel draws it now, so nothing is injected.
    expect(fakeSession.context.addInitScript).not.toHaveBeenCalled()
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
      { version: '150', label: 'Chrome 150', installed: true, updateAvailable: true },
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
      { version: '150', label: 'Chrome 150', installed: true, updateAvailable: false },
    ])
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'k', notify })
    await ab.launch({ profile: 'a' })
    await flushMicrotasks()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not print the advisory notice when updateKernelBeforeLaunch is set (it updates instead)', async () => {
    installedKernelUpdatesSpy.mockReturnValue([
      { version: '150', label: 'Chrome 150', installed: true, updateAvailable: true },
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
      { version: '150', label: 'Chrome 150', installed: true, updateAvailable: true },
      { version: '149', label: 'Chrome 149', installed: true, updateAvailable: false },
    ])
    const ab = new AntiDetectBrowser({ key: 'k' })
    const updated = await ab.updateKernel()
    expect(updated).toEqual(['150'])
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1)
    expect(ensureKernelSpy.mock.calls[0][3]).toEqual({ force: true })
  })

  it('updateKernel(version) updates just that version, and is a no-op when it has no update', async () => {
    installedKernelUpdatesSpy.mockReturnValue([
      { version: '150', label: 'Chrome 150', installed: true, updateAvailable: true },
      { version: '149', label: 'Chrome 149', installed: true, updateAvailable: false },
    ])
    const ab = new AntiDetectBrowser({ key: 'k' })
    expect(await ab.updateKernel('150')).toEqual(['150'])
    expect(await ab.updateKernel('149')).toEqual([]) // no update → nothing re-downloaded
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1)
  })

  it('updateKernel(version) accepts the full version older releases documented', async () => {
    installedKernelUpdatesSpy.mockReturnValue([
      { version: '150', label: 'Chrome 150', installed: true, updateAvailable: true },
      { version: '149', label: 'Chrome 149', installed: true, updateAvailable: false },
    ])
    const ab = new AntiDetectBrowser({ key: 'k' })
    // Scripts written against the published 2.7.0 README pass a full version;
    // matching it raw against the majors-only catalogue is a silent no-op.
    expect(await ab.updateKernel('150.7.7.7')).toEqual(['150'])
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1)
  })

  it('hasKernelUpdate reflects whether any installed kernel is stale', async () => {
    installedKernelUpdatesSpy.mockReturnValue([{ version: '150', installed: true, updateAvailable: true }])
    expect(await new AntiDetectBrowser({ key: 'k' }).hasKernelUpdate()).toBe(true)
    installedKernelUpdatesSpy.mockReturnValue([{ version: '150', installed: true, updateAvailable: false }])
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

    expect(getProfileSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'work' }))
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'work' }))
    const params = openProfileSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.profileName).toBe('work')

    // The deferred re-fetch inside getArchivePutUrl must resolve the same name.
    await (params.getArchivePutUrl as () => Promise<string | undefined>)()
    expect(getProfileArchiveUploadUrlSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'work' }))
  })

  it('re-signs the exit-time upload without asking for the download side', async () => {
    // The GET half makes the server HEAD the cloud object, and the object it
    // would report is the one this session is about to overwrite anyway.
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'amazon-us' })
    const params = openProfileSpy.mock.calls[0][0] as Record<string, unknown>
    getProfileArchiveUrlsSpy.mockClear()

    const url = await (params.getArchivePutUrl as () => Promise<string | undefined>)()

    expect(url).toBe('https://r2/put-fresh')
    expect(getProfileArchiveUploadUrlSpy).toHaveBeenCalledTimes(1)
    expect(getProfileArchiveUrlsSpy).not.toHaveBeenCalled()
  })

  it('falls back to the passed profile name when userDataDir carries no record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-userdata-none-'))
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'gmail', userDataDir: dir })
    expect(getProfileSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'gmail' }))
    const params = openProfileSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.profileName).toBe('gmail')
  })
})

describe('resolveSyncMode', () => {
  it('refuses to sync a temporary profile', () => {
    expect(() => resolveSyncMode({ temporary: true, sync: true, licenseSync: true })).toThrow(/temporary/i)
  })

  it('keeps a temporary profile local', () => {
    expect(resolveSyncMode({ temporary: true, licenseSync: true })).toBe('off')
    expect(resolveSyncMode({ temporary: true, sync: false, licenseSync: true })).toBe('off')
  })

  it('only adopts profiles the server already knows by default', () => {
    expect(resolveSyncMode({ temporary: false, licenseSync: true })).toBe('existing')
    expect(resolveSyncMode({ temporary: false, licenseSync: false })).toBe('off')
  })

  it('creates the server row only when asked explicitly', () => {
    expect(resolveSyncMode({ temporary: false, sync: true, licenseSync: true })).toBe('create')
    expect(() => resolveSyncMode({ temporary: false, sync: true, licenseSync: false })).toThrow(/plan/i)
  })

  it('honours sync: false even on a syncing plan', () => {
    expect(resolveSyncMode({ temporary: false, sync: false, licenseSync: true })).toBe('off')
  })
})

describe('launch sync behaviour', () => {
  beforeEach(() => {
    getProfileSpy.mockClear()
    getOrCreateProfileSpy.mockClear()
    getProfileArchiveUrlsSpy.mockClear()
  })

  it('never creates a server row for an unknown profile name', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('Failed to get profile: HTTP 404. '))
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'brand-new' })

    expect(getProfileSpy).toHaveBeenCalledTimes(1)
    expect(getOrCreateProfileSpy).not.toHaveBeenCalled()
    expect(getProfileArchiveUrlsSpy).not.toHaveBeenCalled()
  })

  it('syncs a profile the server already knows', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'amazon-us' })

    expect(getProfileSpy).toHaveBeenCalledTimes(1)
    expect(getOrCreateProfileSpy).not.toHaveBeenCalled()
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledTimes(1)
  })

  it('creates the server row when sync is explicit', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'brand-new', sync: true })

    expect(getOrCreateProfileSpy).toHaveBeenCalledTimes(1)
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledTimes(1)
  })

  it('writes group (and tags) into the config it creates the cloud row with', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'brand-new', sync: true, group: 'asia', tags: ['us'] })

    expect(getOrCreateProfileSpy).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['us'], config: { group: 'asia' },
    }))
  })

  // group is not a per-launch write: it only lands in config at the moment the
  // cloud row is created. Pinned so nobody later "fixes" this into a silent
  // per-launch update of an existing profile's config.
  it('never writes group when launching an already-synced profile', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'amazon-us', group: 'asia' })

    expect(getProfileSpy).toHaveBeenCalledTimes(1)
    expect(getOrCreateProfileSpy).not.toHaveBeenCalled()
  })

  it('degrades to local when the existence probe fails', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('fetch failed'))
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'amazon-us' })

    expect(getProfileArchiveUrlsSpy).not.toHaveBeenCalled()
    expect(openProfileSpy).toHaveBeenCalledTimes(1)
  })

  it('probes once per profile name per process', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'amazon-us' })
    await ab.close()
    await ab.launch({ profile: 'amazon-us' })

    expect(getProfileSpy).toHaveBeenCalledTimes(1)
  })

  // A default launch concluding "the server does not have it" must not answer
  // for a later explicit sync: true, or the profile the caller asked to create
  // is silently never created.
  it('still creates the row when sync: true follows a default launch of an unknown name', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('Failed to get profile: HTTP 404. '))
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'brand-new' })
    await ab.close()
    expect(getOrCreateProfileSpy).not.toHaveBeenCalled()

    await ab.launch({ profile: 'brand-new', sync: true })

    expect(getOrCreateProfileSpy).toHaveBeenCalledTimes(1)
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledTimes(1)
  })

  // The flip side: a repeated default launch of a local-only name must stay at
  // one round trip, which is what the cache is for.
  it('does not re-probe a name the server already denied', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('Failed to get profile: HTTP 404. '))
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'brand-new' })
    await ab.close()
    await ab.launch({ profile: 'brand-new' })

    expect(getProfileSpy).toHaveBeenCalledTimes(1)
  })

  // A dropped connection is not an answer. Remembering one would keep a
  // long-lived process local-only for its whole life, never uploading again.
  it('re-probes after a transport failure instead of remembering it', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('fetch failed'))
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'amazon-us' })
    await ab.close()
    expect(getProfileArchiveUrlsSpy).not.toHaveBeenCalled()

    await ab.launch({ profile: 'amazon-us' })

    expect(getProfileSpy).toHaveBeenCalledTimes(2)
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledTimes(1)
  })

  // Creating the row makes it a row the server knows, so the default mode has
  // to see it too - otherwise the launch after the creating one silently
  // neither restores nor uploads.
  it('lets a default launch see a row created by an earlier sync: true launch', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('Failed to get profile: HTTP 404. '))
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'brand-new' })
    await ab.close()
    expect(getProfileArchiveUrlsSpy).not.toHaveBeenCalled()

    await ab.launch({ profile: 'brand-new', sync: true })
    await ab.close()
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledTimes(1)

    await ab.launch({ profile: 'brand-new' })

    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledTimes(2)
    expect(getProfileSpy).toHaveBeenCalledTimes(1) // the created row needs no re-probe
  })

  it('surfaces a transport failure under sync: true, then retries creation', async () => {
    // `sync: true` is a promise about where the data goes. Handing back a
    // browser that silently uploads nothing is worse than not launching.
    getOrCreateProfileSpy.mockRejectedValueOnce(new Error('fetch failed'))
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await expect(ab.launch({ profile: 'brand-new', sync: true })).rejects.toThrow('fetch failed')
    expect(getProfileArchiveUrlsSpy).not.toHaveBeenCalled()

    // Nothing was cached, so the next launch is a clean attempt.
    await ab.launch({ profile: 'brand-new', sync: true })

    expect(getOrCreateProfileSpy).toHaveBeenCalledTimes(2)
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledTimes(1)
  })
})

describe('local-only notice', () => {
  beforeEach(() => {
    getProfileSpy.mockClear()
    getOrCreateProfileSpy.mockClear()
  })

  it('tells the caller a fresh name defaulted to local-only', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('Failed to get profile: HTTP 404. '))
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'adb_test', notify })
    await ab.launch({ profile: 'brand-new' })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatch(/local-only/i)
    expect(notify.mock.calls[0][0]).toContain('brand-new')
    expect(notify.mock.calls[0][0]).toContain('sync: true')
  })

  it('stays silent when sync: false was passed', async () => {
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'adb_test', notify })
    await ab.launch({ profile: 'brand-new', sync: false })

    expect(notify).not.toHaveBeenCalled()
    expect(getProfileSpy).not.toHaveBeenCalled()
  })

  it('stays silent for a temporary profile', async () => {
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'adb_test', notify })
    await ab.launch({ profile: 'task-1', temporary: true })

    expect(notify).not.toHaveBeenCalled()
  })

  it('stays silent when the plan has no cloud sync', async () => {
    licenseSpy.mockResolvedValue({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 86400, mi: 1, sync: false })
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'adb_test', notify })
    await ab.launch({ profile: 'brand-new' })

    expect(notify).not.toHaveBeenCalled()
  })

  it('stays silent when the profile already syncs', async () => {
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'adb_test', notify })
    await ab.launch({ profile: 'amazon-us' })

    expect(notify).not.toHaveBeenCalled()
  })

  it('warns on a probe failure rather than launching unsynced in silence', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('fetch failed'))
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'adb_test', notify })
    await ab.launch({ profile: 'amazon-us' })

    expect(notify.mock.calls.map((c) => c[0]).join('\n')).toMatch(/without cloud sync/i)
  })

  it('fires only once across repeated launches of the same name', async () => {
    getProfileSpy.mockRejectedValue(new Error('Failed to get profile: HTTP 404. '))
    onTestFinished(() => { getProfileSpy.mockReset(); getProfileSpy.mockResolvedValue(cloudProfile) })
    const notify = vi.fn()
    const ab = new AntiDetectBrowser({ key: 'adb_test', notify })
    await ab.launch({ profile: 'brand-new' })
    await ab.close()
    await ab.launch({ profile: 'brand-new' })
    await ab.close()
    await ab.launch({ profile: 'brand-new' })

    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe('launch temporary flag', () => {
  beforeEach(() => {
    openProfileSpy.mockClear()
    getProfileSpy.mockClear()
  })

  it('passes the constructor default through to openProfile', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test', temporary: true })
    await ab.launch({ profile: 'task-1' })

    expect(openProfileSpy.mock.calls[0][0]).toMatchObject({ temporary: true })
    expect(getProfileSpy).not.toHaveBeenCalled()
  })

  it('lets a single launch override the constructor default', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test', temporary: true })
    await ab.launch({ profile: 'amazon-us', temporary: false })

    expect(openProfileSpy.mock.calls[0][0]).toMatchObject({ temporary: false })
    expect(getProfileSpy).toHaveBeenCalledTimes(1)
  })

  it('defaults to false', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test' })
    await ab.launch({ profile: 'amazon-us' })

    expect(openProfileSpy.mock.calls[0][0]).toMatchObject({ temporary: false })
  })

  it('rejects a temporary profile that also asks for sync', async () => {
    const ab = new AntiDetectBrowser({ key: 'adb_test', temporary: true })
    await expect(ab.launch({ profile: 'task-1', sync: true })).rejects.toThrow(/temporary/i)
  })

  // The rejection has to land before anything is issued server-side, or a
  // retry loop mints one live proxy credential per rejected attempt.
  it('issues no proxy ticket for a rejected option combination', async () => {
    const { issueProxyTicket } = await import('../src/api')
    ;(issueProxyTicket as any).mockClear()
    const ab = new AntiDetectBrowser({ key: 'adb_test', temporary: true })
    await expect(ab.launch({ profile: 'task-1', sync: true, proxyId: 'px1' })).rejects.toThrow(/temporary/i)
    expect(issueProxyTicket).not.toHaveBeenCalled()
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
  // failed issuance has to fail the launch, with no browser left behind.
  it('fails the launch when the ticket cannot be issued', async () => {
    const { issueProxyTicket, revokeProxyTicket } = await import('../src/api')
    ;(issueProxyTicket as any).mockRejectedValueOnce(new Error('HTTP 503'))
    ;(revokeProxyTicket as any).mockClear()
    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await expect(b.launch({ profile: 'shop-03', proxyId: 'px1' })).rejects.toThrow(/503/)
    expect(revokeProxyTicket).not.toHaveBeenCalled()
  })

  // The credential is single-session and a first launch on a new machine spends
  // its first many minutes installing a kernel; taken up front, it can be dead
  // (or revoked by this launch's own failure path) before the browser reads it.
  it('issues the ticket from inside the launch, not before it', async () => {
    const { issueProxyTicket } = await import('../src/api')
    ;(issueProxyTicket as any).mockClear()
    openProfileSpy.mockImplementationOnce(async (opts: { getProxyUrl?: () => Promise<string | undefined> }) => {
      expect(issueProxyTicket).not.toHaveBeenCalled()
      expect(await opts.getProxyUrl?.()).toBe('relay://px1:sec@proxy.antibrow.com')
      return fakeSession
    })

    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await b.launch({ profile: 'shop-05', proxyId: 'px1' })
    expect(issueProxyTicket).toHaveBeenCalledTimes(1)
  })

  // A launch that dies after issuance (kernel download, concurrency cap, an
  // unresolvable proxy geo) has no close hook to revoke on, so clicking Open
  // against a flaky proxy would otherwise mint a live credential per attempt.
  it('revokes the ticket when the launch fails after issuance', async () => {
    const { revokeProxyTicket } = await import('../src/api')
    const { openProfile } = await import('../src/engine')
    ;(revokeProxyTicket as any).mockClear()
    ;(openProfile as any).mockImplementationOnce(async (opts: { getProxyUrl?: () => Promise<string | undefined> }) => {
      await opts.getProxyUrl?.()
      throw new Error('kernel download failed')
    })

    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await expect(b.launch({ profile: 'shop-04', proxyId: 'px1' }))
      .rejects.toThrow(/kernel download failed/)
    expect(revokeProxyTicket).toHaveBeenCalledWith(
      expect.objectContaining({ proxyId: 'px1', ticketId: 't1' }),
    )
  })

  // The mirror case: a launch that dies before the kernel is ready never minted
  // anything, so there is nothing to hand back.
  it('revokes nothing when the launch fails before the ticket exists', async () => {
    const { revokeProxyTicket } = await import('../src/api')
    const { openProfile } = await import('../src/engine')
    ;(revokeProxyTicket as any).mockClear()
    ;(openProfile as any).mockRejectedValueOnce(new Error('kernel download failed'))

    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await expect(b.launch({ profile: 'shop-04', proxyId: 'px1' }))
      .rejects.toThrow(/kernel download failed/)
    expect(revokeProxyTicket).not.toHaveBeenCalled()
  })

  it('issues no ticket for a user-supplied proxy', async () => {
    const { issueProxyTicket } = await import('../src/api')
    ;(issueProxyTicket as any).mockClear()
    const b = new AntiDetectBrowser({ key: 'adb_secretkey' })
    await b.launch({ profile: 'shop-02', proxy: 'http://u:p@1.2.3.4:8080' })
    expect(issueProxyTicket).not.toHaveBeenCalled()
  })
})

// A throttled or unreachable server used to be indistinguishable from "this
// profile does not exist in the cloud": the launch went ahead local-only, so
// the session neither restored nor uploaded and the data was quietly lost.
describe('cloud sync when the server cannot answer', () => {
  it('hands the resolved cloud id to openProfile so the launch looks it up once', async () => {
    const ab = new AntiDetectBrowser({ key: 'k' })
    await ab.launch({ profile: 'amazon-us' })
    expect(getProfileSpy).toHaveBeenCalledTimes(1)
    expect(openProfileSpy.mock.calls[0][0]).toMatchObject({ serverProfileId: 'profile-1' })
  })

  const relaunch = async (ab: AntiDetectBrowser, profile: string) => {
    const res = await ab.launch({ profile })
    await res.browser.close()
  }

  it('does not cache the failure as "no cloud profile"', async () => {
    getProfileSpy.mockRejectedValueOnce(new Error('Failed to get profile: HTTP 429.'))
    const ab = new AntiDetectBrowser({ key: 'k', notify: vi.fn() })
    await relaunch(ab, 'amazon-us')
    await relaunch(ab, 'amazon-us')
    // The second launch has to ask again, or one 429 turns a long-lived process
    // local-only for the rest of its life.
    expect(getProfileSpy).toHaveBeenCalledTimes(2)
    expect(getProfileArchiveUrlsSpy).toHaveBeenCalledTimes(1)
  })

  it('fails the launch when sync was explicitly requested', async () => {
    getOrCreateProfileSpy.mockRejectedValueOnce(new Error('Failed to get profile: HTTP 429.'))
    const ab = new AntiDetectBrowser({ key: 'k', notify: vi.fn() })
    await expect(ab.launch({ profile: 'amazon-us', sync: true })).rejects.toThrow(/HTTP 429/)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Whether a launch carries --fp-crypt-key is decided by the profile directory's
// own mark, never by whether the server happens to hold a key: the kernel binds
// the key when the profile is created, so both mistakes are fatal - a key handed
// to a directory made without one, and a key withheld from one made with it.

const downloadSpy = vi.fn(async (_url: string, _dir: string) => true)

const launchSpy = vi.fn(async (_opts: Record<string, unknown>) => ({
  context: { pages: () => [], newPage: vi.fn() },
  profileDir: '',
  onExit: (_cb: () => void) => {},
  close: vi.fn(async () => undefined),
}))

vi.mock('../../src/engine/downloader', () => ({
  defaultKernelVersion: () => ({ version: '151', label: 'Chrome 151', platforms: {} }),
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  findKernelVersionStrict: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: async () => '/kernels/chrome',
  refreshKernelVersions: async () => undefined,
  kernelUpdateStatus: () => null,
  installedKernelBuild: () => undefined,
  kernelReadsAppLocaleFromConfig: () => false,
  kernelSupportsAndroid: () => true,
  resolveAndroidKernel: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ANDROID_MIN_KERNEL_VERSION: '151',
}))

vi.mock('../../src/engine/persona', () => ({
  loadOrGeneratePersona: () => ({ kernelVersion: '151', chromeMajor: 151, timezone: 'UTC', languages: ['en-US'] }),
  readPersona: () => undefined,
  writePersona: () => undefined,
  withKernelVersion: (p: unknown) => p,
}))

// The restore is the part that carries crypt-state.json onto a second machine,
// so it writes real files into the profile directory here.
vi.mock('../../src/engine/profile-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/profile-cache')>()),
  downloadProfileCache: (url: string, dir: string) => downloadSpy(url, dir),
  uploadProfileCache: async () => undefined,
}))

// Only the spawn is replaced; buildLaunchArgs stays real so the argv assertions
// below run against the builder the launch path actually uses.
vi.mock('../../src/engine/launcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/launcher')>()),
  launchKernel: (opts: Record<string, unknown>) => launchSpy(opts),
}))

import { openProfile } from '../../src/engine/index'
import { buildLaunchArgs, type BuildLaunchArgsOptions } from '../../src/engine/launcher'
import { isProfileEncrypted, markProfileEncrypted, writeCryptState, writeProfileMeta, readProfileMeta } from '../../src/engine/profile-dir'
import { fetchProfileCryptKey, parseCryptKeyBody, resolveCryptKey } from '../../src/engine/crypt-key'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crypt-'))
const base = () => ({ cacheDir: tmp(), profileName: 'p', licenseToken: 'tok' })

beforeEach(() => {
  launchSpy.mockClear()
  downloadSpy.mockReset()
  downloadSpy.mockResolvedValue(true)
})

function launchOptions(platform: NodeJS.Platform = 'darwin'): BuildLaunchArgsOptions {
  return {
    fpConfigPath: '/profiles/p1/fp-config.json',
    licenseToken: 'token-abc',
    userDataDir: '/profiles/p1/user-data',
    displayLabel: 'p1',
    cdpPort: 9222,
    language: 'en-US',
    profileDir: '/profiles/p1',
    platform,
  }
}

describe('buildLaunchArgs --fp-crypt-key', () => {
  it('passes the key when one is supplied', () => {
    const args = buildLaunchArgs({ ...launchOptions(), cryptKey: KEY })
    expect(args).toContain(`--fp-crypt-key=${KEY}`)
  })

  it('omits the flag entirely when no key is supplied', () => {
    const args = buildLaunchArgs(launchOptions())
    expect(args.some((a) => a.startsWith('--fp-crypt-key'))).toBe(false)
  })
})

describe('the encrypted mark', () => {
  it('survives a metadata rewrite that does not know about it', () => {
    const dir = tmp()
    writeProfileMeta(dir, { id: 'id-1', name: 'p', origin: 'local' })
    markProfileEncrypted(dir)
    const meta = readProfileMeta(dir)
    expect(meta?.encrypted).toBe(true)
    // The identity fields are untouched by the mark.
    expect(meta?.id).toBe('id-1')
    expect(isProfileEncrypted(dir)).toBe(true)
  })

  it('keeps foreign keys the SDK does not model (the desktop guest mark)', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id: 'g', name: 'g', origin: 'server', shareRole: 'guest' }))
    markProfileEncrypted(dir)
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8')) as Record<string, unknown>
    expect(raw.shareRole).toBe('guest')
    expect(raw.encrypted).toBe(true)
  })

  it('reads as unmarked for a directory with no record at all', () => {
    expect(isProfileEncrypted(tmp())).toBe(false)
  })
})

describe('parseCryptKeyBody', () => {
  it('reads a key', () => {
    expect(parseCryptKeyBody({ cryptKey: KEY })).toBe(KEY)
  })

  it('reads an explicit "no key" as undefined', () => {
    expect(parseCryptKeyBody({ cryptKey: null, reason: 'no_key' })).toBeUndefined()
  })

  it('throws on anything malformed rather than reporting "no key"', () => {
    expect(() => parseCryptKeyBody({ cryptKey: 'not-hex' })).toThrow()
    expect(() => parseCryptKeyBody({ cryptKey: KEY.slice(0, 32) })).toThrow()
    expect(() => parseCryptKeyBody('nonsense')).toThrow()
  })
})

describe('fetchProfileCryptKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports a non-2xx response naming the profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))

    await expect(fetchProfileCryptKey({ key: 'k', name: 'shop-01' })).rejects.toThrow('shop-01')
  })

  // The bug: a transport-level throw (offline, DNS failure, connection
  // refused) used to propagate raw from `fetch` as a bare "fetch failed",
  // with nothing tying it to encryption or to which profile. This is the
  // failure a laptop with no connectivity hits on every launch of an
  // encrypted profile, so the message has to say what happened.
  it('wraps a transport failure so it names the profile and the key, not just "fetch failed"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))

    await expect(fetchProfileCryptKey({ key: 'k', name: 'shop-01' })).rejects.toThrow(
      /shop-01.*encrypt|encrypt.*shop-01/is,
    )
  })

  it('keeps the original transport error reachable in the message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('getaddrinfo ENOTFOUND antibrow.com') }))

    await expect(fetchProfileCryptKey({ key: 'k', name: 'shop-01' })).rejects.toThrow(/ENOTFOUND/)
  })
})

describe('resolveCryptKey', () => {
  it('returns nothing for an unmarked directory, even when a key is on offer', async () => {
    const dir = tmp()
    const getCryptKey = vi.fn(async () => KEY)
    await expect(resolveCryptKey({ profileDir: dir, getCryptKey })).resolves.toBeUndefined()
    expect(getCryptKey).not.toHaveBeenCalled()
  })

  it('fails hard when a marked profile cannot get its key', async () => {
    const dir = tmp()
    markProfileEncrypted(dir)
    await expect(resolveCryptKey({ profileDir: dir, getCryptKey: async () => undefined })).rejects.toThrow(/encrypt/i)
  })

  it('propagates the fetch failure instead of launching without the flag', async () => {
    const dir = tmp()
    markProfileEncrypted(dir)
    await expect(
      resolveCryptKey({ profileDir: dir, getCryptKey: async () => { throw new Error('network down') } }),
    ).rejects.toThrow('network down')
  })
})

describe('openProfile', () => {
  it('passes the key of a marked profile to the kernel', async () => {
    const opts = base()
    const dir = path.join(opts.cacheDir, 'profiles', 'p1')
    fs.mkdirSync(dir, { recursive: true })
    markProfileEncrypted(dir)

    await openProfile({ ...opts, profileDir: dir, getCryptKey: async () => KEY })

    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: KEY }))
  })

  it('passes no key for an unmarked profile even when the server offers one', async () => {
    const opts = base()
    const dir = path.join(opts.cacheDir, 'profiles', 'p1')
    fs.mkdirSync(dir, { recursive: true })
    const getCryptKey = vi.fn(async () => OTHER_KEY)

    await openProfile({ ...opts, profileDir: dir, getCryptKey })

    expect(getCryptKey).not.toHaveBeenCalled()
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: undefined }))
  })

  it('never reaches the kernel when a marked profile cannot get its key', async () => {
    const opts = base()
    const dir = path.join(opts.cacheDir, 'profiles', 'p1')
    fs.mkdirSync(dir, { recursive: true })
    markProfileEncrypted(dir)

    await expect(
      openProfile({ ...opts, profileDir: dir, getCryptKey: async () => { throw new Error('HTTP 404') } }),
    ).rejects.toThrow('HTTP 404')

    expect(launchSpy).not.toHaveBeenCalled()
  })

  // The real path (opts.key, no getCryptKey override): a laptop with no
  // network trying to open an encrypted profile. The kernel must never spawn,
  // and the error the caller sees has to say more than "fetch failed".
  it('a transport failure fetching the real key never reaches the kernel and names the profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const opts = base()
    const dir = path.join(opts.cacheDir, 'profiles', 'p1')
    fs.mkdirSync(dir, { recursive: true })
    markProfileEncrypted(dir)

    await expect(
      openProfile({ ...opts, profileDir: dir, profileName: 'shop-01', key: 'api-key' }),
    ).rejects.toThrow(/shop-01/)

    expect(launchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  // The owner's second machine: the directory is created by restoring the
  // archive, so the archive is the only thing that can say the data is
  // encrypted. Before crypt-state.json travelled, this launched with no key and
  // the kernel refused to start.
  it('launches with the key after restoring an encrypted archive', async () => {
    const opts = base()
    const dir = path.join(opts.cacheDir, 'profiles', 'p1')
    fs.mkdirSync(dir, { recursive: true })
    downloadSpy.mockImplementation(async (_url: string, target: string) => {
      writeCryptState(target, true)
      return true
    })

    await openProfile({ ...opts, profileDir: dir, archiveGetUrl: 'https://r2/get.zip', getCryptKey: async () => KEY })

    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: KEY }))
  })

  // A guest whose owner promoted a local profile: the server holds a key (it is
  // minted when the row is created) but the archive was packed from a directory
  // that never used one. The offered key must be ignored, or the kernel refuses.
  it('ignores an offered key when the restored archive says the data is not encrypted', async () => {
    const opts = base()
    const dir = path.join(opts.cacheDir, 'profiles', 'p1')
    fs.mkdirSync(dir, { recursive: true })
    downloadSpy.mockImplementation(async (_url: string, target: string) => {
      fs.writeFileSync(path.join(target, 'persona.json'), JSON.stringify({ kernelVersion: '151' }))
      return true
    })

    await openProfile({ ...opts, profileDir: dir, archiveGetUrl: 'https://r2/get.zip', cryptKey: KEY })

    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: undefined }))
  })

  it('accepts a key resolved by the caller (the guest path)', async () => {
    const opts = base()
    const dir = path.join(opts.cacheDir, 'profiles', 'p1')
    fs.mkdirSync(dir, { recursive: true })
    markProfileEncrypted(dir)

    await openProfile({ ...opts, profileDir: dir, cryptKey: KEY })

    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: KEY }))
  })
})

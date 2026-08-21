import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Whether a profile is encrypted is decided by what the kernel DID, never by
// what the server minted for it: Chromium ignores switches it does not know, so
// a build without --fp-crypt-key support creates an ordinary profile and reports
// nothing. The verifier the kernel writes into `Local State` is the only witness,
// and a mark written before the kernel ever ran is a guess.

const downloadSpy = vi.fn(async (_url: string, _dir: string) => true)
const uploadSpy = vi.fn(async (_dir: string, _url: string) => 'etag-2')
let exitHooks: Array<() => void> = []

const launchSpy = vi.fn(async (_opts: Record<string, unknown>) => ({
  context: { pages: () => [], newPage: vi.fn() },
  profileDir: '',
  onExit: (cb: () => void) => { exitHooks.push(cb) },
  close: vi.fn(async () => undefined),
}))

// A launch with no proxy looks up this machine's own exit; unit tests must
// not depend on that reaching the network.
vi.mock('../../src/engine/geoip', () => ({
  lookupProxyGeo: async () => null,
  lookupDirectGeo: async () => null,
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
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

vi.mock('../../src/engine/profile-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/profile-cache')>()),
  downloadProfileCache: (url: string, dir: string) => downloadSpy(url, dir),
  uploadProfileCache: (dir: string, url: string) => uploadSpy(dir, url),
}))

vi.mock('../../src/engine/launcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/launcher')>()),
  launchKernel: (opts: Record<string, unknown>) => launchSpy(opts),
}))

import AdmZip from 'adm-zip'
import { openProfile } from '../../src/engine/index'
import { packProfileCache } from '../../src/engine/profile-cache'
import {
  CRYPT_PENDING_FILE,
  isProfileEncrypted,
  markProfileEncrypted,
  readCryptState,
  readProfileMeta,
  writeProfileMeta,
  isCryptKeyPending,
  markCryptKeyPending,
  settleCryptState,
} from '../../src/engine/profile-dir'

const KEY = 'a'.repeat(64)

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crypt-outcome-'))
const base = () => ({ cacheDir: tmp(), profileName: 'p', licenseToken: 'tok' })

/** What the kernel leaves behind: the verifier is written under `fp_crypt`. */
function writeLocalState(profileDir: string, keyBound: boolean): void {
  const ud = path.join(profileDir, 'user-data')
  fs.mkdirSync(ud, { recursive: true })
  fs.writeFileSync(
    path.join(ud, 'Local State'),
    JSON.stringify(keyBound ? { fp_crypt: { key_check: 'MbA6B9' } } : { os_crypt: null }),
  )
}

function profileDirIn(cacheDir: string): string {
  const dir = path.join(cacheDir, 'profiles', 'p1')
  fs.mkdirSync(dir, { recursive: true })
  writeProfileMeta(dir, { id: 'p1', name: 'p', origin: 'server' })
  return dir
}

beforeEach(() => {
  launchSpy.mockClear()
  downloadSpy.mockReset()
  downloadSpy.mockResolvedValue(true)
  uploadSpy.mockReset()
  uploadSpy.mockResolvedValue('etag-2')
  exitHooks = []
})

describe('settleCryptState', () => {
  it('marks the profile when the kernel wrote the verifier', () => {
    const dir = tmp()
    markCryptKeyPending(dir)
    writeLocalState(dir, true)

    expect(settleCryptState(dir)).toBe('bound')
    expect(isProfileEncrypted(dir)).toBe(true)
    expect(isCryptKeyPending(dir)).toBe(false)
  })

  it('leaves the profile unmarked when the kernel ignored the flag', () => {
    const dir = tmp()
    markCryptKeyPending(dir)
    writeLocalState(dir, false)

    expect(settleCryptState(dir)).toBe('plain')
    expect(isProfileEncrypted(dir)).toBe(false)
    expect(isCryptKeyPending(dir)).toBe(false)
  })

  // "Cannot tell" is its own answer. Collapsing it into "no key" is the mistake
  // that hands a key-bound profile to a kernel with no key.
  it('changes nothing while the directory cannot answer yet', () => {
    const dir = tmp()
    markCryptKeyPending(dir)

    expect(settleCryptState(dir)).toBe('unknown')
    expect(isCryptKeyPending(dir)).toBe(true)
    expect(isProfileEncrypted(dir)).toBe(false)
  })

  it('keeps a marked profile marked when Local State is unreadable', () => {
    const dir = tmp()
    markProfileEncrypted(dir)
    fs.mkdirSync(path.join(dir, 'user-data'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'user-data', 'Local State'), '{ truncated')

    expect(settleCryptState(dir)).toBe('unknown')
    expect(isProfileEncrypted(dir)).toBe(true)
  })

  // The profile this bug created: marked at creation time, then opened by a
  // kernel that dropped the switch. Its data proves the mark wrong.
  it('clears a mark the data contradicts', () => {
    const dir = tmp()
    writeProfileMeta(dir, { id: 'p1', name: 'p', origin: 'server' })
    markProfileEncrypted(dir)
    writeLocalState(dir, false)

    expect(settleCryptState(dir)).toBe('plain')
    expect(isProfileEncrypted(dir)).toBe(false)
    expect(readCryptState(dir)).toBe(false)
    expect(readProfileMeta(dir)?.encrypted).toBeUndefined()
    expect(readProfileMeta(dir)?.id).toBe('p1')
  })

  it('writes nothing for an ordinary unmarked profile', () => {
    const dir = tmp()
    writeLocalState(dir, false)

    expect(settleCryptState(dir)).toBe('plain')
    expect(readCryptState(dir)).toBeUndefined()
  })

  // The marker is about one directory's next launch, so it must not travel:
  // restored on a second machine it would demand a key for data that may never
  // have been bound to one.
  it('keeps the pending marker out of the cloud archive', () => {
    const dir = tmp()
    markCryptKeyPending(dir)
    writeLocalState(dir, false)

    const entries = new AdmZip(packProfileCache(dir)).getEntries().map((e) => e.entryName)
    expect(entries).not.toContain(CRYPT_PENDING_FILE)
  })
})

describe('openProfile: the launch that binds the key', () => {
  it('passes the key on the first launch, before anything is marked', async () => {
    const opts = base()
    const dir = profileDirIn(opts.cacheDir)
    markCryptKeyPending(dir)

    await openProfile({ ...opts, profileDir: dir, getCryptKey: async () => KEY })

    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: KEY }))
    expect(isProfileEncrypted(dir)).toBe(false)
  })

  it('marks the profile after an exit that proves the key was bound, before the archive is packed', async () => {
    const opts = base()
    const dir = profileDirIn(opts.cacheDir)
    markCryptKeyPending(dir)
    let packedClaim: boolean | undefined
    uploadSpy.mockImplementation(async (d: string) => {
      packedClaim = readCryptState(d)
      return 'etag-2'
    })

    const session = await openProfile({
      ...opts, profileDir: dir, getCryptKey: async () => KEY, archivePutUrl: 'https://r2/put.zip',
    })
    writeLocalState(dir, true)
    exitHooks.forEach((h) => h())
    await session.archiveUpload

    expect(isProfileEncrypted(dir)).toBe(true)
    expect(isCryptKeyPending(dir)).toBe(false)
    expect(packedClaim).toBe(true)
  })

  it('keeps a profile whose kernel ignored the flag unmarked, and the archive claims nothing', async () => {
    const opts = base()
    const dir = profileDirIn(opts.cacheDir)
    markCryptKeyPending(dir)
    let packedClaim: boolean | undefined
    uploadSpy.mockImplementation(async (d: string) => {
      packedClaim = readCryptState(d)
      return 'etag-2'
    })

    const session = await openProfile({
      ...opts, profileDir: dir, getCryptKey: async () => KEY, archivePutUrl: 'https://r2/put.zip',
    })
    writeLocalState(dir, false)
    exitHooks.forEach((h) => h())
    await session.archiveUpload

    expect(isProfileEncrypted(dir)).toBe(false)
    expect(packedClaim).not.toBe(true)

    // ... and the profile keeps launching, with no key and no key lookup.
    const getCryptKey = vi.fn(async () => KEY)
    launchSpy.mockClear()
    await openProfile({ ...opts, profileDir: dir, getCryptKey })

    expect(getCryptKey).not.toHaveBeenCalled()
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: undefined }))
  })

  it('never spawns the kernel when a profile expecting a key cannot get one', async () => {
    const opts = base()
    const dir = profileDirIn(opts.cacheDir)
    markCryptKeyPending(dir)

    await expect(
      openProfile({ ...opts, profileDir: dir, getCryptKey: async () => undefined }),
    ).rejects.toThrow(/encrypt/i)

    expect(launchSpy).not.toHaveBeenCalled()
  })
})

describe('openProfile: a profile mismarked by the create-time guess', () => {
  it('launches it with no key once its own data proves it plain', async () => {
    const opts = base()
    const dir = profileDirIn(opts.cacheDir)
    markProfileEncrypted(dir)
    writeLocalState(dir, false)
    const getCryptKey = vi.fn(async () => KEY)

    await openProfile({ ...opts, profileDir: dir, getCryptKey })

    expect(getCryptKey).not.toHaveBeenCalled()
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: undefined }))
    expect(isProfileEncrypted(dir)).toBe(false)
  })

  // The absolute rule, unchanged by any of the above: real encrypted data with
  // no key available fails, and the kernel is never started.
  it('still refuses when the data really is key-bound and no key can be had', async () => {
    const opts = base()
    const dir = profileDirIn(opts.cacheDir)
    markProfileEncrypted(dir)
    writeLocalState(dir, true)

    await expect(
      openProfile({ ...opts, profileDir: dir, getCryptKey: async () => undefined }),
    ).rejects.toThrow(/encrypt/i)

    expect(launchSpy).not.toHaveBeenCalled()
    expect(isProfileEncrypted(dir)).toBe(true)
  })

  // A restored archive is what tells the second machine the data is encrypted;
  // the settlement runs after the restore, so it never judges an empty directory.
  it('does not un-mark a directory whose archive has not been restored yet', async () => {
    const opts = base()
    const dir = profileDirIn(opts.cacheDir)
    downloadSpy.mockImplementation(async (_url: string, target: string) => {
      writeLocalState(target, true)
      const { writeCryptState } = await import('../../src/engine/profile-dir')
      writeCryptState(target, true)
      return true
    })

    await openProfile({
      ...opts, profileDir: dir, archiveGetUrl: 'https://r2/get.zip', getCryptKey: async () => KEY,
    })

    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ cryptKey: KEY }))
    expect(isProfileEncrypted(dir)).toBe(true)
  })
})

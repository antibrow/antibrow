import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../src/engine/downloader', () => ({
  DEFAULT_KERNEL_VERSION: { version: '150.0.7871.182', label: 'Chrome 150', platforms: {} },
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: async () => 'C:/kernels/chrome.exe',
  refreshKernelVersions: async () => undefined,
  kernelUpdateStatus: () => null,
  installedKernelBuild: () => undefined,
  kernelReadsAppLocaleFromConfig: () => false,
}))

vi.mock('../../src/engine/persona', () => ({
  loadOrGeneratePersona: () => ({ kernelVersion: '150.0.7871.182', chromeMajor: 150, timezone: 'UTC', languages: ['en-US'] }),
}))

/** Capture what openProfile actually hands the kernel. */
const launches: Array<{ profileDir: string; label?: string }> = []
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: async (opts: { profileDir: string; label?: string }) => {
    launches.push({ profileDir: opts.profileDir, label: opts.label })
    return {
      context: { pages: () => [], newPage: vi.fn() },
      profileDir: opts.profileDir,
      onExit: () => undefined,
      close: vi.fn(async () => undefined),
    }
  },
}))

import { openProfile } from '../../src/engine/index'
import { readProfileMeta } from '../../src/engine/profile-dir'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opr-'))

beforeEach(() => {
  launches.length = 0
  vi.restoreAllMocks()
})

describe('openProfile directory resolution', () => {
  it('lands on an id-named directory and labels the window with the profile name', async () => {
    const cacheDir = tmp()
    await openProfile({ cacheDir, profileName: 'gmail', licenseToken: 'tok' })
    const dir = launches[0].profileDir
    expect(path.dirname(dir)).toBe(path.join(cacheDir, 'profiles'))
    expect(path.basename(dir)).not.toBe('gmail')
    expect(readProfileMeta(dir)?.name).toBe('gmail')
    expect(launches[0].label).toBe('gmail')
    expect(fs.existsSync(path.join(dir, 'user-data'))).toBe(false)   // the kernel makes it, not us
  })

  it('reuses the same directory for the same name', async () => {
    const cacheDir = tmp()
    await openProfile({ cacheDir, profileName: 'gmail', licenseToken: 'tok' })
    await openProfile({ cacheDir, profileName: 'gmail', licenseToken: 'tok' })
    expect(launches[1].profileDir).toBe(launches[0].profileDir)
  })

  it('adopts an existing name-shaped directory instead of starting a new profile', async () => {
    const cacheDir = tmp()
    const legacy = path.join(cacheDir, 'profiles', 'gmail')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'marker.txt'), 'keep me', 'utf8')
    await openProfile({ cacheDir, profileName: 'gmail', licenseToken: 'tok' })
    const dir = launches[0].profileDir
    expect(fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8')).toBe('keep me')
    expect(readProfileMeta(dir)?.name).toBe('gmail')
  })

  it('asks the server for the shared id when a key is present', async () => {
    const cacheDir = tmp()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response(JSON.stringify({ id: 'server-uuid', name: 'gmail' }), { status: 200 })) as unknown as typeof fetch,
    )
    await openProfile({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test', licenseToken: 'tok' })
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/api/v1/profiles/gmail'), expect.anything())
    expect(path.basename(launches[0].profileDir)).toBe('server-uuid')
  })

  it('uses an explicit profileDir verbatim and writes no identity record', async () => {
    const cacheDir = tmp()
    const explicit = tmp()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await openProfile({ cacheDir, profileName: 'gmail', profileDir: explicit, key: 'adb_k', server: 'https://x.test', licenseToken: 'tok' })
    expect(launches[0].profileDir).toBe(explicit)
    expect(launches[0].label).toBe('gmail')
    expect(fs.existsSync(path.join(explicit, 'profile.json'))).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('routes to the temporary tree without touching the server', async () => {
    const cacheDir = tmp()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await openProfile({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test', licenseToken: 'tok', temporary: true })
    const dir = launches[0].profileDir
    expect(path.dirname(dir)).toBe(path.join(cacheDir, 'profiles-temp'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lets an explicit directory name itself: its record beats the passed name', async () => {
    // The archive is addressed by name, so the two SDKs have to agree on which
    // name wins here. The record inside the directory is its identity.
    const cacheDir = tmp()
    const explicit = tmp()
    fs.writeFileSync(
      path.join(explicit, 'profile.json'),
      JSON.stringify({ id: 'uuid-x', name: 'work', origin: 'local' }),
      'utf8',
    )
    await openProfile({ cacheDir, profileName: 'gmail', profileDir: explicit, licenseToken: 'tok' })
    expect(launches[0].label).toBe('work')
  })
})

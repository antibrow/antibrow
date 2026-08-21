import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  claimManagedProxy, createUserProxy, updateProfile, getProfile, swapManagedProxy,
  deleteProfile, getProfileArchiveUploadUrl,
} from '../src/api'
import { uploadProfileCache, exportProfileArchiveAsync } from '../src/engine'

const launchSpy = vi.hoisted(() => vi.fn(async () => ({ profileDir: '/p/shop-01' })))
// A launch with no proxy looks up this machine's own exit; unit tests must
// not depend on that reaching the network.
vi.mock('../src/engine/geoip', () => ({
  lookupProxyGeo: async () => null,
  lookupDirectGeo: async () => null,
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))

vi.mock('../src/browser', () => ({
  AntiDetectBrowser: class {
    launch = launchSpy
  },
  resolveSyncMode: (i: { temporary: boolean; sync?: boolean; licenseSync: boolean }) => {
    if (i.temporary) {
      if (i.sync === true) {
        throw new Error('A temporary profile cannot be synced. Drop `temporary` or drop `sync: true`.')
      }
      return 'off'
    }
    if (i.sync === false) return 'off'
    if (i.sync === true) {
      if (!i.licenseSync) throw new Error('Cloud sync is not available on your plan.')
      return 'create'
    }
    return i.licenseSync ? 'existing' : 'off'
  },
}))

const resolveProfileDirSyncSpy = vi.hoisted(() =>
  vi.fn(() => ({ dir: '/p/shop-01', id: 'local-1', name: 'shop-01' })))
const readProfileMetaSpy = vi.hoisted(() => vi.fn(() => undefined as unknown))
const writeProfileMetaSpy = vi.hoisted(() => vi.fn())
vi.mock('../src/engine', () => ({
  resolveProfileDirSync: resolveProfileDirSyncSpy,
  readProfileMeta: readProfileMetaSpy,
  writeProfileMeta: writeProfileMetaSpy,
  getLicenseToken: vi.fn(async () => ({ token: 't', exp: 0, mi: 10, sync: true })),
  uploadProfileCache: vi.fn(async () => 'etag-1' as string | undefined),
  exportProfileArchiveAsync: vi.fn(async () => Buffer.from('zip')),
}))

vi.mock('../src/profile', () => ({
  ensureCacheDir: () => '/cache',
}))

const getOrCreateProfileSpy = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'srv-1', name: 'shop-01', config: null })))
vi.mock('../src/api', () => ({
  getOrCreateProfile: getOrCreateProfileSpy,
  getProfile: vi.fn(async () => ({ id: 'srv-1', name: 'shop-01', config: null })),
  updateProfile: vi.fn(async () => ({ id: 'srv-1', name: 'shop-01', config: null })),
  claimManagedProxy: vi.fn(async () => ({ id: 'px-new' })),
  swapManagedProxy: vi.fn(async () => ({ id: 'px-swapped' })),
  activateProxy: vi.fn(async () => ({ proxy: { id: 'px1' } })),
  createUserProxy: vi.fn(async () => ({ id: 'sdk-abc' })),
  syncPullUserProxies: vi.fn(async () => ({ proxies: [] })),
  proxyConfigToUrl: vi.fn(() => 'http://u:p@h.io:8080'),
  deleteProfile: vi.fn(async () => undefined),
  getProfileArchiveUploadUrl: vi.fn(async () => 'https://r2/put' as string | undefined),
}))

import { profile } from '../src/profile-handle'

beforeEach(() => {
  launchSpy.mockClear()
  getOrCreateProfileSpy.mockClear()
  writeProfileMetaSpy.mockClear()
  readProfileMetaSpy.mockReturnValue(undefined)
  // Individually reset (not vi.clearAllMocks(), which would also wipe the
  // factory's other base implementations) - a persistent override set by one
  // test (e.g. `getProfile.mockResolvedValue(...)`) must not leak into the
  // next test regardless of declaration or shuffled run order.
  vi.mocked(getProfile).mockReset().mockResolvedValue(
    { id: 'srv-1', name: 'shop-01', config: null } as never,
  )
  vi.mocked(updateProfile).mockReset().mockResolvedValue(
    { id: 'srv-1', name: 'shop-01', config: null } as never,
  )
  vi.mocked(claimManagedProxy).mockReset().mockResolvedValue({ id: 'px-new' } as never)
  vi.mocked(createUserProxy).mockReset().mockResolvedValue({ id: 'sdk-abc' } as never)
  vi.mocked(swapManagedProxy).mockReset().mockResolvedValue({ id: 'px-swapped' } as never)
  vi.mocked(deleteProfile).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(getProfileArchiveUploadUrl).mockReset().mockResolvedValue('https://r2/put' as never)
  vi.mocked(uploadProfileCache).mockReset().mockResolvedValue('etag-1' as never)
  vi.mocked(exportProfileArchiveAsync).mockReset().mockResolvedValue(Buffer.from('zip'))
  resolveProfileDirSyncSpy.mockReset().mockReturnValue({ dir: '/p/shop-01', id: 'local-1', name: 'shop-01' })
})

describe('profile()', () => {
  it('requires a key and a name', async () => {
    // @ts-expect-error missing key
    await expect(profile({ name: 'shop-01' })).rejects.toThrow(/API key/)
    // @ts-expect-error missing name
    await expect(profile({ key: 'k' })).rejects.toThrow(/name/)
  })

  it('stays offline for a local profile', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    expect(p.name).toBe('shop-01')
    expect(p.synced).toBe(false)
    expect(p.dir).toBe('/p/shop-01')
    expect(getOrCreateProfileSpy).not.toHaveBeenCalled()
  })

  it('rejects temporary + sync', async () => {
    await expect(profile({ key: 'k', name: 'shop-01', temporary: true, sync: true }))
      .rejects.toThrow(/temporary/i)
  })

  it('passes runtime options through to launch and never a proxy', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.launch({ headless: true })
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'shop-01', headless: true, sync: false,
    }))
    const arg = launchSpy.mock.calls[0][0] as Record<string, unknown>
    expect(arg.proxyId).toBeUndefined()
  })

  it('rejects proxy options on launch', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    // @ts-expect-error proxy is not a session option
    await expect(p.launch({ proxy: 'http://x' })).rejects.toThrow(/binding/i)
  })

  it('rejects group options on launch, naming setGroup (not setProxy) as the fix', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    // @ts-expect-error group is not a session option - it belongs to the handle
    await expect(p.launch({ group: 'asia' })).rejects.toThrow(/setGroup/)
  })

  it('rejects sync/tags/temporary options on launch, each naming their own accessor', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    // @ts-expect-error sync is not a session option - it belongs to the handle
    await expect(p.launch({ sync: true })).rejects.toThrow(/enableSync/)
    // @ts-expect-error tags is not a session option - it belongs to the handle
    await expect(p.launch({ tags: ['x'] })).rejects.toThrow(/setTags/)
    // @ts-expect-error temporary is not a session option - it belongs to the handle
    await expect(p.launch({ temporary: true })).rejects.toThrow(/profile\(\{ temporary/)
  })
})

describe('proxy binding', () => {
  it('writes a url binding into profile.json for a local profile', async () => {
    await profile({ key: 'k', name: 'shop-01', sync: false, proxy: 'http://u:p@h.io:8080' })
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01', expect.objectContaining({
      proxy: { kind: 'url', url: 'http://u:p@h.io:8080' },
    }))
    expect(createUserProxy).not.toHaveBeenCalled()
  })

  it('does not write when the same url is passed again', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'url', url: 'http://u:p@h.io:8080' },
    })
    await profile({ key: 'k', name: 'shop-01', sync: false, proxy: 'http://u:p@h.io:8080' })
    expect(writeProfileMetaSpy).not.toHaveBeenCalled()
  })

  it('claims once for a managed profile and reuses it next time', async () => {
    await profile({ key: 'k', name: 'shop-01', sync: false, proxy: { kind: 'managed' } })
    expect(claimManagedProxy).toHaveBeenCalledTimes(1)
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01', expect.objectContaining({
      proxy: { kind: 'managed', managedProxyId: 'px-new' },
    }))

    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'managed', managedProxyId: 'px-new' },
    })
    vi.mocked(claimManagedProxy).mockClear()
    await profile({ key: 'k', name: 'shop-01', sync: false, proxy: { kind: 'managed' } })
    expect(claimManagedProxy).not.toHaveBeenCalled()
  })

  it('pushes a url into the proxy library for a synced profile and keeps the rest of config', async () => {
    vi.mocked(getProfile).mockResolvedValue({
      id: 'srv-1', name: 'shop-01',
      config: { group: 'asia', kernelVersion: '151' },
    } as never)
    await profile({ key: 'k', name: 'shop-01', sync: true, proxy: 'http://u:p@h.io:8080' })
    expect(createUserProxy).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^sdk-[0-9a-f]{16}$/),
      config: { type: 'HTTP', host: 'h.io', port: 8080, username: 'u', password: 'p' },
    }))
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        group: 'asia', kernelVersion: '151',
        proxy: { kind: 'local', localProxyId: 'sdk-abc' },
      }),
    }))
  })

  it('reuses the existing library row when the create collides', async () => {
    vi.mocked(createUserProxy).mockRejectedValueOnce(new Error('HTTP 409 already exists'))
    await profile({ key: 'k', name: 'shop-01', sync: true, proxy: 'http://u:p@h.io:8080' })
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        proxy: { kind: 'local', localProxyId: expect.stringMatching(/^sdk-/) },
      }),
    }))
  })

  it('falls back to a local binding when the proxy library is closed to this plan', async () => {
    const notify = vi.fn()
    vi.mocked(createUserProxy).mockRejectedValueOnce(new Error('HTTP 403 Proxy library sync requires a paid plan.'))
    const p = await profile({ key: 'k', name: 'shop-01', sync: true, proxy: 'http://u:p@h.io:8080', notify })
    expect(p.proxy).toEqual({ kind: 'url', url: 'http://u:p@h.io:8080' })
    expect(writeProfileMetaSpy).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/this machine only/i))
  })

  it('throws when an explicit binding cannot be written', async () => {
    vi.mocked(updateProfile).mockRejectedValueOnce(new Error('HTTP 503'))
    await expect(profile({ key: 'k', name: 'shop-01', sync: true, proxy: 'http://u:p@h.io:8080' }))
      .rejects.toThrow(/503/)
  })

  it('feeds a managed binding to launch as proxyId', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'managed', managedProxyId: 'px1' },
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.launch()
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ proxyId: 'px1' }))
  })

  it('feeds a url binding to launch as proxy', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'url', url: 'http://u:p@h.io:8080' },
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.launch()
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ proxy: 'http://u:p@h.io:8080' }))
  })
})

describe('handle mutators', () => {
  it('setProxy(null) clears the binding', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'managed', managedProxyId: 'px1' },
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.setProxy(null)
    expect(p.proxy).toBeUndefined()
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01',
      expect.objectContaining({ proxy: undefined }))
  })

  it('swapProxy replaces the managed binding', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'managed', managedProxyId: 'px1' },
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.swapProxy()
    expect(swapManagedProxy).toHaveBeenCalledWith(expect.objectContaining({ proxyId: 'px1' }))
    expect(p.proxy).toEqual({ kind: 'managed', managedProxyId: 'px-swapped' })
  })

  it('swapProxy refuses a non-managed binding', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'url', url: 'http://u:p@h.io:8080' },
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await expect(p.swapProxy()).rejects.toThrow(/managed/i)
  })

  it('setTags replaces the top-level tags on a synced profile and leaves config.tags untouched', async () => {
    // config.tags is the desktop app's own field - a synced profile's SDK
    // tags live only in the top-level column. setTags never calls getProfile,
    // so there is nothing to seed there for this test.
    const p = await profile({ key: 'k', name: 'shop-01', sync: true })
    await p.setTags(['us', 'shop'])
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv-1', tags: ['us', 'shop'] }))
    const call = vi.mocked(updateProfile).mock.calls.at(-1)![0]
    expect(call.config).toBeUndefined()
    expect(p.getTags()).toEqual(['us', 'shop'])
  })

  it('setTags on a local profile writes profile.json instead of requiring cloud sync', async () => {
    // Abolished: an earlier draft threw "requires cloud sync" here. Two
    // adjacent label fields where one works and the other throws is a trap.
    readProfileMetaSpy.mockReturnValue({ id: 'local-1', name: 'shop-01', origin: 'local' })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.setTags(['us'])
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01', expect.objectContaining({ tags: ['us'] }))
    expect(p.getTags()).toEqual(['us'])
  })

  it('setTags([]) writes an empty array - that is a value, not a clear', async () => {
    readProfileMetaSpy.mockReturnValue({ id: 'local-1', name: 'shop-01', origin: 'local', tags: ['us'] })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.setTags([])
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01', expect.objectContaining({ tags: [] }))
    expect(p.getTags()).toEqual([])
  })

  it('getGroup/getTags are synchronous reads that issue no requests', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local', group: 'asia', tags: ['us'],
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    expect(p.getGroup()).toBe('asia')
    expect(p.getTags()).toEqual(['us'])
  })

  it('setGroup does a read-modify-write of config on a synced profile, preserving the rest', async () => {
    vi.mocked(getProfile).mockResolvedValue({
      id: 'srv-1', name: 'shop-01', config: { label: 'Shop 01', kernelVersion: '151' },
    } as never)
    const p = await profile({ key: 'k', name: 'shop-01', sync: true })
    await p.setGroup('asia')
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      config: { label: 'Shop 01', kernelVersion: '151', group: 'asia' },
    }))
    expect(p.getGroup()).toBe('asia')
  })

  it('setGroup(null) clears the group on a local profile', async () => {
    readProfileMetaSpy.mockReturnValue({ id: 'local-1', name: 'shop-01', origin: 'local', group: 'asia' })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.setGroup(null)
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01', expect.objectContaining({ group: undefined }))
    expect(p.getGroup()).toBeUndefined()
  })

  it('setGroup on a local profile writes profile.json', async () => {
    readProfileMetaSpy.mockReturnValue({ id: 'local-1', name: 'shop-01', origin: 'local' })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.setGroup('asia')
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01', expect.objectContaining({ group: 'asia' }))
    expect(p.getGroup()).toBe('asia')
  })
})

describe('group and tags on profile()', () => {
  it('reads persisted local group/tags back on reopen', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local', group: 'asia', tags: ['us', 'shop'],
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    expect(p.getGroup()).toBe('asia')
    expect(p.getTags()).toEqual(['us', 'shop'])
  })

  it('an explicit ProfileOptions.group/tags overwrites and persists on a local profile', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local', group: 'asia', tags: ['us'],
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false, group: 'na', tags: ['ca'] })
    expect(p.getGroup()).toBe('na')
    expect(p.getTags()).toEqual(['ca'])
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01',
      expect.objectContaining({ group: 'na', tags: ['ca'] }))
  })

  it('creates the cloud profile with group in config when sync is explicit', async () => {
    await profile({ key: 'k', name: 'shop-01', sync: true, group: 'asia' })
    expect(getOrCreateProfileSpy).toHaveBeenCalledWith(expect.objectContaining({
      config: { group: 'asia' },
    }))
  })
})

describe('group/tags reconciliation on an already-existing synced row', () => {
  // getOrCreateProfile is GET-first: when the row already exists, the server
  // returns it unmodified and never applies the config/tags we sent along
  // with the create attempt. profile() has to notice the mismatch itself.

  it('writes a new group value that differs from the existing row', async () => {
    getOrCreateProfileSpy.mockResolvedValueOnce({
      id: 'srv-1', name: 'shop-01', config: { group: 'na', label: 'Shop 01' }, tags: ['us'],
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: true, group: 'asia' })
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: 'srv-1', config: { group: 'asia', label: 'Shop 01' },
    }))
    expect(p.getGroup()).toBe('asia')
  })

  it('issues no request when the group already matches the existing row', async () => {
    getOrCreateProfileSpy.mockResolvedValueOnce({
      id: 'srv-1', name: 'shop-01', config: { group: 'asia', label: 'Shop 01' }, tags: ['us'],
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: true, group: 'asia' })
    expect(updateProfile).not.toHaveBeenCalled()
    expect(p.getGroup()).toBe('asia')
  })

  it('writes new tags that differ from the existing row', async () => {
    getOrCreateProfileSpy.mockResolvedValueOnce({
      id: 'srv-1', name: 'shop-01', config: null, tags: ['us'],
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: true, tags: ['us', 'shop'] })
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: 'srv-1', tags: ['us', 'shop'],
    }))
    expect(p.getTags()).toEqual(['us', 'shop'])
  })

  it('issues no request when the tags already match the existing row', async () => {
    getOrCreateProfileSpy.mockResolvedValueOnce({
      id: 'srv-1', name: 'shop-01', config: null, tags: ['us', 'shop'],
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: true, tags: ['us', 'shop'] })
    expect(updateProfile).not.toHaveBeenCalled()
    expect(p.getTags()).toEqual(['us', 'shop'])
  })
})

describe('sync switches', () => {
  it('enableSync creates the cloud row, uploads the data and migrates the binding', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'url', url: 'http://u:p@h.io:8080' },
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.enableSync()
    expect(p.synced).toBe(true)
    expect(getOrCreateProfileSpy).toHaveBeenCalled()
    expect(createUserProxy).toHaveBeenCalled()
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ proxy: { kind: 'local', localProxyId: 'sdk-abc' } }),
    }))
    expect(uploadProfileCache).toHaveBeenCalled()
  })

  it('enableSync is a no-op on an already synced profile', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: true })
    getOrCreateProfileSpy.mockClear()
    await p.enableSync()
    expect(getOrCreateProfileSpy).not.toHaveBeenCalled()
  })

  it('enableSync carries the local group and tags up to the server', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local', group: 'asia', tags: ['us', 'shop'],
    })
    getOrCreateProfileSpy.mockResolvedValueOnce({ id: 'srv-1', name: 'shop-01', config: null, tags: [] })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.enableSync()

    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv-1', tags: ['us', 'shop'] }))
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: 'srv-1', config: expect.objectContaining({ group: 'asia' }),
    }))
    // Never through ProfileConfig.tags - that field belongs to the desktop app.
    const tagsCall = vi.mocked(updateProfile).mock.calls.find((c) => c[0].tags !== undefined)![0]
    expect(tagsCall.config).toBeUndefined()
  })

  it('dangerousDisconnectSync deletes the cloud row and keeps the local dir', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: true })
    await p.dangerousDisconnectSync()
    expect(deleteProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'shop-01' }))
    expect(p.synced).toBe(false)
  })

  it('dangerousDisconnectSync is a no-op on an already-local profile', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.dangerousDisconnectSync()
    expect(deleteProfile).not.toHaveBeenCalled()
    expect(p.synced).toBe(false)
  })

  it('dangerousDisconnectSync carries the proxy binding, group and tags down to profile.json', async () => {
    vi.mocked(getProfile).mockResolvedValue({
      id: 'srv-1', name: 'shop-01',
      config: { proxy: { kind: 'managed', managedProxyId: 'px1' }, group: 'asia' },
      tags: ['us', 'shop'],
    } as never)
    const p = await profile({ key: 'k', name: 'shop-01', sync: true })
    await p.dangerousDisconnectSync()
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01', expect.objectContaining({
      proxy: { kind: 'managed', managedProxyId: 'px1' },
      group: 'asia',
      tags: ['us', 'shop'],
    }))
    expect(p.getGroup()).toBe('asia')
    expect(p.getTags()).toEqual(['us', 'shop'])
  })

  it('dangerousDisconnectSync tolerates a 404 pre-read and falls back to the handle\'s own state', async () => {
    getOrCreateProfileSpy.mockResolvedValueOnce({
      id: 'srv-1', name: 'shop-01',
      config: { proxy: { kind: 'managed', managedProxyId: 'px1' }, group: 'asia' },
      tags: ['us'],
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: true })
    vi.mocked(getProfile).mockRejectedValueOnce(new Error('HTTP 404 not found'))

    await p.dangerousDisconnectSync()

    expect(deleteProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'shop-01' }))
    expect(writeProfileMetaSpy).toHaveBeenCalledWith('/p/shop-01', expect.objectContaining({
      proxy: { kind: 'managed', managedProxyId: 'px1' },
      group: 'asia',
      tags: ['us'],
    }))
    expect(p.synced).toBe(false)
  })

  it('dangerousDisconnectSync does not throw when called a second time', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: true })
    await p.dangerousDisconnectSync()
    await expect(p.dangerousDisconnectSync()).resolves.toBeUndefined()
    expect(deleteProfile).toHaveBeenCalledTimes(1)
  })

  it('enableSync throws for a temporary handle instead of creating a cloud row', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', temporary: true })
    await expect(p.enableSync()).rejects.toThrow(/temporary/i)
    expect(getOrCreateProfileSpy).not.toHaveBeenCalled()
  })

  it('a launch after enableSync() sends sync: true, not the frozen constructor value', async () => {
    // profile({ sync: false }) then enableSync() then launch() must not
    // re-send sync: false - that would make browser.launch() treat the
    // profile as local-only again and skip the archive round-trip entirely,
    // freezing the cloud copy at whatever enableSync() just uploaded.
    readProfileMetaSpy.mockReturnValue({ id: 'local-1', name: 'shop-01', origin: 'local' })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.enableSync()
    await p.launch()
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ sync: true }))
  })

  it('a launch after dangerousDisconnectSync() sends sync: false, not the frozen constructor value', async () => {
    // profile({ sync: true }) then dangerousDisconnectSync() then launch()
    // must not re-send sync: true - browser.launch() would then run
    // create-mode hasCloudProfile() and silently recreate the row this call
    // just deleted, re-consuming the sync slot.
    const p = await profile({ key: 'k', name: 'shop-01', sync: true })
    await p.dangerousDisconnectSync()
    await p.launch()
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ sync: false }))
  })
})

describe('profile directory', () => {
  it('dir re-resolves by name rather than caching the location resolved at profile() time', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    expect(p.dir).toBe('/p/shop-01')

    // Simulates what openProfile's own (async, server-aware) directory
    // resolution does on this profile's first real launch when the server
    // already knows the name: it renames the directory to the server id.
    // profile()'s own resolution is local-only and one-shot, so it never
    // observes this - a `dir` cached as a field at construction time would
    // go on pointing at the directory that just got renamed away.
    resolveProfileDirSyncSpy.mockReturnValue({ dir: '/p/srv-1', id: 'srv-1', name: 'shop-01' })

    expect(p.dir).toBe('/p/srv-1')
  })

  it('an explicit userDataDir is pinned and never re-resolved', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false, userDataDir: '/custom/dir' })
    expect(p.dir).toBe('/custom/dir')
    resolveProfileDirSyncSpy.mockReturnValue({ dir: '/p/srv-1', id: 'srv-1', name: 'shop-01' })
    expect(p.dir).toBe('/custom/dir')
  })
})

describe('export', () => {
  it('returns a buffer when no path is given', async () => {
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    const out = await p.export()
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(exportProfileArchiveAsync).toHaveBeenCalledWith('/p/shop-01',
      expect.objectContaining({ name: 'shop-01' }),
      // An encrypted profile is converted on a copy before packing, which needs
      // the key, a kernel and a licence - all of which hang off these three.
      expect.objectContaining({ key: 'k', cacheDir: '/cache' }))
  })

  it('writes the file and returns its path', async () => {
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-exp-')), 'shop-01.fpprofile')
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    const out = await p.export(target)
    expect(out).toBe(target)
    expect(fs.existsSync(target)).toBe(true)
  })

  it('carries a url binding into the archive meta as proxyUrl', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'url', url: 'http://u:p@h.io:8080' },
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.export()
    expect(exportProfileArchiveAsync).toHaveBeenCalledWith('/p/shop-01',
      expect.objectContaining({ proxyUrl: 'http://u:p@h.io:8080' }), expect.anything())
  })

  it('leaves proxyUrl undefined for a managed binding', async () => {
    readProfileMetaSpy.mockReturnValue({
      id: 'local-1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'managed', managedProxyId: 'px1' },
    })
    const p = await profile({ key: 'k', name: 'shop-01', sync: false })
    await p.export()
    expect(exportProfileArchiveAsync).toHaveBeenCalledWith('/p/shop-01',
      expect.objectContaining({ proxyUrl: undefined }), expect.anything())
  })
})

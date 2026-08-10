import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createProfile, updateProfile, deleteProfile, syncPullProfiles,
  getProfileArchiveUrls, getProfileArchiveUploadUrl,
} from '../src/api'
import type { ProfileConfig, SyncedProfile } from '../src/types'

const cfg: ProfileConfig = { label: 'Work', tags: ['us'] }
const synced: SyncedProfile = {
  id: 'uuid-1', name: 'work', config: cfg,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', deletedAt: null,
}

function mockFetchOnce(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals() })

describe('createProfile', () => {
  it('POSTs id + config and returns the SyncedProfile', async () => {
    const fn = mockFetchOnce(synced, 201)
    const r = await createProfile({ key: 'k', server: 'https://s', name: 'work', id: 'uuid-1', config: cfg })
    expect(r.id).toBe('uuid-1')
    expect(r.config).toEqual(cfg)
    const [, init] = fn.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ id: 'uuid-1', name: 'work', tags: undefined, config: cfg })
  })

  it('throws on non-ok response', async () => {
    mockFetchOnce({ error: { message: 'nope' } }, 409)
    await expect(createProfile({ key: 'k', server: 'https://s', name: 'work' })).rejects.toThrow('HTTP 409')
  })
})

describe('updateProfile', () => {
  it('PUTs to /:id and returns the SyncedProfile', async () => {
    const fn = mockFetchOnce({ ...synced, name: 'renamed' })
    const r = await updateProfile({ key: 'k', server: 'https://s', id: 'uuid-1', name: 'renamed', config: cfg })
    expect(r.name).toBe('renamed')
    const [u, init] = fn.mock.calls[0]
    expect(String(u)).toBe('https://s/api/v1/profiles/uuid-1')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ name: 'renamed', tags: undefined, config: cfg })
  })
})

describe('deleteProfile', () => {
  it('DELETEs /:id when given an id', async () => {
    const fn = mockFetchOnce({ success: true, deletedAt: '2026-01-03T00:00:00.000Z' })
    await deleteProfile({ key: 'k', server: 'https://s', id: 'uuid-1' })
    const [u, init] = fn.mock.calls[0]
    expect(String(u)).toBe('https://s/api/v1/profiles/uuid-1')
    expect(init.method).toBe('DELETE')
  })

  it('falls back to name when no id given', async () => {
    const fn = mockFetchOnce({ success: true })
    await deleteProfile({ key: 'k', server: 'https://s', name: 'work' })
    expect(String(fn.mock.calls[0][0])).toBe('https://s/api/v1/profiles/work')
  })
})

describe('syncPullProfiles', () => {
  it('GETs without since and returns the page', async () => {
    const fn = mockFetchOnce({ profiles: [synced], serverTime: '2026-01-04T00:00:00.000Z' })
    const page = await syncPullProfiles({ key: 'k', server: 'https://s' })
    expect(page.profiles).toHaveLength(1)
    expect(page.serverTime).toBe('2026-01-04T00:00:00.000Z')
    expect(String(fn.mock.calls[0][0])).toBe('https://s/api/v1/profiles')
  })

  it('appends ?since= when provided', async () => {
    const fn = mockFetchOnce({ profiles: [], serverTime: '2026-01-05T00:00:00.000Z' })
    await syncPullProfiles({ key: 'k', server: 'https://s', since: '2026-01-04T00:00:00.000Z' })
    expect(String(fn.mock.calls[0][0])).toBe('https://s/api/v1/profiles?since=2026-01-04T00%3A00%3A00.000Z')
  })
})

describe('getProfileArchiveUrls', () => {
  it('signs both slots from one GET and one POST', async () => {
    const fn = vi.fn().mockImplementation((_u: string, init: RequestInit) =>
      Promise.resolve(Response.json(init.method === 'GET'
        ? { downloadUrl: 'https://r2/get', version: 'etag-1' }
        : { uploadUrl: 'https://r2/put' })))
    vi.stubGlobal('fetch', fn)
    const r = await getProfileArchiveUrls({ key: 'k', server: 'https://s', name: 'work' })
    expect(r).toEqual({ downloadUrl: 'https://r2/get', version: 'etag-1', uploadUrl: 'https://r2/put' })
  })
})

describe('getProfileArchiveUploadUrl', () => {
  it('POSTs only - a re-sign must not cost the GET side', async () => {
    const fn = mockFetchOnce({ uploadUrl: 'https://r2/put' })
    const url = await getProfileArchiveUploadUrl({ key: 'k', server: 'https://s', name: 'work' })
    expect(url).toBe('https://r2/put')
    expect(fn.mock.calls).toHaveLength(1)
    const [u, init] = fn.mock.calls[0]
    expect(String(u)).toBe('https://s/api/v1/profiles/work/archive')
    expect(init.method).toBe('POST')
  })

  it('returns undefined when the profile has no archive slot', async () => {
    mockFetchOnce({ error: { message: 'Profile sync requires a paid plan.' } }, 403)
    await expect(getProfileArchiveUploadUrl({ key: 'k', server: 'https://s', name: 'work' })).resolves.toBeUndefined()
  })
})

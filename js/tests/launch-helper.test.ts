import { describe, it, expect, vi, afterEach } from 'vitest'
import { getProfileForLaunch } from '../src/api'
import type { SyncedProfile } from '../src/types'

function syncedBody(over: Partial<SyncedProfile>): SyncedProfile {
  return {
    id: 'uuid-1', name: 'work',
    config: {},
    createdAt: 'c', updatedAt: 'u', deletedAt: null, ...over,
  }
}
function mockFetchOnce(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}
afterEach(() => { vi.unstubAllGlobals() })

describe('getProfileForLaunch', () => {
  it('returns profile name and GETs /:id', async () => {
    const fn = mockFetchOnce(syncedBody({}))
    const r = await getProfileForLaunch({ key: 'k', server: 'https://s', id: 'uuid-1' })
    expect(r).toEqual({ profile: 'work' })
    expect(String(fn.mock.calls[0][0])).toBe('https://s/api/v1/profiles/uuid-1')
    expect(fn.mock.calls[0][1].method).toBe('GET')
  })

  it('maps a managed proxy ref to proxyId', async () => {
    mockFetchOnce(syncedBody({ config: { proxy: { kind: 'managed', managedProxyId: 'pool-9' } } }))
    const r = await getProfileForLaunch({ key: 'k', server: 'https://s', name: 'work' })
    expect(r.proxyId).toBe('pool-9')
  })

  it('resolves a local proxy ref to a proxy url via the proxy library', async () => {
    const profileBody = syncedBody({ config: { proxy: { kind: 'local', localProxyId: 'px-1' } } })
    const proxyPage = { proxies: [{ id: 'px-1', config: { type: 'SOCKS5', host: '9.9.9.9', port: 1080, username: 'u', password: 'p' }, createdAt: 'c', updatedAt: 'u', deletedAt: null }], serverTime: 't' }
    const fn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(profileBody), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(proxyPage), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fn)
    const r = await getProfileForLaunch({ key: 'k', server: 'https://s', id: 'uuid-1' })
    expect(r.proxy).toBe('socks5://u:p@9.9.9.9:1080')
    expect(r.proxyId).toBeUndefined()
  })

  it('leaves proxy unset when the local proxy id is not found in the library', async () => {
    const profileBody = syncedBody({ config: { proxy: { kind: 'local', localProxyId: 'missing' } } })
    const fn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(profileBody), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ proxies: [], serverTime: 't' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fn)
    const r = await getProfileForLaunch({ key: 'k', server: 'https://s', id: 'uuid-1' })
    expect(r.proxy).toBeUndefined()
  })

  it('returns only the profile name for a config-less ghost', async () => {
    mockFetchOnce(syncedBody({ config: null }))
    const r = await getProfileForLaunch({ key: 'k', server: 'https://s', id: 'ghost' })
    expect(r).toEqual({ profile: 'work' })
  })

  it('throws when neither id nor name is given', async () => {
    await expect(getProfileForLaunch({ key: 'k', server: 'https://s' })).rejects.toThrow('id or name')
  })

  it('throws on a non-ok response', async () => {
    mockFetchOnce({ error: { message: 'no' } }, 404)
    await expect(getProfileForLaunch({ key: 'k', server: 'https://s', id: 'x' })).rejects.toThrow('HTTP 404')
  })

  it('builds the URL from name when no id is given', async () => {
    const fn = mockFetchOnce(syncedBody({}))
    await getProfileForLaunch({ key: 'k', server: 'https://s', name: 'work' })
    expect(String(fn.mock.calls[0][0])).toBe('https://s/api/v1/profiles/work')
  })

  it('url-encodes an identifier with special characters', async () => {
    const fn = mockFetchOnce(syncedBody({}))
    await getProfileForLaunch({ key: 'k', server: 'https://s', name: 'my profile/1' })
    expect(String(fn.mock.calls[0][0])).toBe('https://s/api/v1/profiles/my%20profile%2F1')
  })
})

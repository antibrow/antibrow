import { describe, it, expect, vi, afterEach } from 'vitest'
import { createUserProxy, updateUserProxy, deleteUserProxy, syncPullUserProxies, proxyConfigToUrl } from '../src/api'
import type { ProxyConfig, SyncedProxy } from '../src/types'

const cfg: ProxyConfig = { type: 'SOCKS5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' }
const synced: SyncedProxy = { id: 'px-1', config: cfg, createdAt: 'c', updatedAt: 'u', deletedAt: null }

function mockFetchOnce(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}
afterEach(() => { vi.unstubAllGlobals() })

describe('proxyConfigToUrl', () => {
  it('builds a socks5 url with encoded creds', () => {
    expect(proxyConfigToUrl(cfg)).toBe('socks5://u:p@1.2.3.4:1080')
  })
  it('maps HTTP/SSH schemes and omits auth when no username', () => {
    expect(proxyConfigToUrl({ type: 'HTTP', host: 'h', port: 80 })).toBe('http://h:80')
    expect(proxyConfigToUrl({ type: 'SSH', host: 'h', port: 22 })).toBe('ssh://h:22')
  })
  it('encodes special characters in creds', () => {
    expect(proxyConfigToUrl({ type: 'HTTP', host: 'h', port: 8080, username: 'a@b', password: 'p:w@rd' })).toBe('http://a%40b:p%3Aw%40rd@h:8080')
  })
})

describe('createUserProxy', () => {
  it('POSTs id + config to /api/v1/proxy-library and returns SyncedProxy', async () => {
    const fn = mockFetchOnce(synced, 201)
    const r = await createUserProxy({ key: 'k', server: 'https://s', id: 'px-1', config: cfg })
    expect(r.id).toBe('px-1')
    const [u, init] = fn.mock.calls[0]
    expect(String(u)).toBe('https://s/api/v1/proxy-library')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ id: 'px-1', config: cfg })
  })
  it('throws on non-ok', async () => {
    mockFetchOnce({ error: { message: 'x' } }, 409)
    await expect(createUserProxy({ key: 'k', server: 'https://s', config: cfg })).rejects.toThrow('HTTP 409')
  })
})

describe('updateUserProxy / deleteUserProxy', () => {
  it('PUTs to /:id', async () => {
    const fn = mockFetchOnce(synced)
    await updateUserProxy({ key: 'k', server: 'https://s', id: 'px-1', config: cfg })
    const [u, init] = fn.mock.calls[0]
    expect(String(u)).toBe('https://s/api/v1/proxy-library/px-1')
    expect(init.method).toBe('PUT')
  })
  it('DELETEs /:id', async () => {
    const fn = mockFetchOnce({ success: true })
    await deleteUserProxy({ key: 'k', server: 'https://s', id: 'px-1' })
    const [u, init] = fn.mock.calls[0]
    expect(String(u)).toBe('https://s/api/v1/proxy-library/px-1')
    expect(init.method).toBe('DELETE')
  })
})

describe('syncPullUserProxies', () => {
  it('GETs the page and appends ?since=', async () => {
    const fn = mockFetchOnce({ proxies: [synced], serverTime: 't' })
    const page = await syncPullUserProxies({ key: 'k', server: 'https://s', since: '2026-01-01T00:00:00.000Z' })
    expect(page.proxies).toHaveLength(1)
    expect(page.serverTime).toBe('t')
    expect(String(fn.mock.calls[0][0])).toBe('https://s/api/v1/proxy-library?since=2026-01-01T00%3A00%3A00.000Z')
  })
})

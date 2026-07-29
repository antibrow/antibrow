import { describe, it, expect, vi, afterEach } from 'vitest'
import { activateProxy, managedProxyToRelayUrl } from '../src/api'

describe('managedProxyToRelayUrl', () => {
  // A managed proxy is addressed by id through the relay; the upstream
  // residential endpoint is resolved server-side and never reaches the client.
  it('wraps an api key + proxy id into a relay url', () => {
    expect(managedProxyToRelayUrl('adb_key', 'cmpweu32v0001wprcsemxhkm2'))
      .toBe('relay://adb_key:cmpweu32v0001wprcsemxhkm2@proxy.antibrow.com')
  })

  it('honours a custom worker host and url-encodes the credentials', () => {
    expect(managedProxyToRelayUrl('adb/key', 'p:1', 'proxy1.antibrow.com'))
      .toBe('relay://adb%2Fkey:p%3A1@proxy1.antibrow.com')
  })
})

describe('activateProxy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns proxy on allowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ allowed: true, proxy: { id: 'p1', protocol: 'http', status: 'ok' } }),
      { status: 200 },
    )))
    const r = await activateProxy({ key: 'adb_x', server: 'https://s', proxyId: 'p1' })
    expect(r.allowed).toBe(true)
    expect(r.proxy?.id).toBe('p1')
  })

  it('throws a quota error on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ allowed: false, reason: 'quota_exceeded' }),
      { status: 403 },
    )))
    await expect(activateProxy({ key: 'adb_x', server: 'https://s', proxyId: 'p1' }))
      .rejects.toThrow(/quota/i)
  })

  it('throws on 404 not-your-proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ allowed: false, reason: 'not_your_proxy' }),
      { status: 404 },
    )))
    await expect(activateProxy({ key: 'adb_x', server: 'https://s', proxyId: 'p1' }))
      .rejects.toThrow(/not.*belong|not_your_proxy|404/i)
  })
})

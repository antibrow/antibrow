import { describe, it, expect, vi, afterEach } from 'vitest'
import { activateProxy, managedProxyToRelayUrl, issueProxyTicket, revokeProxyTicket } from '../src/api'

describe('managedProxyToRelayUrl', () => {
  // A managed proxy is addressed by id through the relay; the credential is a
  // short-lived ticket, so the account key never reaches the command line.
  it('wraps a proxy id + ticket secret into a relay url', () => {
    expect(managedProxyToRelayUrl('cmpweu32v0001wprcsemxhkm2', 'tkt40chars'))
      .toBe('relay://cmpweu32v0001wprcsemxhkm2:tkt40chars@proxy.antibrow.com')
  })

  it('honours a custom worker host and url-encodes the credentials', () => {
    expect(managedProxyToRelayUrl('p:1', 'tk/t', 'proxy1.antibrow.com'))
      .toBe('relay://p%3A1:tk%2Ft@proxy1.antibrow.com')
  })

  it('never carries an account key', () => {
    expect(managedProxyToRelayUrl('p1', 'tkt')).not.toContain('adb_')
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

describe('issueProxyTicket', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the ticket and posts label + ttl', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ticketId: 't1', username: 'p1', password: 'sec', host: 'proxy.antibrow.com',
      expiresAt: '2026-08-08T00:00:00.000Z',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const t = await issueProxyTicket({
      key: 'adb_x', server: 'https://s', proxyId: 'p1', label: 'shop-01', ttlMinutes: 60,
    })
    expect(t.ticketId).toBe('t1')
    expect(t.password).toBe('sec')

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://s/api/v1/proxies/p1/ticket')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ label: 'shop-01', ttlMinutes: 60 })
  })

  it('omits ttlMinutes from the body when not provided', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ticketId: 't1', username: 'p1', password: 'sec', host: 'proxy.antibrow.com',
      expiresAt: '2026-08-08T00:00:00.000Z',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await issueProxyTicket({ key: 'adb_x', server: 'https://s', proxyId: 'p1', label: 'shop-01' })

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ label: 'shop-01' })
  })

  it('throws a quota error on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    await expect(issueProxyTicket({ key: 'adb_x', server: 'https://s', proxyId: 'p1' }))
      .rejects.toThrow(/quota/i)
  })

  it('throws on 404 not-your-proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'not_your_proxy' }), { status: 404 },
    )))
    await expect(issueProxyTicket({ key: 'adb_x', server: 'https://s', proxyId: 'p1' }))
      .rejects.toThrow(/belong/i)
  })

  // A 404 without that body is a missing route (server not yet updated, or
  // rolled back). Blaming proxy ownership would send debugging the wrong way.
  it('distinguishes a missing endpoint from a missing proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })))
    const err = await issueProxyTicket({ key: 'adb_x', server: 'https://s', proxyId: 'p1' })
      .catch((e: Error) => e)
    expect((err as Error).message).toMatch(/endpoint not found/i)
    expect((err as Error).message).not.toMatch(/belong/i)
  })
})

describe('revokeProxyTicket', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends a DELETE with the ticket id', async () => {
    const fetchMock = vi.fn(async () => new Response('{"revoked":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await revokeProxyTicket({ key: 'adb_x', server: 'https://s', proxyId: 'p1', ticketId: 't1' })
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://s/api/v1/proxies/p1/ticket?ticketId=t1')
    expect(init.method).toBe('DELETE')
  })

  // Revoking is best-effort: the ticket dies on its own, and a failed revoke
  // must never keep a browser from closing.
  it('swallows a server error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(revokeProxyTicket({
      key: 'adb_x', server: 'https://s', proxyId: 'p1', ticketId: 't1',
    })).resolves.toBeUndefined()
  })

  it('swallows a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(revokeProxyTicket({
      key: 'adb_x', server: 'https://s', proxyId: 'p1', ticketId: 't1',
    })).resolves.toBeUndefined()
  })
})

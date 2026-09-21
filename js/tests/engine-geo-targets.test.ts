import { describe, it, expect, afterEach } from 'vitest'
import { geoTargets, parseGeoBody, probeProxyExit, type GeoTarget } from '../src/engine/geoip'

const SERVER_BODY = JSON.stringify({
  ip: '203.0.113.7', country: 'JP', countryCode: 'JP', countryName: 'Japan',
  city: 'Osaka', timezone: 'Asia/Tokyo',
})
const IPAPI_BODY = JSON.stringify({
  status: 'success', query: '203.0.113.7', country: 'Japan',
  countryCode: 'JP', city: 'Osaka', timezone: 'Asia/Tokyo',
})

afterEach(() => { delete process.env.ANTIBROW_GEO_SERVER })

describe('geoTargets', () => {
  it('puts our own endpoint first and ip-api behind it', () => {
    const [own, fallback] = geoTargets()
    expect(own.host).toBe('antibrow.com')
    expect(own.port).toBe(443)
    expect(own.tls).toBe(true)
    expect(own.path).toBe('/api/v1/geo')
    expect(fallback.host).toBe('ip-api.com')
    expect(fallback.port).toBe(80)
    expect(fallback.tls).toBe(false)
  })

  it('honours a self-hosted server url', () => {
    const [own] = geoTargets('https://geo.example.com:8443/base/')
    expect(own.host).toBe('geo.example.com')
    expect(own.port).toBe(8443)
    expect(own.path).toBe('/base/api/v1/geo')
    expect(own.url).toBe('https://geo.example.com:8443/base/api/v1/geo')
  })

  it('reads the env override when no url is passed', () => {
    process.env.ANTIBROW_GEO_SERVER = 'https://staging.example.com'
    expect(geoTargets()[0].host).toBe('staging.example.com')
  })

  it('falls back to ip-api when the server url is unparseable', () => {
    const targets = geoTargets('not a url')
    expect(targets).toHaveLength(1)
    expect(targets[0].host).toBe('ip-api.com')
  })
})

describe('parseGeoBody', () => {
  const own = geoTargets()[0]
  const ipapi = geoTargets()[1]

  it('reads our own endpoint into the same shape as ip-api', () => {
    expect(parseGeoBody(own, SERVER_BODY)).toEqual(parseGeoBody(ipapi, IPAPI_BODY))
  })

  it('takes countryName as the full name and country as the code', () => {
    const geo = parseGeoBody(own, SERVER_BODY)
    expect(geo.country).toBe('Japan')
    expect(geo.countryCode).toBe('JP')
  })

  // The edge answers 200 with nulls when it has no geo for the caller; treating
  // that as success would write a persona with no timezone at all.
  it('rejects our endpoint answering without a timezone', () => {
    const body = JSON.stringify({ ip: '203.0.113.7', country: null, timezone: null })
    expect(() => parseGeoBody(own, body)).toThrow(/timezone/i)
  })

  // An older deployment of our own endpoint answers without one, and no ip
  // switches WebRTC off - which no real browser is.
  it('rejects our endpoint answering without an exit ip', () => {
    const body = JSON.stringify({ country: 'JP', countryCode: 'JP', timezone: 'Asia/Tokyo' })
    expect(() => parseGeoBody(own, body)).toThrow(/exit ip/i)
  })

  it('still rejects an ip-api failure body', () => {
    expect(() => parseGeoBody(ipapi, '{"status":"fail","message":"quota"}')).toThrow(/quota/)
  })
})

describe('probeProxyExit target fallback', () => {
  const seen: string[] = []
  const lookup = (outcome: Record<string, string | Error>) =>
    async (_u: URL, t: GeoTarget) => {
      seen.push(t.host)
      const r = outcome[t.host]
      if (r instanceof Error) throw r
      if (!r) throw new Error(`no stub for ${t.host}`)
      return parseGeoBody(t, r)
    }

  it('stops at our own endpoint when it answers', async () => {
    seen.length = 0
    const res = await probeProxyExit('http://p.example.com:8080', 5000, {
      lookup: lookup({ 'antibrow.com': SERVER_BODY }),
    })
    expect(res.ok).toBe(true)
    expect(res.geo?.timezone).toBe('Asia/Tokyo')
    expect(seen).toEqual(['antibrow.com'])
  })

  it('falls through to ip-api when our own endpoint fails', async () => {
    seen.length = 0
    const res = await probeProxyExit('http://p.example.com:8080', 5000, {
      lookup: lookup({ 'antibrow.com': new Error('502'), 'ip-api.com': IPAPI_BODY }),
    })
    expect(res.ok).toBe(true)
    expect(res.geo?.countryCode).toBe('JP')
    expect(seen).toEqual(['antibrow.com', 'ip-api.com'])
  })

  // The last error is the one worth reporting, not "no stub for ip-api.com".
  it('reports a failure when every target fails', async () => {
    seen.length = 0
    const res = await probeProxyExit('http://p.example.com:8080', 5000, {
      lookup: lookup({ 'antibrow.com': new Error('own down'), 'ip-api.com': new Error('ip-api down') }),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ip-api down')
    expect(seen).toEqual(['antibrow.com', 'ip-api.com'])
  })

  it('keeps rejecting an unsupported scheme before any lookup', async () => {
    seen.length = 0
    const res = await probeProxyExit('ftp://p.example.com', 5000, { lookup: lookup({}) })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unsupported proxy scheme/)
    expect(seen).toEqual([])
  })
})

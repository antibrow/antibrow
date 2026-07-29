import { describe, it, expect, vi, afterEach } from 'vitest'
import { lookupCurrentGeo } from '../src/geo'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockFetch(handler: (url: string) => { ok: boolean; body: string }) {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input)
    const { ok, body } = handler(url)
    return { ok, text: async () => body } as Response
  }) as unknown as typeof fetch
}

describe('lookupCurrentGeo', () => {
  it('uses the server /api/v1/geo when it returns real cf data', async () => {
    mockFetch((url) => url.includes('/api/v1/geo')
      ? { ok: true, body: JSON.stringify({ country: 'JP', timezone: 'Asia/Tokyo' }) }
      : { ok: false, body: '' })
    const geo = await lookupCurrentGeo('http://localhost:4142')
    expect(geo).toMatchObject({ countryCode: 'JP', timezone: 'Asia/Tokyo', locale: 'ja-JP' })
  })

  it('falls back to ip-api.com when the server returns null cf data (local dev)', async () => {
    mockFetch((url) => url.includes('ip-api.com')
      ? { ok: true, body: JSON.stringify({ status: 'success', countryCode: 'DE', timezone: 'Europe/Berlin' }) }
      : { ok: true, body: JSON.stringify({ country: null, timezone: null }) }) // server has no cf locally
    const geo = await lookupCurrentGeo('http://localhost:4142')
    expect(geo).toMatchObject({ countryCode: 'DE', locale: 'de-DE' })
  })

  it('returns null when nothing resolves', async () => {
    mockFetch(() => ({ ok: false, body: '' }))
    expect(await lookupCurrentGeo('http://localhost:4142')).toBeNull()
  })
})

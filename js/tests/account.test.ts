import { describe, it, expect, vi, afterEach } from 'vitest'
import { getAccount } from '../src/api'

afterEach(() => { vi.restoreAllMocks() })

describe('getAccount', () => {
  it('GETs /api/v1/account with the bearer key and returns parsed JSON', async () => {
    const payload = { email: 'a@b.com', plan: 'PRO', expiresAt: null, profileLimit: 100, profileCount: 3, profileRemaining: 97 }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await getAccount({ key: 'k1', server: 'https://example.test' })

    expect(result).toEqual(payload)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toBe('https://example.test/api/v1/account')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k1')
  })

  it('throws on non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(getAccount({ key: 'bad', server: 'https://example.test' })).rejects.toThrow(/HTTP 401/)
  })
})

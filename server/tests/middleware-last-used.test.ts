import { describe, expect, it, vi } from 'vitest'

const update = vi.fn(async () => { throw new Error('db write failed') })

vi.mock('../src/lib/db', () => ({
  getDb: () => ({ apiKey: { update } }),
  releaseDb: async () => {},
}))
vi.mock('../src/lib/api-keys', () => ({
  findActiveKey: async () => ({ id: 'k1', userId: 'u1', lastUsedAt: null }),
}))
vi.mock('../src/lib/plans', () => ({ resolveEntitlement: async () => ({}) }))

const { onRequest } = await import('../src/middleware')

describe('middleware lastUsedAt', () => {
  it('serves the request when the lastUsedAt write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const url = new URL('http://localhost/api/v1/account')
    const request = new Request(url, { headers: { Authorization: 'Bearer ak_test' } })
    const locals = {
      runtime: { env: { DATABASE_URL: 'postgresql://unused@localhost/x', FP_LICENSE_PRIVKEY: 'a'.repeat(64), OEM_PUBLIC_URL: 'https://api.acme.com/' } },
    }
    const res = (await onRequest({ request, url, locals } as never, async () => new Response('ok'))) as Response
    expect(update).toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

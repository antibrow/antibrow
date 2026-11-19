import { describe, expect, it } from 'vitest'
import { generateApiKey, decodeRouteParam, cryptKeyResponse, generateProfileCryptKey, NotFoundError, handleError } from '../../src/core'

describe('core helpers', () => {
  it('generates api keys in the existing format', () => {
    expect(generateApiKey()).toMatch(/^adb_[a-z0-9]{32}$/)
  })

  it('decodes route params and tolerates bad escapes', () => {
    expect(decodeRouteParam('a%40b.com')).toBe('a@b.com')
    expect(decodeRouteParam('100%')).toBe('100%')
  })

  it('reports crypt keys', () => {
    expect(generateProfileCryptKey()).toMatch(/^[0-9a-f]{64}$/)
    expect(cryptKeyResponse(null)).toEqual({ cryptKey: null, reason: 'no_key' })
  })

  it('serializes api errors', async () => {
    const res = handleError(new NotFoundError('gone'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'gone' } })
  })
})

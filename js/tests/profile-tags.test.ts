import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getProfile } from '../src/api'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe('getProfile', () => {
  it('carries tags through when they are an array', async () => {
    fetchMock.mockResolvedValue(ok({
      id: 'p1', name: 'shop-01', config: null, tags: ['us', 'shop'],
      createdAt: 'x', updatedAt: 'x', deletedAt: null,
    }))
    const p = await getProfile({ key: 'k', name: 'shop-01' })
    expect(p.tags).toEqual(['us', 'shop'])
  })

  it('leaves tags undefined when the server omits them', async () => {
    fetchMock.mockResolvedValue(ok({
      id: 'p1', name: 'shop-01', config: null, createdAt: 'x', updatedAt: 'x', deletedAt: null,
    }))
    const p = await getProfile({ key: 'k', name: 'shop-01' })
    expect(p.tags).toBeUndefined()
  })

  it('parses tags when they arrive as a JSON string', async () => {
    fetchMock.mockResolvedValue(ok({
      id: 'p1', name: 'shop-01', config: null, tags: '["us","shop"]',
      createdAt: 'x', updatedAt: 'x', deletedAt: null,
    }))
    const p = await getProfile({ key: 'k', name: 'shop-01' })
    expect(p.tags).toEqual(['us', 'shop'])
  })

  it('yields undefined when tags is a malformed JSON string', async () => {
    fetchMock.mockResolvedValue(ok({
      id: 'p1', name: 'shop-01', config: null, tags: '{bad json}',
      createdAt: 'x', updatedAt: 'x', deletedAt: null,
    }))
    const p = await getProfile({ key: 'k', name: 'shop-01' })
    expect(p.tags).toBeUndefined()
  })

  it('yields undefined when tags is a non-array non-string value', async () => {
    fetchMock.mockResolvedValue(ok({
      id: 'p1', name: 'shop-01', config: null, tags: 42,
      createdAt: 'x', updatedAt: 'x', deletedAt: null,
    }))
    const p = await getProfile({ key: 'k', name: 'shop-01' })
    expect(p.tags).toBeUndefined()
  })
})

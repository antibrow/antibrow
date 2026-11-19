import { describe, expect, it } from 'vitest'
import * as p from '../../src/core/protocol'

const account = {
  id: 'u1', email: 'a@example.com', plan: 'FREE', expiresAt: null, concurrency: 1,
  syncEnabled: false, profileLimit: 0, profileCount: 0, profileRemaining: 0,
}
const token = { token: 'abc.def', exp: 1700086400, mi: 3, sync: true }
const profile = {
  id: 'c1', name: 'shop', config: { tags: ['us'], proxy: { kind: 'local', localProxyId: 'px' }, os: 'windows' },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', deletedAt: null,
}
const proxy = {
  id: 'px', config: { type: 'HTTP', host: 'h', port: 8080 },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null,
}
const config = {
  brand: { name: 'Acme', logoUrl: '', accent: '', links: { website: '', docs: '', upgrade: '', support: '' } },
  kernelManifestUrl: 'https://download.antibrow.com/fp-browser-versions.json',
  appVersionsUrl: '', recipeRegistryUrl: '',
  features: { cloudSync: true, team: false, share: false, managedProxy: false, liveView: false, realDevices: false, emailLogin: false },
}

function without<T extends object>(o: T, k: keyof T): Partial<T> {
  const c = { ...o }
  delete c[k]
  return c
}

describe('protocol schemas', () => {
  it('accept real route outputs', () => {
    expect(p.accountResponse.safeParse(account).success).toBe(true)
    expect(p.engineTokenResponse.safeParse(token).success).toBe(true)
    expect(p.profileResponse.safeParse(profile).success).toBe(true)
    expect(p.profileListResponse.safeParse({ profiles: [profile], serverTime: '2026-01-03T00:00:00.000Z' }).success).toBe(true)
    expect(p.archiveGetResponse.safeParse({ downloadUrl: 'https://s3/x', version: 'e1' }).success).toBe(true)
    expect(p.archivePutResponse.safeParse({ uploadUrl: 'https://s3/x' }).success).toBe(true)
    expect(p.stateGetResponse.safeParse({ downloadUrl: 'https://s3/x' }).success).toBe(true)
    expect(p.statePutResponse.safeParse({ uploadUrl: 'https://s3/x' }).success).toBe(true)
    expect(p.cryptKeyResponse.safeParse({ cryptKey: null, reason: 'no_key' }).success).toBe(true)
    expect(p.proxyLibraryListResponse.safeParse({ proxies: [proxy], serverTime: 'x' }).success).toBe(true)
    expect(p.proxyLibraryItemResponse.safeParse(proxy).success).toBe(true)
    expect(p.configResponse.safeParse(config).success).toBe(true)
    expect(p.errorResponse.safeParse({ error: { code: 'NOT_FOUND', message: 'x' } }).success).toBe(true)
  })

  it('keep extra fields', () => {
    const r = p.accountResponse.parse({ ...account, team: 'x' })
    expect((r as Record<string, unknown>).team).toBe('x')
  })

  it('reject missing fields', () => {
    expect(p.accountResponse.safeParse(without(account, 'concurrency')).success).toBe(false)
    expect(p.engineTokenResponse.safeParse(without(token, 'mi')).success).toBe(false)
    expect(p.profileResponse.safeParse(without(profile, 'name')).success).toBe(false)
    expect(p.profileListResponse.safeParse({ serverTime: 'x' }).success).toBe(false)
    expect(p.configResponse.safeParse(without(config, 'features')).success).toBe(false)
  })
})

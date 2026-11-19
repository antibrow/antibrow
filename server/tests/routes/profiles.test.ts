import { execFileSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '../../src/lib/db'
import { createPlan } from '../../src/lib/plans'
import { createKey } from '../../src/lib/api-keys'
import { protocol } from '../../src/core'
import { call } from './harness'
import { testDatabaseUrl } from '../db-url'

const etags = new Map<string, string>()

vi.mock('../../src/core/s3', async (orig) => {
  const mod = await orig<typeof import('../../src/core/s3')>()
  return {
    ...mod,
    createS3: () => ({
      presignPut: async (key: string) => `https://s3.test/b/${key}?put`,
      presignGet: async (key: string) => `https://s3.test/b/${key}?get`,
      headObject: async (key: string) => (etags.has(key) ? { etag: etags.get(key) } : null),
      deleteObject: vi.fn(async () => {}),
    }),
  }
})

const url = testDatabaseUrl()
const d = url ? describe : describe.skip
const S3_ENV = { S3_ENDPOINT: 'https://s3.test', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }

d('profiles routes', () => {
  const db = getDb({ databaseUrl: url ?? '' })

  beforeEach(() => {
    etags.clear()
    execFileSync('npx', ['prisma', 'migrate', 'reset', '--force'], {
      env: { ...process.env, DATABASE_URL: url, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
      stdio: 'pipe',
    })
  }, 60_000)

  afterAll(() => db.$disconnect())

  const setup = async (maxSyncedProfiles = 20) => {
    const plan = await createPlan(db, { code: 'PRO', name: 'Pro', mi: 5, maxSyncedProfiles })
    const user = await db.user.create({ data: { planId: plan.id, label: 'alice' } })
    return { plan, user, ...(await createKey(db, user.id)) }
  }
  const api = (key: string, path: string, method = 'GET', body?: unknown, env: Record<string, string> = S3_ENV) =>
    call(`/api/v1${path}`, { key, method, body, env })

  it('creates, lists with since, reads, updates and tombstones', async () => {
    const { key } = await setup()
    const created = await api(key, '/profiles', 'POST', { id: 'c1', name: 'one', config: { group: 'g' } })
    expect(created.status).toBe(201)
    expect(protocol.profileResponse.parse(await created.json()).name).toBe('one')

    const list = protocol.profileListResponse.parse(await (await api(key, '/profiles')).json())
    expect(list.profiles).toHaveLength(1)
    const since = list.serverTime

    expect((await api(key, '/profiles', 'POST', { name: 'one' })).status).toBe(409)

    const put = await api(key, '/profiles/c1', 'PUT', { name: 'renamed' })
    expect(protocol.profileResponse.parse(await put.json()).name).toBe('renamed')
    const delta = protocol.profileListResponse.parse(await (await api(key, `/profiles?since=${encodeURIComponent(since)}`)).json())
    expect(delta.profiles.map((p) => p.name)).toEqual(['renamed'])

    const got = await api(key, '/profiles/c1')
    expect(protocol.profileResponse.parse(await got.json()).id).toBe('c1')

    const del = await api(key, '/profiles/c1', 'DELETE')
    expect(((await del.json()) as { success: boolean }).success).toBe(true)
    expect(((await (await api(key, '/profiles/c1', 'DELETE')).json()) as { success: boolean }).success).toBe(true)
    expect(protocol.profileListResponse.parse(await (await api(key, '/profiles')).json()).profiles).toHaveLength(0)
    const tomb = protocol.profileListResponse.parse(await (await api(key, `/profiles?since=${encodeURIComponent(since)}`)).json())
    expect(tomb.profiles[0]?.deletedAt).toBeTruthy()
    expect((await api(key, '/profiles?since=nope')).status).toBe(400)
  })

  it('finds names with @ and spaces', async () => {
    const { key } = await setup()
    await api(key, '/profiles', 'POST', { name: 'a@b.com x' })
    expect((await api(key, `/profiles/${encodeURIComponent('a@b.com x')}`)).status).toBe(200)
    expect((await api(key, `/profiles/${encodeURIComponent('a@b.com x')}/archive`)).status).toBe(200)
  })

  it('shrunk quota keeps existing profiles readable', async () => {
    const { key, plan } = await setup(20)
    for (let i = 0; i < 12; i++) expect((await api(key, '/profiles', 'POST', { name: `p${i}` })).status).toBe(201)
    await db.plan.update({ where: { id: plan.id }, data: { maxSyncedProfiles: 5 } })
    const list = protocol.profileListResponse.parse(await (await api(key, '/profiles')).json())
    expect(list.profiles).toHaveLength(12)
    const arch = protocol.archiveGetResponse.parse(await (await api(key, '/profiles/p0/archive')).json())
    expect(arch.downloadUrl).toContain('profile-archive/')
    const over = await api(key, '/profiles', 'POST', { name: 'p12' })
    expect(over.status).toBe(429)
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED')
  })

  it('a plan without sync is blocked like before', async () => {
    const { key } = await setup(0)
    expect(protocol.profileListResponse.parse(await (await api(key, '/profiles')).json()).profiles).toEqual([])
    expect((await api(key, '/profiles', 'POST', { name: 'x' })).status).toBe(429)
    expect((await api(key, '/profiles/x')).status).toBe(403)
    expect((await api(key, '/profiles/x', 'PUT', { name: 'y' })).status).toBe(403)
    expect((await api(key, '/profiles/x/archive')).status).toBe(403)
    expect((await api(key, '/profiles/x/state', 'POST')).status).toBe(403)
    expect((await api(key, '/proxy-library')).status).toBe(403)
    expect((await api(key, '/proxy-library', 'POST', { config: { type: 'HTTP', host: 'h', port: 1 } })).status).toBe(403)
  })

  it('storage misconfig only breaks archive routes', async () => {
    const { key } = await setup()
    await api(key, '/profiles', 'POST', { name: 'p' }, {})
    for (const [path, method] of [['/profiles/p/archive', 'GET'], ['/profiles/p/archive', 'POST'], ['/profiles/p/state', 'GET'], ['/profiles/p/state', 'POST']]) {
      const res = await api(key, path!, method, undefined, {})
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('STORAGE_UNAVAILABLE')
    }
    expect((await api(key, '/profiles', 'GET', undefined, {})).status).toBe(200)
    expect((await api(key, '/account', 'GET', undefined, {})).status).toBe(200)
    expect((await api(key, '/profiles/p', 'DELETE', undefined, {})).status).toBe(200)
  })

  it('archive GET carries version only when the object exists', async () => {
    const { key, user } = await setup()
    await api(key, '/profiles', 'POST', { name: 'p' })
    const row = await db.profile.findFirstOrThrow({ where: { userId: user.id } })
    const none = protocol.archiveGetResponse.parse(await (await api(key, '/profiles/p/archive')).json())
    expect(none.version).toBeUndefined()
    etags.set(`profile-archive/${row.id}.zip`, 'abc123')
    const some = protocol.archiveGetResponse.parse(await (await api(key, '/profiles/p/archive')).json())
    expect(some.version).toBe('abc123')
    const up = protocol.archivePutResponse.parse(await (await api(key, '/profiles/p/archive', 'POST')).json())
    expect(up.uploadUrl).toContain(row.id)
    const st = protocol.stateGetResponse.parse(await (await api(key, '/profiles/p/state')).json())
    expect(st).toHaveProperty('downloadUrl')
  })

  it('crypt key is generated once and stable, and not gated on sync', async () => {
    const { key, user, plan } = await setup()
    await api(key, '/profiles', 'POST', { name: 'p' })
    const first = protocol.cryptKeyResponse.parse(await (await api(key, '/profiles/p/crypt-key')).json())
    expect((first as { cryptKey: string }).cryptKey).toMatch(/^[0-9a-f]{64}$/)
    await db.plan.update({ where: { id: plan.id }, data: { maxSyncedProfiles: 0 } })
    const second = await (await api(key, '/profiles/p/crypt-key')).json()
    expect(second).toEqual(first)
    expect(user.id).toBeTruthy()
    expect((await api(key, '/profiles/nope/crypt-key')).status).toBe(404)
  })
})

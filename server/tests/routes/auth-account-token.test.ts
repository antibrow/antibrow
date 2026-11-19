import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import nacl from 'tweetnacl'
import { afterAll, vi, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../../src/lib/db'
import { createPlan } from '../../src/lib/plans'
import { createKey, listKeys, revokeKey } from '../../src/lib/api-keys'
import { protocol } from '../../src/core'
import * as dbModule from '../../src/lib/db'
import { call, LICENSE_KEY } from './harness'
import { testDatabaseUrl } from '../db-url'

vi.mock('../../src/lib/db', async (orig) => {
  const mod = await orig<typeof import('../../src/lib/db')>()
  return { ...mod, releaseDb: vi.fn(mod.releaseDb) }
})

const url = testDatabaseUrl()
const d = url ? describe : describe.skip

d('auth, account, engine/token', () => {
  const db = getDb({ databaseUrl: url ?? '' })

  beforeEach(() => {
    execFileSync('npx', ['prisma', 'migrate', 'reset', '--force'], {
      env: { ...process.env, DATABASE_URL: url, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
      stdio: 'pipe',
    })
  }, 60_000)

  afterAll(() => db.$disconnect())

  const proUser = async (planExpiresAt: Date | null = null, label = 'alice@acme.com') => {
    const plan = await createPlan(db, { code: 'PRO', name: 'Pro', mi: 10, maxSyncedProfiles: 20 })
    const user = await db.user.create({ data: { planId: plan.id, planExpiresAt, label } })
    return { user, ...(await createKey(db, user.id)) }
  }

  it('rejects missing and unknown keys with the error envelope', async () => {
    for (const key of [undefined, 'adb_nope']) {
      const res = await call('/api/v1/account', { key })
      expect(res.status).toBe(401)
      const body = protocol.errorResponse.parse(await res.json())
      expect(body.error.code).toBe('UNAUTHORIZED')
    }
  })

  it('disabled user gets 401', async () => {
    const { user, key } = await proUser()
    expect((await call('/api/v1/account', { key })).status).toBe(200)
    await db.user.update({ where: { id: user.id }, data: { disabled: true } })
    expect((await call('/api/v1/account', { key })).status).toBe(401)
    expect((await call('/api/v1/engine/token', { method: 'POST', key })).status).toBe(401)
  })

  it('revoked key gets 401', async () => {
    const { id, key } = await proUser()
    await revokeKey(db, id)
    expect((await call('/api/v1/account', { key })).status).toBe(401)
    expect((await call('/api/v1/engine/token', { method: 'POST', key })).status).toBe(401)
  })

  it('lists keys with the last 4 characters only', async () => {
    const { user, key } = await proUser()
    const [row] = await listKeys(db, user.id)
    expect(row?.last4).toBe(key.slice(-4))
    expect(JSON.stringify(row)).not.toContain(key)
  })

  it('stores only the sha256 of the key', async () => {
    const { id, key } = await proUser()
    const row = await db.apiKey.findUnique({ where: { id } })
    expect(row?.keyHash).toBe(createHash('sha256').update(key).digest('hex'))
    expect(row?.last4).toBe(key.slice(-4))
    expect(JSON.stringify(row)).not.toContain(key)
  })

  it('account matches the protocol schema', async () => {
    const { key, user } = await proUser(new Date(Date.now() + 86_400_000))
    await db.profile.create({ data: { userId: user.id, name: 'p1', tags: '' } })
    const res = await call('/api/v1/account', { key })
    const body = protocol.accountResponse.parse(await res.json())
    expect(body).toMatchObject({
      id: user.id,
      email: 'alice@acme.com',
      plan: 'PRO',
      concurrency: 10,
      syncEnabled: true,
      profileLimit: 20,
      profileCount: 1,
      profileRemaining: 19,
    })
    expect(body.expiresAt).not.toBeNull()
  })

  it('engine/token signs the plan mi', async () => {
    const { key } = await proUser()
    const res = await call('/api/v1/engine/token', { method: 'POST', key })
    const body = protocol.engineTokenResponse.parse(await res.json())
    expect(body).toMatchObject({ mi: 10, sync: true })
    const [payloadB64, sigB64] = body.token.split('.')
    const payload = atob(payloadB64!)
    expect(JSON.parse(payload).mi).toBe(10)
    const { publicKey } = nacl.sign.keyPair.fromSeed(Uint8Array.from(LICENSE_KEY.match(/../g)!.map((h) => parseInt(h, 16))))
    const sig = Uint8Array.from(atob(sigB64!), (c) => c.charCodeAt(0))
    expect(nacl.sign.detached.verify(new TextEncoder().encode(payload), sig, publicKey)).toBe(true)
  })

  it('expired plan falls back to default', async () => {
    const { key } = await proUser(new Date(Date.now() - 1000))
    const tok = protocol.engineTokenResponse.parse(await (await call('/api/v1/engine/token', { method: 'POST', key })).json())
    expect(tok).toMatchObject({ mi: 1, sync: false })
    const acc = protocol.accountResponse.parse(await (await call('/api/v1/account', { key })).json())
    expect(acc).toMatchObject({ plan: 'FREE', concurrency: 1, syncEnabled: false, expiresAt: null })
  })

  it('telemetry needs a key and answers 204', async () => {
    const { key } = await proUser()
    expect((await call('/api/v1/telemetry', { method: 'POST', body: { events: [] } })).status).toBe(401)
    expect((await call('/api/v1/telemetry', { method: 'POST', key, body: { events: [] } })).status).toBe(204)
  })

  it('releases the db client when the route throws', async () => {
    const { key } = await proUser()
    const spy = vi.mocked(dbModule.releaseDb)
    spy.mockClear()
    const res = await call('/api/v1/account', { key, handler: () => { throw new Error('boom') } })
    expect(res.status).toBe(500)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('releases via waitUntil when the response has no body', async () => {
    const { key } = await proUser()
    const spy = vi.mocked(dbModule.releaseDb)
    spy.mockClear()
    const deferred: Promise<unknown>[] = []
    const res = await call('/api/v1/telemetry', { method: 'POST', key, body: { events: [] }, waitUntil: (p) => void deferred.push(p) })
    expect(res.status).toBe(204)
    expect(deferred).toHaveLength(1)
    await Promise.all(deferred)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('releases after the body is read, exactly once', async () => {
    const { key } = await proUser()
    const spy = vi.mocked(dbModule.releaseDb)
    spy.mockClear()
    const res = await call('/api/v1/account', { key })
    await res.text()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('stamps lastUsedAt on first use and not again within the refresh window', async () => {
    const { key, id } = await proUser()
    expect((await db.apiKey.findUnique({ where: { id } }))?.lastUsedAt).toBeNull()
    await call('/api/v1/account', { key })
    const first = (await db.apiKey.findUnique({ where: { id } }))?.lastUsedAt
    expect(first).not.toBeNull()
    await call('/api/v1/account', { key })
    expect((await db.apiKey.findUnique({ where: { id } }))?.lastUsedAt?.getTime()).toBe(first!.getTime())
    await db.apiKey.update({ where: { id }, data: { lastUsedAt: new Date(Date.now() - 10 * 60_000) } })
    await call('/api/v1/account', { key })
    expect((await db.apiKey.findUnique({ where: { id } }))!.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })
})

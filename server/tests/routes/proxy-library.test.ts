import { execFileSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../../src/lib/db'
import { createPlan } from '../../src/lib/plans'
import { createKey } from '../../src/lib/api-keys'
import { protocol } from '../../src/core'
import { call } from './harness'
import { testDatabaseUrl } from '../db-url'

const url = testDatabaseUrl()
const d = url ? describe : describe.skip

d('proxy-library routes', () => {
  const db = getDb({ databaseUrl: url ?? '' })

  beforeEach(() => {
    execFileSync('npx', ['prisma', 'migrate', 'reset', '--force'], {
      env: { ...process.env, DATABASE_URL: url, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
      stdio: 'pipe',
    })
  }, 60_000)

  afterAll(() => db.$disconnect())

  it('creates, lists, updates and tombstones', async () => {
    const plan = await createPlan(db, { code: 'PRO', name: 'Pro', mi: 5, maxSyncedProfiles: 20 })
    const user = await db.user.create({ data: { planId: plan.id } })
    const { key } = await createKey(db, user.id)
    const cfg = { type: 'HTTP', host: 'h.example', port: 8080 }

    const created = await call('/api/v1/proxy-library', { key, method: 'POST', body: { id: 'px1', config: cfg } })
    expect(created.status).toBe(201)
    expect(protocol.proxyLibraryItemResponse.parse(await created.json()).id).toBe('px1')
    expect((await call('/api/v1/proxy-library', { key, method: 'POST', body: { id: 'px1', config: cfg } })).status).toBe(409)

    const list = protocol.proxyLibraryListResponse.parse(await (await call('/api/v1/proxy-library', { key })).json())
    expect(list.proxies).toHaveLength(1)

    const put = await call('/api/v1/proxy-library/px1', { key, method: 'PUT', body: { config: { ...cfg, port: 9090 } } })
    expect(protocol.proxyLibraryItemResponse.parse(await put.json()).config?.port).toBe(9090)

    const del = await call('/api/v1/proxy-library/px1', { key, method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await call('/api/v1/proxy-library/px1', { key, method: 'DELETE' })).status).toBe(404)
    expect(protocol.proxyLibraryListResponse.parse(await (await call('/api/v1/proxy-library', { key })).json()).proxies).toHaveLength(0)
    const delta = protocol.proxyLibraryListResponse.parse(await (await call(`/api/v1/proxy-library?since=${encodeURIComponent(list.serverTime)}`, { key })).json())
    expect(delta.proxies[0]?.deletedAt).toBeTruthy()
  })
})

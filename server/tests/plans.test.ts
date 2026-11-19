import { execFileSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../src/lib/db'
import { createPlan, deletePlan, listPlans, resolveEntitlement, setDefaultPlan } from '../src/lib/plans'
import { testDatabaseUrl } from './db-url'

const url = testDatabaseUrl()
const d = url ? describe : describe.skip

d('plans', () => {
  const db = getDb({ databaseUrl: url ?? '' })

  beforeEach(() => {
    execFileSync('npx', ['prisma', 'migrate', 'reset', '--force'], {
      env: { ...process.env, DATABASE_URL: url, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
      stdio: 'pipe',
    })
  }, 60_000)

  afterAll(() => db.$disconnect())

  const pro = () => createPlan(db, { code: 'PRO', name: 'Pro', mi: 10, maxSyncedProfiles: 20 })
  const userOn = (planId: string, planExpiresAt: Date | null = null) =>
    db.user.create({ data: { planId, planExpiresAt } })

  it('migration seeds builtin FREE default', async () => {
    const rows = await db.plan.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code: 'FREE', isDefault: true, builtin: true, mi: 1, maxSyncedProfiles: 0 })
  })

  it('expired plan falls back to default', async () => {
    const p = await pro()
    const u = await userOn(p.id, new Date(Date.now() - 86_400_000))
    expect(await resolveEntitlement(db, u.id)).toEqual({
      planCode: 'FREE',
      mi: 1,
      sync: false,
      maxSyncedProfiles: 0,
      expiresAt: null,
    })
  })

  it('unexpired plan keeps its values and expiry', async () => {
    const p = await pro()
    const exp = new Date(Date.now() + 86_400_000)
    const u = await userOn(p.id, exp)
    expect(await resolveEntitlement(db, u.id)).toEqual({
      planCode: 'PRO',
      mi: 10,
      sync: true,
      maxSyncedProfiles: 20,
      expiresAt: exp,
    })
  })

  it('rejects reserved and malformed codes', async () => {
    await expect(createPlan(db, { code: 'GRANT', name: 'x', mi: 1, maxSyncedProfiles: 0 })).rejects.toThrow()
    await expect(createPlan(db, { code: 'FREE', name: 'x', mi: 1, maxSyncedProfiles: 0 })).rejects.toThrow()
    await expect(createPlan(db, { code: 'free', name: 'x', mi: 1, maxSyncedProfiles: 0 })).rejects.toThrow()
  })

  it('deletePlan refuses plans in use and builtin plans', async () => {
    const p = await pro()
    await userOn(p.id)
    await expect(deletePlan(db, p.id)).rejects.toMatchObject({ code: 'PLAN_IN_USE', status: 409 })
    const free = await db.plan.findUniqueOrThrow({ where: { code: 'FREE' } })
    await expect(deletePlan(db, free.id)).rejects.toMatchObject({ status: 400 })
  })

  it('deletePlan removes an unused plan', async () => {
    const p = await pro()
    await deletePlan(db, p.id)
    expect(await db.plan.count()).toBe(1)
  })

  it('setDefaultPlan leaves exactly one default', async () => {
    const p = await pro()
    await setDefaultPlan(db, p.id)
    const defaults = (await listPlans(db)).filter((x) => x.isDefault)
    expect(defaults.map((x) => x.code)).toEqual(['PRO'])
  })

  it('listPlans counts users', async () => {
    const p = await pro()
    await userOn(p.id)
    await userOn(p.id)
    const rows = await listPlans(db)
    expect(rows.find((x) => x.code === 'PRO')?.userCount).toBe(2)
    expect(rows.find((x) => x.code === 'FREE')?.userCount).toBe(0)
  })
})

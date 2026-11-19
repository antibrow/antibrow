import type { Plan } from 'prisma-generated'
import type { Db } from './db'
import { BadRequestError, ConflictError, NotFoundError } from '../core/errors'

export type Entitlement = {
  planCode: string
  mi: number
  sync: boolean
  maxSyncedProfiles: number
  expiresAt: Date | null
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/
const RESERVED = new Set(['FREE', 'GRANT'])

function toEntitlement(plan: Plan, expiresAt: Date | null): Entitlement {
  return {
    planCode: plan.code,
    mi: plan.mi,
    sync: plan.maxSyncedProfiles > 0,
    maxSyncedProfiles: plan.maxSyncedProfiles,
    expiresAt,
  }
}

export async function resolveEntitlement(db: Db, userId: string, now: Date = new Date()): Promise<Entitlement> {
  const user = await db.user.findUnique({ where: { id: userId }, include: { plan: true } })
  if (!user) throw new NotFoundError('User not found')
  const expired = user.planExpiresAt !== null && user.planExpiresAt <= now
  if (!expired) return toEntitlement(user.plan, user.planExpiresAt)
  const fallback = await db.plan.findFirst({ where: { isDefault: true } })
  if (!fallback) throw new Error('No default plan configured')
  return toEntitlement(fallback, null)
}

function checkNumbers(mi: number, maxSyncedProfiles: number): void {
  if (!Number.isInteger(mi) || mi < 1) throw new BadRequestError('mi must be an integer >= 1')
  if (!Number.isInteger(maxSyncedProfiles) || maxSyncedProfiles < 0) {
    throw new BadRequestError('maxSyncedProfiles must be an integer >= 0')
  }
}

export async function createPlan(
  db: Db,
  input: { code: string; name: string; mi: number; maxSyncedProfiles: number },
): Promise<Plan> {
  if (!CODE_RE.test(input.code)) throw new BadRequestError('Plan code must match [A-Z][A-Z0-9_]{1,31}')
  if (RESERVED.has(input.code)) throw new BadRequestError(`Plan code ${input.code} is reserved`)
  if (!input.name.trim()) throw new BadRequestError('Plan name is required')
  checkNumbers(input.mi, input.maxSyncedProfiles)
  const clash = await db.plan.findUnique({ where: { code: input.code } })
  if (clash) throw new ConflictError('Plan code already exists')
  return db.plan.create({
    data: { code: input.code, name: input.name.trim(), mi: input.mi, maxSyncedProfiles: input.maxSyncedProfiles },
  })
}

export async function updatePlan(
  db: Db,
  id: string,
  patch: { name?: string; mi?: number; maxSyncedProfiles?: number },
): Promise<Plan> {
  const plan = await db.plan.findUnique({ where: { id } })
  if (!plan) throw new NotFoundError('Plan not found')
  const mi = patch.mi ?? plan.mi
  const max = patch.maxSyncedProfiles ?? plan.maxSyncedProfiles
  checkNumbers(mi, max)
  if (patch.name !== undefined && !patch.name.trim()) throw new BadRequestError('Plan name is required')
  return db.plan.update({
    where: { id },
    data: { name: patch.name?.trim(), mi, maxSyncedProfiles: max },
  })
}

export async function deletePlan(db: Db, id: string): Promise<void> {
  const plan = await db.plan.findUnique({ where: { id }, include: { _count: { select: { users: true } } } })
  if (!plan) throw new NotFoundError('Plan not found')
  if (plan.builtin) throw new BadRequestError('Builtin plan cannot be deleted')
  if (plan.isDefault) throw new BadRequestError('Default plan cannot be deleted')
  if (plan._count.users > 0) throw new ConflictError('Plan still has users', 'PLAN_IN_USE')
  await db.plan.delete({ where: { id } })
}

export async function setDefaultPlan(db: Db, id: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const plan = await tx.plan.findUnique({ where: { id } })
    if (!plan) throw new NotFoundError('Plan not found')
    await tx.plan.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    await tx.plan.update({ where: { id }, data: { isDefault: true } })
  })
}

export async function listPlans(db: Db): Promise<Array<Plan & { userCount: number }>> {
  const rows = await db.plan.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { users: true } } },
  })
  return rows.map(({ _count, ...plan }) => ({ ...plan, userCount: _count.users }))
}

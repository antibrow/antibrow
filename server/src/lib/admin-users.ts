import type { Prisma } from 'prisma-generated'

export const userInclude = {
  plan: { select: { id: true, code: true, name: true } },
  _count: { select: { apiKeys: true } },
} satisfies Prisma.UserInclude

type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>

export function serializeUser(u: UserRow) {
  return {
    id: u.id,
    label: u.label,
    plan: u.plan,
    planExpiresAt: u.planExpiresAt,
    disabled: u.disabled,
    keyCount: u._count.apiKeys,
    createdAt: u.createdAt,
  }
}

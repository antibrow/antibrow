import type { APIRoute } from 'astro'
import { z } from 'zod'
import { BadRequestError, handleError, jsonResponse, NotFoundError } from '../../../../core/errors'
import { createKey } from '../../../../lib/api-keys'
import { adminDb, parseBody } from '../../../../lib/admin-body'
import { serializeUser, userInclude } from '../../../../lib/admin-users'

export const prerender = false

const createSchema = z.object({
  label: z.string().optional(),
  planId: z.string().optional(),
  planExpiresAt: z.string().datetime().nullable().optional(),
})

export const GET: APIRoute = async ({ locals, url }) => {
  try {
    const db = adminDb(locals)
    const query = url.searchParams.get('query')?.trim()
    const planId = url.searchParams.get('planId') || undefined
    const cursor = url.searchParams.get('cursor') || undefined
    const rawLimit = url.searchParams.get('limit')
    const limit = rawLimit === null ? 50 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1) throw new BadRequestError('limit must be a positive integer')
    const take = Math.min(limit, 200)
    const rows = await db.user.findMany({
      where: {
        ...(planId ? { planId } : {}),
        ...(query ? { OR: [{ label: { contains: query, mode: 'insensitive' as const } }, { id: query }] } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: userInclude,
    })
    const page = rows.slice(0, take)
    return jsonResponse({
      users: page.map(serializeUser),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
    })
  } catch (error) {
    return handleError(error)
  }
}

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const db = adminDb(locals)
    const input = await parseBody(request, createSchema)
    const plan = input.planId
      ? await db.plan.findUnique({ where: { id: input.planId } })
      : await db.plan.findFirst({ where: { isDefault: true } })
    if (!plan) throw new NotFoundError('Plan not found')
    const user = await db.user.create({
      data: {
        label: input.label || null,
        planId: plan.id,
        planExpiresAt: input.planExpiresAt ? new Date(input.planExpiresAt) : null,
      },
      include: userInclude,
    })
    const key = await createKey(db, user.id)
    return jsonResponse({ user: { ...serializeUser(user), keyCount: 1 }, key }, 201)
  } catch (error) {
    return handleError(error)
  }
}

import type { APIRoute } from 'astro'
import { z } from 'zod'
import type { Prisma } from 'prisma-generated'
import { handleError, jsonResponse, BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from '../../../../core/errors'
import { toSyncedProxy, serializeProxyConfig, proxyConfigSchema } from '../../../../core/proxy-sync'

export const prerender = false

const createSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  config: proxyConfigSchema,
})

export const GET: APIRoute = async ({ locals, url }) => {
  try {
    const { db, apiKey, entitlement } = locals
    if (!db || !apiKey || !entitlement) throw new UnauthorizedError()
    if (!entitlement.sync) throw new ForbiddenError('Proxy library sync is not enabled for your plan.')

    const sinceParam = url.searchParams.get('since')
    const where: Prisma.UserProxyWhereInput = { userId: apiKey.userId }
    if (sinceParam) {
      const since = new Date(sinceParam)
      if (isNaN(since.getTime())) throw new BadRequestError('Invalid "since" timestamp')
      where.updatedAt = { gt: since }
    } else {
      where.deletedAt = null
    }
    const rows = await db.userProxy.findMany({ where, orderBy: { updatedAt: 'asc' } })
    return jsonResponse({ proxies: rows.map(toSyncedProxy), serverTime: new Date().toISOString() })
  } catch (error) {
    return handleError(error)
  }
}

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const { db, apiKey, entitlement } = locals
    if (!db || !apiKey || !entitlement) throw new UnauthorizedError()
    if (!entitlement.sync) throw new ForbiddenError('Proxy library sync is not enabled for your plan.')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new BadRequestError('Invalid JSON body')
    }
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'Validation failed')

    const proxy = await db.userProxy
      .create({
        data: {
          clientId: parsed.data.id ?? crypto.randomUUID(),
          userId: apiKey.userId,
          config: serializeProxyConfig(parsed.data.config),
        },
      })
      .catch((e: unknown) => {
        if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
          throw new ConflictError(`Proxy with id "${parsed.data.id}" already exists`)
        }
        throw e
      })
    return jsonResponse(toSyncedProxy(proxy), 201)
  } catch (error) {
    return handleError(error)
  }
}

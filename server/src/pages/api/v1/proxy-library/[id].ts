import type { APIRoute } from 'astro'
import { z } from 'zod'
import { handleError, jsonResponse, BadRequestError, NotFoundError, ForbiddenError, UnauthorizedError } from '../../../../core/errors'
import { toSyncedProxy, serializeProxyConfig, proxyConfigSchema } from '../../../../core/proxy-sync'
import type { Db } from '../../../../lib/db'

export const prerender = false

async function findProxy(db: Db, userId: string, ident: string) {
  return (
    (await db.userProxy.findFirst({ where: { userId, clientId: ident, deletedAt: null } })) ??
    (await db.userProxy.findFirst({ where: { userId, id: ident, deletedAt: null } }))
  )
}

const updateSchema = z.object({ config: proxyConfigSchema })

export const PUT: APIRoute = async ({ locals, params, request }) => {
  try {
    const { db, apiKey, entitlement } = locals
    if (!db || !apiKey || !entitlement) throw new UnauthorizedError()
    if (!entitlement.sync) throw new ForbiddenError('Proxy library sync is not enabled for your plan.')
    const ident = params.id
    if (!ident) throw new BadRequestError('Proxy identifier is required')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new BadRequestError('Invalid JSON body')
    }
    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'Validation failed')

    const proxy = await findProxy(db, apiKey.userId, ident)
    if (!proxy) throw new NotFoundError(`Proxy "${ident}" not found`)
    const updated = await db.userProxy.update({
      where: { id: proxy.id },
      data: { config: serializeProxyConfig(parsed.data.config) },
    })
    return jsonResponse(toSyncedProxy(updated))
  } catch (error) {
    return handleError(error)
  }
}

export const DELETE: APIRoute = async ({ locals, params }) => {
  try {
    const { db, apiKey } = locals
    if (!db || !apiKey) throw new UnauthorizedError()
    const ident = params.id
    if (!ident) throw new BadRequestError('Proxy identifier is required')

    const proxy = await findProxy(db, apiKey.userId, ident)
    if (!proxy) throw new NotFoundError(`Proxy "${ident}" not found`)
    const tombstoned = await db.userProxy.update({ where: { id: proxy.id }, data: { deletedAt: new Date() } })
    return jsonResponse({ success: true, deletedAt: tombstoned.deletedAt?.toISOString() ?? null })
  } catch (error) {
    return handleError(error)
  }
}

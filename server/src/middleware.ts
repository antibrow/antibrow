import type { MiddlewareHandler } from 'astro'
import { getConfig } from './core/config'
import { NotFoundError, UnauthorizedError, handleError } from './core/errors'
import { getDb, releaseDb } from './lib/db'
import { findActiveKey } from './lib/api-keys'
import { resolveEntitlement } from './lib/plans'
import { hasAdminSession, requireAdmin } from './lib/admin-auth'

const PUBLIC_V1 = new Set(['config', 'version/check', 'health', 'app-versions', 'geo'])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

type Defer = (p: Promise<unknown>) => void

// On workerd an unawaited $disconnect can be cancelled once the handler returns, so hand it to waitUntil.
async function withRelease(response: Response, release: () => Promise<void>, defer?: Defer): Promise<Response> {
  if (!response.body) {
    if (defer) defer(release())
    else await release()
    return response
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    flush: () => release(),
  })
  response.body.pipeTo(writable).catch(() => release())
  return new Response(readable, response)
}

const LAST_USED_REFRESH_MS = 5 * 60_000

const ADMIN_PUBLIC = new Set(['login', 'logout'])

export const onRequest: MiddlewareHandler = async (context, next) => {
  const { request, url, locals } = context
  const path = url.pathname

  if (path === '/admin' || path.startsWith('/admin/')) {
    try {
      const cfg = getConfig(locals)
      if (!cfg.adminPassword) return new Response('Not found', { status: 404 })
      if (path !== '/admin' && !(await hasAdminSession(request, cfg))) {
        return new Response(null, { status: 302, headers: { Location: '/admin' } })
      }
    } catch (error) {
      return handleError(error)
    }
    return next()
  }
  if (path.startsWith('/api/admin/')) return adminRequest(context, next)

  if (!path.startsWith('/api/')) return next()

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
  }

  const finish = (res: Response): Response => {
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v)
    return res
  }

  const v1 = path.startsWith('/api/v1/') ? path.slice('/api/v1/'.length).replace(/\/$/, '') : null
  if (v1 === null || PUBLIC_V1.has(v1)) return finish(await next())

  let cfg: ReturnType<typeof getConfig>
  try {
    cfg = getConfig(locals)
  } catch (error) {
    return finish(handleError(error))
  }

  const db = getDb(cfg)
  locals.db = db
  const release = () => releaseDb(db)
  const waitUntil = locals.runtime?.ctx?.waitUntil
  const defer: Defer | undefined = waitUntil ? (p) => waitUntil.call(locals.runtime!.ctx, p) : undefined
  let released = false
  const releaseOnce = async () => {
    if (released) return
    released = true
    await release()
  }

  let response: Response
  try {
    const header = request.headers.get('Authorization')
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('Missing API key')
    const record = await findActiveKey(db, header.slice(7))
    if (!record) throw new UnauthorizedError('Invalid API key')
    locals.apiKey = record
    locals.entitlement = await resolveEntitlement(db, record.userId)
    if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
      // Bookkeeping only: a failed write must never fail the request it rides on.
      try {
        await db.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      } catch (error) {
        console.error('lastUsedAt update failed', error)
      }
    }
    response = await next()
  } catch (error) {
    await releaseOnce()
    return finish(handleError(error))
  }
  return finish(await withRelease(response, releaseOnce, defer))
}

// No CORS headers here: cookie-authenticated routes must stay same-origin.
async function adminRequest(
  { request, url, locals }: Parameters<MiddlewareHandler>[0],
  next: Parameters<MiddlewareHandler>[1],
): Promise<Response> {
  let cfg: ReturnType<typeof getConfig>
  try {
    cfg = getConfig(locals)
  } catch (error) {
    return handleError(error)
  }
  const db = getDb(cfg)
  locals.db = db
  const waitUntil = locals.runtime?.ctx?.waitUntil
  const defer: Defer | undefined = waitUntil ? (p) => waitUntil.call(locals.runtime!.ctx, p) : undefined
  let released = false
  const releaseOnce = async () => {
    if (released) return
    released = true
    await releaseDb(db)
  }
  try {
    const name = url.pathname.slice('/api/admin/'.length).replace(/\/$/, '')
    if (ADMIN_PUBLIC.has(name)) {
      if (!cfg.adminPassword) throw new NotFoundError()
    } else {
      await requireAdmin(request, cfg, url)
    }
    locals.admin = true
    return await withRelease(await next(), releaseOnce, defer)
  } catch (error) {
    await releaseOnce()
    return handleError(error)
  }
}

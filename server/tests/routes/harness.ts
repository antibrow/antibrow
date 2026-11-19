import type { APIRoute } from 'astro'
import { onRequest } from '../../src/middleware'
import * as account from '../../src/pages/api/v1/account'
import * as token from '../../src/pages/api/v1/engine/token'
import * as config from '../../src/pages/api/v1/config'
import * as appVersions from '../../src/pages/api/v1/app-versions'
import * as versionCheck from '../../src/pages/api/v1/version/check'
import * as geo from '../../src/pages/api/v1/geo'
import * as telemetry from '../../src/pages/api/v1/telemetry'
import * as profiles from '../../src/pages/api/v1/profiles/index'
import * as profileByName from '../../src/pages/api/v1/profiles/[name]'
import * as profileArchive from '../../src/pages/api/v1/profiles/[name]/archive'
import * as profileState from '../../src/pages/api/v1/profiles/[name]/state'
import * as profileCryptKey from '../../src/pages/api/v1/profiles/[name]/crypt-key'
import * as proxyLibrary from '../../src/pages/api/v1/proxy-library/index'
import * as proxyById from '../../src/pages/api/v1/proxy-library/[id]'
import * as adminLogin from '../../src/pages/api/admin/login'
import * as adminLogout from '../../src/pages/api/admin/logout'
import * as adminPlans from '../../src/pages/api/admin/plans/index'
import * as adminPlan from '../../src/pages/api/admin/plans/[id]'
import * as adminPlanDefault from '../../src/pages/api/admin/plans/[id]/default'
import * as adminUsers from '../../src/pages/api/admin/users/index'
import * as adminUser from '../../src/pages/api/admin/users/[id]'
import * as adminKeys from '../../src/pages/api/admin/users/[id]/keys/index'
import * as adminKey from '../../src/pages/api/admin/users/[id]/keys/[keyId]'
import * as adminReleases from '../../src/pages/api/admin/releases'
import * as adminStatus from '../../src/pages/api/admin/status'

const routes: Record<string, Record<string, unknown>> = {
  '/api/v1/account': account,
  '/api/v1/engine/token': token,
  '/api/v1/config': config,
  '/api/v1/app-versions': appVersions,
  '/api/v1/version/check': versionCheck,
  '/api/v1/geo': geo,
  '/api/v1/telemetry': telemetry,
}

export const LICENSE_KEY = 'a'.repeat(64)

export async function call(
  path: string,
  opts: { method?: string; key?: string; headers?: Record<string, string>; env?: Record<string, string | undefined>; body?: unknown; raw?: string; waitUntil?: (p: Promise<unknown>) => void; handler?: APIRoute } = {},
): Promise<Response> {
  const url = new URL(`http://localhost${path}`)
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`
  const request = new Request(url, { method, headers, body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined) })
  const locals: Record<string, unknown> = {
    runtime: {
      ctx: opts.waitUntil ? { waitUntil: opts.waitUntil } : undefined,
      env: {
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        FP_LICENSE_PRIVKEY: LICENSE_KEY,
        OEM_PUBLIC_URL: 'https://api.acme.com/',
        ...opts.env,
      },
    },
  }
  const handler = opts.handler ?? (routes[url.pathname]?.[method] as APIRoute | undefined) ?? dynamic(url.pathname, method, locals)
  const ctx = { request, url, locals } as never
  return (await onRequest(ctx, async () => (handler ? handler({ request, url, locals } as never) : new Response('nf', { status: 404 })))) as Response
}

const dynamicRoutes: Array<[RegExp, string[], Record<string, unknown>]> = [
  [/^\/api\/v1\/profiles\/([^/]+)\/archive$/, ['name'], profileArchive],
  [/^\/api\/v1\/profiles\/([^/]+)\/state$/, ['name'], profileState],
  [/^\/api\/v1\/profiles\/([^/]+)\/crypt-key$/, ['name'], profileCryptKey],
  [/^\/api\/v1\/profiles\/([^/]+)$/, ['name'], profileByName],
  [/^\/api\/v1\/proxy-library\/([^/]+)$/, ['id'], proxyById],
  [/^\/api\/admin\/plans\/([^/]+)\/default$/, ['id'], adminPlanDefault],
  [/^\/api\/admin\/plans\/([^/]+)$/, ['id'], adminPlan],
  [/^\/api\/admin\/users\/([^/]+)\/keys\/([^/]+)$/, ['id', 'keyId'], adminKey],
  [/^\/api\/admin\/users\/([^/]+)\/keys$/, ['id'], adminKeys],
  [/^\/api\/admin\/users\/([^/]+)$/, ['id'], adminUser],
]

routes['/api/v1/profiles'] = profiles
routes['/api/v1/proxy-library'] = proxyLibrary
routes['/api/admin/login'] = adminLogin
routes['/api/admin/logout'] = adminLogout
routes['/api/admin/plans'] = adminPlans
routes['/api/admin/users'] = adminUsers
routes['/api/admin/releases'] = adminReleases
routes['/api/admin/status'] = adminStatus

function dynamic(path: string, method: string, locals: Record<string, unknown>): APIRoute | undefined {
  for (const [re, names, mod] of dynamicRoutes) {
    const m = path.match(re)
    const fn = mod[method] as APIRoute | undefined
    if (!m || !fn) continue
    const params = Object.fromEntries(names.map((n, i) => [n, m[i + 1]]))
    return (ctx) => fn({ ...ctx, params } as never)
  }
  return undefined
}

import type { APIRoute } from 'astro'
import { jsonResponse } from '../../../core/errors'
import { isHttps, sessionCookie } from '../../../lib/admin-auth'

export const prerender = false

export const POST: APIRoute = async ({ request, url }) => {
  const res = jsonResponse({ ok: true })
  res.headers.append('Set-Cookie', sessionCookie('', isHttps(request, url), 0))
  return res
}

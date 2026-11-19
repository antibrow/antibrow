import type { APIRoute } from 'astro'
import { z } from 'zod'
import { getConfig } from '../../../core/config'
import { handleError, jsonResponse, UnauthorizedError } from '../../../core/errors'
import { isHttps, requireSessionSecret, safeEqual, sessionCookie, signSession } from '../../../lib/admin-auth'
import { parseBody } from '../../../lib/admin-body'

export const prerender = false

export const POST: APIRoute = async ({ locals, request, url }) => {
  try {
    const cfg = getConfig(locals)
    const { password } = await parseBody(request, z.object({ password: z.string() }))
    const secret = requireSessionSecret(cfg)
    if (!cfg.adminPassword || !(await safeEqual(password, cfg.adminPassword))) {
      throw new UnauthorizedError('Wrong password')
    }
    const res = jsonResponse({ ok: true })
    res.headers.append('Set-Cookie', sessionCookie(await signSession(secret, cfg.adminPassword), isHttps(request, url)))
    return res
  } catch (error) {
    return handleError(error)
  }
}

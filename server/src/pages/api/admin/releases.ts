import type { APIRoute } from 'astro'
import { getConfig } from '../../../core/config'
import { z } from 'zod'
import { BadRequestError, handleError, jsonResponse } from '../../../core/errors'
import { assertAdmin, parseBody } from '../../../lib/admin-body'
import { getStore } from '../../../lib/storage'

export const prerender = false

// The desktop opens these links, so anything that is not https (javascript:, file:, http:) is refused at any depth.
function assertHttpsUrls(value: unknown, path = ''): void {
  if (Array.isArray(value)) return value.forEach((v, i) => assertHttpsUrls(v, `${path}[${i}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, v] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key
    if (/url$/i.test(key) && v !== null && v !== '') {
      let ok = false
      try {
        ok = typeof v === 'string' && new URL(v).protocol === 'https:'
      } catch {
        // unparsable falls through to the rejection
      }
      if (!ok) throw new BadRequestError(`${at} must be an https:// URL`)
    }
    assertHttpsUrls(v, at)
  }
}

export const GET: APIRoute = async ({ locals }) => {
  try {
    assertAdmin(locals)
    const text = await getStore(locals).getObjectText(getConfig(locals).appVersionsKey)
    return jsonResponse(text ? JSON.parse(text) : {})
  } catch (error) {
    return handleError(error)
  }
}

export const PUT: APIRoute = async ({ locals, request }) => {
  try {
    assertAdmin(locals)
    const body = await parseBody(request, z.record(z.unknown()))
    assertHttpsUrls(body)
    await getStore(locals).putObject(getConfig(locals).appVersionsKey, JSON.stringify(body), 'application/json', 'no-cache, max-age=0')
    return jsonResponse(body)
  } catch (error) {
    return handleError(error)
  }
}

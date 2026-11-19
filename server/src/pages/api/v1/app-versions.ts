import type { APIRoute } from 'astro'
import { getConfig } from '../../../core/config'
import { handleError, jsonResponse } from '../../../core/errors'
import { readAppVersions } from '../../../lib/app-versions'

export const prerender = false

export const GET: APIRoute = async ({ locals }) => {
  try {
    return jsonResponse(await readAppVersions(getConfig(locals)))
  } catch (error) {
    return handleError(error)
  }
}

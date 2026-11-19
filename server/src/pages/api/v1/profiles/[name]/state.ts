import type { APIRoute } from 'astro'
import { handleError, jsonResponse, BadRequestError, NotFoundError, ForbiddenError, UnauthorizedError } from '../../../../../core/errors'
import { profileStateKey } from '../../../../../core/s3'
import { decodeRouteParam } from '../../../../../core/route-params'
import { findProfileByName } from '../../../../../lib/profile-lookup'
import { getStore } from '../../../../../lib/storage'

export const prerender = false

async function resolve(locals: App.Locals, rawName: string | undefined) {
  const { db, apiKey, entitlement } = locals
  if (!db || !apiKey || !entitlement) throw new UnauthorizedError()
  if (!entitlement.sync) throw new ForbiddenError('Profile state sync is not enabled for your plan.')
  if (!rawName) throw new BadRequestError('Profile name is required')
  const name = decodeRouteParam(rawName)
  const store = getStore(locals)
  const profile = await findProfileByName(db, apiKey.userId, name)
  if (!profile) throw new NotFoundError(`Profile "${name}" not found`)
  return { store, key: profileStateKey(profile.id) }
}

export const POST: APIRoute = async ({ locals, params }) => {
  try {
    const { store, key } = await resolve(locals, params.name)
    return jsonResponse({ uploadUrl: await store.presignPut(key, 600) })
  } catch (error) {
    return handleError(error)
  }
}

export const GET: APIRoute = async ({ locals, params }) => {
  try {
    const { store, key } = await resolve(locals, params.name)
    return jsonResponse({ downloadUrl: await store.presignGet(key, 600) })
  } catch (error) {
    return handleError(error)
  }
}

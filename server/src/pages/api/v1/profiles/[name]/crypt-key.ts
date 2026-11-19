import type { APIRoute } from 'astro'
import { handleError, jsonResponse, BadRequestError, NotFoundError, UnauthorizedError } from '../../../../../core/errors'
import { cryptKeyResponse } from '../../../../../core/profile-crypt'
import { decodeRouteParam } from '../../../../../core/route-params'

export const prerender = false

// Not gated on sync: the key is needed to open data that already exists locally,
// so withholding it from a downgraded user would lock them out of their own profile.
export const GET: APIRoute = async ({ locals, params }) => {
  try {
    const { db, apiKey } = locals
    if (!db || !apiKey) throw new UnauthorizedError()
    if (!params.name) throw new BadRequestError('Profile name is required')
    const name = decodeRouteParam(params.name)
    const profile = await db.profile.findFirst({
      where: { userId: apiKey.userId, name, deletedAt: null },
      select: { id: true, cryptKey: true },
    })
    if (!profile) throw new NotFoundError(`Profile "${name}" not found`)
    return jsonResponse(cryptKeyResponse(profile.cryptKey))
  } catch (error) {
    return handleError(error)
  }
}

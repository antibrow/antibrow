import type { APIRoute } from 'astro'
import { BadRequestError, handleError, jsonResponse, NotFoundError } from '../../../../../../core/errors'
import { revokeKey } from '../../../../../../lib/api-keys'
import { adminDb } from '../../../../../../lib/admin-body'

export const prerender = false

export const DELETE: APIRoute = async ({ locals, params }) => {
  try {
    const db = adminDb(locals)
    if (!params.id || !params.keyId) throw new BadRequestError('User id and key id are required')
    const row = await db.apiKey.findUnique({ where: { id: params.keyId } })
    if (!row || row.userId !== params.id) throw new NotFoundError('API key not found')
    await revokeKey(db, row.id)
    return jsonResponse({ ok: true })
  } catch (error) {
    return handleError(error)
  }
}

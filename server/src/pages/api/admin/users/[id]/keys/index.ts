import type { APIRoute } from 'astro'
import { z } from 'zod'
import { BadRequestError, handleError, jsonResponse, NotFoundError } from '../../../../../../core/errors'
import { createKey, listKeys } from '../../../../../../lib/api-keys'
import { adminDb, parseBody } from '../../../../../../lib/admin-body'

export const prerender = false

async function requireUser(locals: App.Locals, id: string | undefined) {
  const db = adminDb(locals)
  if (!id) throw new BadRequestError('User id is required')
  if (!(await db.user.findUnique({ where: { id } }))) throw new NotFoundError('User not found')
  return { db, id }
}

export const GET: APIRoute = async ({ locals, params }) => {
  try {
    const { db, id } = await requireUser(locals, params.id)
    return jsonResponse({ keys: await listKeys(db, id) })
  } catch (error) {
    return handleError(error)
  }
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const { db, id } = await requireUser(locals, params.id)
    const hasBody = (await request.clone().text()).trim() !== ''
    const body = hasBody ? await parseBody(request, z.object({ name: z.string().optional() })) : {}
    return jsonResponse({ key: await createKey(db, id, body.name?.trim() || undefined) }, 201)
  } catch (error) {
    return handleError(error)
  }
}

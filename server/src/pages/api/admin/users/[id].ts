import type { APIRoute } from 'astro'
import { z } from 'zod'
import { getConfig } from '../../../../core/config'
import { BadRequestError, handleError, jsonResponse, NotFoundError } from '../../../../core/errors'
import { createS3, profileArchiveKey, profileStateKey } from '../../../../core/s3'
import { adminDb, parseBody } from '../../../../lib/admin-body'
import { serializeUser, userInclude } from '../../../../lib/admin-users'

export const prerender = false

const patchSchema = z.object({
  label: z.string().nullable().optional(),
  planId: z.string().optional(),
  planExpiresAt: z.string().datetime().nullable().optional(),
  disabled: z.boolean().optional(),
})

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const db = adminDb(locals)
    if (!params.id) throw new BadRequestError('User id is required')
    const patch = await parseBody(request, patchSchema)
    if (!(await db.user.findUnique({ where: { id: params.id } }))) throw new NotFoundError('User not found')
    if (patch.planId && !(await db.plan.findUnique({ where: { id: patch.planId } }))) throw new NotFoundError('Plan not found')
    const user = await db.user.update({
      where: { id: params.id },
      data: {
        ...(patch.label !== undefined ? { label: patch.label || null } : {}),
        ...(patch.planId ? { planId: patch.planId } : {}),
        ...(patch.planExpiresAt !== undefined ? { planExpiresAt: patch.planExpiresAt ? new Date(patch.planExpiresAt) : null } : {}),
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
      },
      include: userInclude,
    })
    return jsonResponse({ user: serializeUser(user) })
  } catch (error) {
    return handleError(error)
  }
}

// Storage goes first: if it fails the user stays intact and the delete can be retried.
export const DELETE: APIRoute = async ({ locals, params }) => {
  try {
    const db = adminDb(locals)
    if (!params.id) throw new BadRequestError('User id is required')
    if (!(await db.user.findUnique({ where: { id: params.id } }))) throw new NotFoundError('User not found')
    const { s3 } = getConfig(locals)
    if (s3) {
      const store = createS3(s3)
      const profiles = await db.profile.findMany({ where: { userId: params.id }, select: { id: true } })
      for (const p of profiles) {
        await store.deleteObject(profileArchiveKey(p.id))
        await store.deleteObject(profileStateKey(p.id))
      }
    }
    await db.user.delete({ where: { id: params.id } })
    return jsonResponse({ ok: true })
  } catch (error) {
    return handleError(error)
  }
}

import type { APIRoute } from 'astro'
import { z } from 'zod'
import { BadRequestError, handleError, jsonResponse } from '../../../../core/errors'
import { deletePlan, updatePlan } from '../../../../lib/plans'
import { adminDb, parseBody } from '../../../../lib/admin-body'

export const prerender = false

const patchSchema = z.object({
  name: z.string().optional(),
  mi: z.number().optional(),
  maxSyncedProfiles: z.number().optional(),
})

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    if (!params.id) throw new BadRequestError('Plan id is required')
    const plan = await updatePlan(adminDb(locals), params.id, await parseBody(request, patchSchema))
    return jsonResponse({ plan })
  } catch (error) {
    return handleError(error)
  }
}

export const DELETE: APIRoute = async ({ locals, params }) => {
  try {
    if (!params.id) throw new BadRequestError('Plan id is required')
    await deletePlan(adminDb(locals), params.id)
    return jsonResponse({ ok: true })
  } catch (error) {
    return handleError(error)
  }
}

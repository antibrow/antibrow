import type { APIRoute } from 'astro'
import { BadRequestError, handleError, jsonResponse } from '../../../../../core/errors'
import { setDefaultPlan } from '../../../../../lib/plans'
import { adminDb } from '../../../../../lib/admin-body'

export const prerender = false

export const POST: APIRoute = async ({ locals, params }) => {
  try {
    if (!params.id) throw new BadRequestError('Plan id is required')
    await setDefaultPlan(adminDb(locals), params.id)
    return jsonResponse({ ok: true })
  } catch (error) {
    return handleError(error)
  }
}

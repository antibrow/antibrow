import type { APIRoute } from 'astro'
import { z } from 'zod'
import { handleError, jsonResponse } from '../../../../core/errors'
import { createPlan, listPlans } from '../../../../lib/plans'
import { adminDb, parseBody } from '../../../../lib/admin-body'

export const prerender = false

const createSchema = z.object({
  code: z.string(),
  name: z.string(),
  mi: z.number(),
  maxSyncedProfiles: z.number(),
})

export const GET: APIRoute = async ({ locals }) => {
  try {
    return jsonResponse({ plans: await listPlans(adminDb(locals)) })
  } catch (error) {
    return handleError(error)
  }
}

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const plan = await createPlan(adminDb(locals), await parseBody(request, createSchema))
    return jsonResponse({ plan }, 201)
  } catch (error) {
    return handleError(error)
  }
}

import type { APIRoute } from 'astro'
import { handleError, jsonResponse, UnauthorizedError } from '../../../core/errors'

export const prerender = false

export const GET: APIRoute = async ({ locals }) => {
  try {
    const { db, apiKey, entitlement } = locals
    if (!db || !apiKey || !entitlement) throw new UnauthorizedError()
    const profileCount = await db.profile.count({ where: { userId: apiKey.userId, deletedAt: null } })
    return jsonResponse({
      id: apiKey.userId,
      email: apiKey.label ?? '',
      plan: entitlement.planCode,
      expiresAt: entitlement.expiresAt ? entitlement.expiresAt.toISOString() : null,
      concurrency: entitlement.mi,
      syncEnabled: entitlement.sync,
      profileLimit: entitlement.maxSyncedProfiles,
      profileCount,
      profileRemaining: Math.max(0, entitlement.maxSyncedProfiles - profileCount),
    })
  } catch (error) {
    return handleError(error)
  }
}

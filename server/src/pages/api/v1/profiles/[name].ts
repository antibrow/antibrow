import type { APIRoute } from 'astro'
import { z } from 'zod'
import { handleError, jsonResponse, BadRequestError, NotFoundError, ConflictError, ForbiddenError, UnauthorizedError } from '../../../../core/errors'
import { toSyncedProfile, serializeProfileConfig, profileConfigSchema } from '../../../../core/profile-sync'
import { profileArchiveKey, profileStateKey } from '../../../../core/s3'
import { decodeRouteParam } from '../../../../core/route-params'
import { findProfile } from '../../../../lib/profile-lookup'
import { getStore } from '../../../../lib/storage'

export const prerender = false

export const GET: APIRoute = async ({ locals, params }) => {
  try {
    const { db, apiKey, entitlement } = locals
    if (!db || !apiKey || !entitlement) throw new UnauthorizedError()
    if (!entitlement.sync) throw new ForbiddenError('Profile sync is not enabled for your plan.')
    const ident = params.name ? decodeRouteParam(params.name) : undefined
    if (!ident) throw new BadRequestError('Profile identifier is required')

    const profile = await findProfile(db, apiKey.userId, ident)
    if (!profile) throw new NotFoundError(`Profile "${ident}" not found`)
    return jsonResponse(toSyncedProfile(profile))
  } catch (error) {
    return handleError(error)
  }
}

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  tags: z.array(z.string()).optional(),
  config: profileConfigSchema.optional(),
})

export const PUT: APIRoute = async ({ locals, params, request }) => {
  try {
    const { db, apiKey, entitlement } = locals
    if (!db || !apiKey || !entitlement) throw new UnauthorizedError()
    if (!entitlement.sync) throw new ForbiddenError('Profile sync is not enabled for your plan.')
    const ident = params.name ? decodeRouteParam(params.name) : undefined
    if (!ident) throw new BadRequestError('Profile identifier is required')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new BadRequestError('Invalid JSON body')
    }
    const parsed = updateProfileSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'Validation failed')

    const profile = await findProfile(db, apiKey.userId, ident)
    if (!profile) throw new NotFoundError(`Profile "${ident}" not found`)

    if (parsed.data.name && parsed.data.name !== profile.name) {
      const clash = await db.profile.findFirst({
        where: { userId: apiKey.userId, name: parsed.data.name, deletedAt: null, NOT: { id: profile.id } },
      })
      if (clash) throw new ConflictError(`Profile "${parsed.data.name}" already exists`)
    }

    const updated = await db.profile.update({
      where: { id: profile.id },
      data: {
        name: parsed.data.name ?? profile.name,
        tags: parsed.data.tags ? JSON.stringify(parsed.data.tags) : profile.tags,
        config: parsed.data.config ? serializeProfileConfig(parsed.data.config) : profile.config,
      },
    })
    return jsonResponse(toSyncedProfile(updated))
  } catch (error) {
    return handleError(error)
  }
}

export const DELETE: APIRoute = async ({ locals, params }) => {
  try {
    const { db, apiKey } = locals
    if (!db || !apiKey) throw new UnauthorizedError()
    const ident = params.name ? decodeRouteParam(params.name) : undefined
    if (!ident) throw new BadRequestError('Profile identifier is required')

    const profile = await findProfile(db, apiKey.userId, ident)
    if (!profile) {
      // Idempotent for an already tombstoned row, or a client's delete queue never drains.
      const tomb = await findProfile(db, apiKey.userId, ident, true)
      if (tomb) return jsonResponse({ success: true, deletedAt: tomb.deletedAt?.toISOString() ?? null })
      throw new NotFoundError(`Profile "${ident}" not found`)
    }

    const tombstoned = await db.profile.update({ where: { id: profile.id }, data: { deletedAt: new Date() } })

    // Best effort: a missing or unreachable store must not block deletion.
    try {
      const store = getStore(locals)
      await Promise.all([store.deleteObject(profileStateKey(profile.id)), store.deleteObject(profileArchiveKey(profile.id))])
    } catch (err) {
      console.error('[profiles] failed to delete profile objects', err)
    }

    return jsonResponse({ success: true, deletedAt: (tombstoned.deletedAt as Date).toISOString() })
  } catch (error) {
    return handleError(error)
  }
}

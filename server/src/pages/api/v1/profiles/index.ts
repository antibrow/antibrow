import type { APIRoute } from 'astro'
import { z } from 'zod'
import type { Prisma } from 'prisma-generated'
import { handleError, jsonResponse, BadRequestError, ConflictError, QuotaExceededError, UnauthorizedError } from '../../../../core/errors'
import { toSyncedProfile, serializeProfileConfig, profileConfigSchema } from '../../../../core/profile-sync'
import { generateProfileCryptKey } from '../../../../core/profile-crypt'

export const prerender = false

const createProfileSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1, 'Profile name is required').max(100),
  tags: z.array(z.string()).optional(),
  config: profileConfigSchema.optional(),
})

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const { db, apiKey, entitlement } = locals
    if (!db || !apiKey || !entitlement) throw new UnauthorizedError()

    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new BadRequestError('Invalid JSON body')
    }
    const parsed = createProfileSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'Validation failed')
    const { name, tags, id, config } = parsed.data

    // Only cloud-synced profiles are capped; local ones stay unlimited.
    const live = await db.profile.count({ where: { userId: apiKey.userId, deletedAt: null } })
    if (live >= entitlement.maxSyncedProfiles) {
      throw new QuotaExceededError('Cloud-sync profile limit reached for your plan (local profiles stay unlimited).')
    }

    const existing = await db.profile.findFirst({ where: { userId: apiKey.userId, name, deletedAt: null } })
    if (existing) throw new ConflictError(`Profile "${name}" already exists`)

    const profile = await db.profile
      .create({
        data: {
          clientId: id ?? crypto.randomUUID(),
          userId: apiKey.userId,
          name,
          tags: JSON.stringify(tags ?? []),
          config: config ? serializeProfileConfig(config) : null,
          // The kernel binds the key at creation; a row that exists cannot be given one later.
          cryptKey: generateProfileCryptKey(),
        },
      })
      .catch((e: unknown) => {
        if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
          throw new ConflictError(`Profile with id "${id}" already exists`)
        }
        throw e
      })

    return jsonResponse(toSyncedProfile(profile), 201)
  } catch (error) {
    return handleError(error)
  }
}

export const GET: APIRoute = async ({ locals, url }) => {
  try {
    const { db, apiKey, entitlement } = locals
    if (!db || !apiKey || !entitlement) throw new UnauthorizedError()

    // A plan without sync gets an empty page, not 403: shipped clients use this
    // endpoint as their "is this key still valid" check.
    if (!entitlement.sync) return jsonResponse({ profiles: [], serverTime: new Date().toISOString() })

    // With `since`, tombstones are included so clients can apply deletions.
    const sinceParam = url.searchParams.get('since')
    const where: Prisma.ProfileWhereInput = { userId: apiKey.userId }
    if (sinceParam) {
      const since = new Date(sinceParam)
      if (isNaN(since.getTime())) throw new BadRequestError('Invalid "since" timestamp')
      where.updatedAt = { gt: since }
    } else {
      where.deletedAt = null
    }

    const rows = await db.profile.findMany({ where, orderBy: { updatedAt: 'asc' } })
    return jsonResponse({ profiles: rows.map(toSyncedProfile), serverTime: new Date().toISOString() })
  } catch (error) {
    return handleError(error)
  }
}

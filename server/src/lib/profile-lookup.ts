import type { Db } from './db'

/**
 * Resolve a profile by clientId, then primary id (legacy rows whose clientId was
 * never backfilled), then name (oldest clients). Live rows only by default.
 */
export async function findProfile(db: Db, userId: string, ident: string, includeDeleted = false) {
  const deletedFilter = includeDeleted ? {} : { deletedAt: null }
  return (
    (await db.profile.findFirst({ where: { userId, clientId: ident, ...deletedFilter } })) ??
    (await db.profile.findFirst({ where: { userId, id: ident, ...deletedFilter } })) ??
    (await db.profile.findFirst({ where: { userId, name: ident, ...deletedFilter } }))
  )
}

export async function findProfileByName(db: Db, userId: string, name: string) {
  return db.profile.findFirst({ where: { userId, name, deletedAt: null } })
}

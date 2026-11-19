import type { Db } from './db'
import { generateApiKey } from '../core/api-key-format'
import { NotFoundError } from '../core/errors'

/** Only the sha256 is stored; a database dump does not hand out working keys. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The plaintext key is returned here once and never again. */
export async function createKey(db: Db, userId: string, name?: string): Promise<{ id: string; key: string }> {
  const key = generateApiKey()
  const row = await db.apiKey.create({
    data: { keyHash: await hashApiKey(key), last4: key.slice(-4), userId, ...(name ? { name } : {}) },
  })
  return { id: row.id, key }
}

export async function listKeys(db: Db, userId: string) {
  const rows = await db.apiKey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    last4: r.last4,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
  }))
}

export async function revokeKey(db: Db, id: string): Promise<void> {
  const row = await db.apiKey.findUnique({ where: { id } })
  if (!row) throw new NotFoundError('API key not found')
  if (row.revokedAt) return
  await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } })
}

/** Null for unknown or revoked keys and for disabled users, so callers cannot tell them apart. */
export async function findActiveKey(
  db: Db,
  key: string,
): Promise<{ id: string; userId: string; label: string | null; lastUsedAt: Date | null } | null> {
  const row = await db.apiKey.findUnique({ where: { keyHash: await hashApiKey(key) }, include: { user: true } })
  if (!row || row.revokedAt || row.user.disabled) return null
  return { id: row.id, userId: row.userId, label: row.user.label, lastUsedAt: row.lastUsedAt }
}

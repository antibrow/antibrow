import { z } from 'zod'

/** Opaque-to-server profile config carried in the `config` JSON column. */
export const syncedProxyRefSchema = z.union([
  z.object({ kind: z.literal('managed'), managedProxyId: z.string() }),
  z.object({ kind: z.literal('local'), localProxyId: z.string() }),
])

// Every field a client puts in its config must be declared here. Zod strips
// what it does not know, so an omission is not a missing feature - it is the
// server silently deleting the field and handing the erasure back on the next
// pull, which the client then treats as authoritative.
export const profileConfigSchema = z.object({
  // Length bounds on client-supplied free-text fields prevent a client from
  // stuffing multi-MB values into the opaque `config` JSON column.
  group: z.string().max(100).optional(),
  label: z.string().max(100).optional(),
  color: z.string().max(32).optional(),
  note: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  proxy: syncedProxyRefSchema.optional(),
  // Per-profile kernel switches: a synced profile must launch the same way on
  // every machine it lands on.
  canvasNoise: z.boolean().optional(),
  apiLog: z.enum(['off', 'curated', 'all']).optional(),
  webauthnCapture: z.boolean().optional(),
  followExitLanguage: z.boolean().optional(),
  // Fixed when the profile was created. Losing these strips the badge, unpins
  // the kernel, and lets the next launch mint a plain desktop identity over an
  // Android one.
  deviceType: z.enum(['desktop', 'android']).optional(),
  // Desktop OS. A macOS identity only holds up on a Mac, so every machine the
  // profile lands on has to know it before the persona arrives.
  os: z.enum(['windows', 'macos']).optional(),
  // Windows desktop hardware: 'host' answers from this machine's own hardware.
  hardware: z.enum(['host', 'generated']).optional(),
  realFingerprint: z.boolean().optional(),
  // Chrome major only (150/151). Without it a profile pulled onto a machine that
  // has never opened it has no kernel at all: the picker renders blank and the
  // launch silently falls back to the default kernel.
  kernelVersion: z.string().max(16).optional(),
})

export type ProfileConfig = z.infer<typeof profileConfigSchema>

export interface SyncedProfile {
  id: string
  name: string
  config: ProfileConfig | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** Validate + serialize a config to JSON text for storage. Throws on invalid. */
export function serializeProfileConfig(config: ProfileConfig): string {
  return JSON.stringify(profileConfigSchema.parse(config))
}

/** Parse stored JSON text back to a config. Returns null for null/empty/invalid. */
export function parseProfileConfig(text: string | null): ProfileConfig | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const r = profileConfigSchema.safeParse(raw)
  return r.success ? r.data : null
}

/** The subset of a Prisma Profile row this mapper needs. */
export interface ProfileRowLike {
  id: string
  clientId: string | null
  name: string
  config: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

/** Map a DB row to the wire shape clients sync against. */
export function toSyncedProfile(row: ProfileRowLike): SyncedProfile {
  return {
    id: row.clientId ?? row.id,
    name: row.name,
    config: parseProfileConfig(row.config),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  }
}

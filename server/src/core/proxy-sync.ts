import { z } from 'zod'

/** Opaque-to-server proxy config carried in the `config` JSON column. */
export const proxyConfigSchema = z.object({
  type: z.enum(['SOCKS5', 'HTTP', 'SSH', 'RELAY']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(),
  password: z.string().max(255).optional(),
  label: z.string().max(100).optional(),
  country: z.string().max(8).optional(),
  /** Verbatim proxy url, for schemes the fields above cannot hold whole
   *  (`relay://...?key=`). Source of truth when present. */
  url: z.string().max(2048).optional(),
})

export type ProxyConfig = z.infer<typeof proxyConfigSchema>

export interface SyncedProxy {
  id: string
  config: ProxyConfig | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export function serializeProxyConfig(config: ProxyConfig): string {
  return JSON.stringify(proxyConfigSchema.parse(config))
}

export function parseProxyConfig(text: string | null): ProxyConfig | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const r = proxyConfigSchema.safeParse(raw)
  return r.success ? r.data : null
}

export interface ProxyRowLike {
  id: string
  clientId: string | null
  config: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export function toSyncedProxy(row: ProxyRowLike): SyncedProxy {
  return {
    id: row.clientId ?? row.id,
    config: parseProxyConfig(row.config),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  }
}

import { PrismaClient } from 'prisma-generated'
import { PrismaPg } from '@prisma/adapter-pg'
import type { OemConfig } from '../core/config'

export type Db = PrismaClient

const isWorkerd = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'

const nodeClients = new Map<string, Db>()

function normalize(url: string): string {
  return url.replace(/^['"]|['"]$/g, '')
}

function create(url: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: normalize(url) }) })
}

// Node keeps one pooled client per URL. On workerd every client pins WASM memory
// that only $disconnect() frees, so callers get a fresh one and must pass it to
// releaseDb() when the request is done.
export function getDb(cfg: Pick<OemConfig, 'databaseUrl'>): Db {
  if (isWorkerd) return create(cfg.databaseUrl)
  let db = nodeClients.get(cfg.databaseUrl)
  if (!db) {
    db = create(cfg.databaseUrl)
    nodeClients.set(cfg.databaseUrl, db)
  }
  return db
}

export async function releaseDb(db: Db): Promise<void> {
  if (!isWorkerd) return
  await db.$disconnect().catch(() => {})
}

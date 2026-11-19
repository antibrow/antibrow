/// <reference types="astro/client" />

type Runtime = import('@astrojs/cloudflare').Runtime<Record<string, string | undefined>>

declare namespace App {
  interface Locals extends Partial<Runtime> {
    db?: import('./lib/db').Db
    apiKey?: { id: string; userId: string; label: string | null; lastUsedAt: Date | null }
    admin?: boolean
    entitlement?: import('./lib/plans').Entitlement
  }
}

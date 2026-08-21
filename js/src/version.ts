/** Version gate: the client reads a static policy manifest and decides locally. */
export const SDK_VERSION = '2.21.0'

const DEFAULT_MANIFEST_URL = 'https://download.antibrow.com/app-versions.json'

export interface VersionCheckResult {
  status: 'ok' | 'recommended' | 'required'
  current: string
  latest?: string | null
  minSupported?: string | null
  downloadUrl?: string | null
  notes?: string | null
}

interface ManifestEntry {
  latest?: unknown
  minSupported?: unknown
  downloadUrl?: unknown
  notes?: unknown
}

function parseVersion(v: string): number[] {
  return v.trim().replace(/^v/i, '').split('.').map((seg) => parseInt(seg, 10) || 0)
}

/** -1 / 0 / 1. Missing trailing segments count as zero, so 1.2 equals 1.2.0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

/** The manifest keeps a fixed filename, so an update can sit in a CDN edge cache. */
function cacheBustUrl(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** Fails open: anything unreadable resolves to `ok`, so an outage or a broken
 *  manifest never bricks a client. */
export async function checkClientVersion(options: {
  client: string
  version: string
  manifestUrl?: string
  /** Ignored - kept so existing call sites that build `{ ..., server }` still typecheck. */
  server?: string
}): Promise<VersionCheckResult> {
  const { client, version } = options
  const url = cacheBustUrl(options.manifestUrl || DEFAULT_MANIFEST_URL)

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return { status: 'ok', current: version }

    const body = (await res.json()) as { clients?: Record<string, ManifestEntry> }
    const entry = body?.clients?.[client]
    if (!entry || typeof entry.latest !== 'string' || typeof entry.minSupported !== 'string') {
      return { status: 'ok', current: version }
    }

    const { latest, minSupported } = entry
    const status =
      compareVersions(version, minSupported) < 0 ? 'required'
      : compareVersions(version, latest) < 0 ? 'recommended'
      : 'ok'

    return {
      status,
      current: version,
      latest,
      minSupported,
      downloadUrl: typeof entry.downloadUrl === 'string' ? entry.downloadUrl : null,
      notes: typeof entry.notes === 'string' ? entry.notes : null,
    }
  } catch {
    return { status: 'ok', current: version }
  }
}

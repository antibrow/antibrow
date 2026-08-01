import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Tokens are signed server-side; the SDK only fetches and caches them.


const EXPIRY_SAFETY_MARGIN = 300

/** `exp` gates the cache, `mi` is the kernel-enforced concurrency cap. */
export interface LicenseInfo {
  token: string
  exp: number
  mi: number
  sync: boolean
}

/** For the on-disk cache only; the signature is checked by the kernel. */
function parseTokenPayload(token: string): { exp?: number; mi?: number } {
  try {
    const b64 = token.split('.')[0]
    if (!b64) return {}
    const json = Buffer.from(b64, 'base64').toString('utf8')
    const obj = JSON.parse(json) as { exp?: unknown; mi?: unknown }
    return {
      exp: typeof obj.exp === 'number' ? obj.exp : undefined,
      mi: typeof obj.mi === 'number' ? obj.mi : undefined,
    }
  } catch {
    return {}
  }
}

async function responseMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return ''
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } }
    return typeof body.error?.message === 'string' ? body.error.message : text
  } catch {
    return text
  }
}

interface TokenResponse {
  token: string
  exp?: number
  mi?: number
  sync?: boolean
}

/** Fetch a signed license token. The response carries `mi` and `sync`. */
export async function fetchLicenseToken(opts: { key: string; server: string }): Promise<LicenseInfo> {
  const res = await fetch(new URL('/api/v1/engine/token', opts.server).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.key}`, Accept: 'application/json' },
  })
  if (res.status === 401) throw new Error('Authentication failed: invalid API key.')
  if (!res.ok) {
    const message = await responseMessage(res)
    throw new Error(`engine/token failed: HTTP ${res.status}${message ? `. ${message}` : ''}`)
  }
  const body = (await res.json()) as TokenResponse
  if (!body.token) throw new Error('engine/token returned no token')
  const fromPayload = parseTokenPayload(body.token)
  const exp = body.exp ?? fromPayload.exp ?? Math.floor(Date.now() / 1000) + 86400
  const mi = body.mi ?? fromPayload.mi ?? 1
  return { token: body.token, exp, mi, sync: body.sync ?? false }
}


function cacheFilePath(key: string, server: string): string {
  const id = createHash('sha256').update(`${key}|${server}`).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), 'anti-detect-browser', `license-${id}.json`)
}

function readCachedLicense(file: string): LicenseInfo | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const obj = JSON.parse(raw) as Partial<LicenseInfo>
    if (typeof obj.token !== 'string' || typeof obj.exp !== 'number') return null
    return {
      token: obj.token,
      exp: obj.exp,
      mi: typeof obj.mi === 'number' ? obj.mi : 1,
      sync: obj.sync === true,
    }
  } catch {
    return null
  }
}

function writeCachedLicense(file: string, info: LicenseInfo): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(info), 'utf8')
  } catch {
    /* a token that cannot be cached is refetched next launch */
  }
}

function isFresh(info: LicenseInfo): boolean {
  return info.exp - Math.floor(Date.now() / 1000) > EXPIRY_SAFETY_MARGIN
}

/** Cached until it nears expiry, so most launches skip the network. */
export async function getLicenseToken(opts?: {
  key?: string
  server?: string
}): Promise<LicenseInfo> {
  if (!opts?.key || !opts?.server) {
    throw new Error(
      'Cannot obtain license token: key and server are required. All license signing goes through the server (run it locally for development).',
    )
  }
  const file = cacheFilePath(opts.key, opts.server)
  const cached = readCachedLicense(file)
  if (cached && isFresh(cached)) return cached

  const info = await fetchLicenseToken({ key: opts.key, server: opts.server })
  writeCachedLicense(file, info)
  return info
}

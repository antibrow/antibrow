import { ApiError, NotFoundError, UnauthorizedError } from '../core/errors'
import type { OemConfig } from '../core/config'

export const ADMIN_COOKIE = 'oem_admin'
export const SESSION_TTL_SECONDS = 12 * 3600

const enc = new TextEncoder()

async function hmac(key: Uint8Array<ArrayBuffer> | string, message: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? enc.encode(key) : key
  const k = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Both sides are reduced to fixed-length digests under a throwaway key, so neither length nor content leaks through timing.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const [da, db] = await Promise.all([hmac(key, a), hmac(key, b)])
  let diff = 0
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!
  return diff === 0
}

// Bound to the password so rotating it ends every existing session.
async function sessionKey(secret: string, password: string): Promise<string> {
  return toHex(await hmac(secret, `oem-admin-session:${password}`))
}

export async function signSession(secret: string, password: string, now: number = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS
  const sig = toHex(await hmac(await sessionKey(secret, password), `${ADMIN_COOKIE}.${exp}`))
  return `${exp}.${sig}`
}

export async function verifySession(secret: string, password: string, value: string, now: number = Date.now()): Promise<boolean> {
  const [exp, sig, extra] = value.split('.')
  if (!exp || !sig || extra !== undefined || !/^\d+$/.test(exp)) return false
  const expected = toHex(await hmac(await sessionKey(secret, password), `${ADMIN_COOKIE}.${exp}`))
  if (!(await safeEqual(sig, expected))) return false
  return Number(exp) * 1000 > now
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export function isHttps(request: Request, url: URL): boolean {
  return url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https'
}

export function sessionCookie(value: string, secure: boolean, maxAge: number = SESSION_TTL_SECONDS): string {
  return `${ADMIN_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

// Cookie-authenticated writes must come from our own origin; Bearer requests never reach this check.
function assertSameOrigin(request: Request, url: URL): void {
  if (request.method === 'GET' || request.method === 'HEAD') return
  const origin = request.headers.get('Origin')
  if (origin) {
    const proto = request.headers.get('x-forwarded-proto')
    if (origin === url.origin || (proto && origin === `${proto}://${url.host}`)) return
    // The Node adapter ignores the Host header for url.origin unless allowedDomains is set, so compare it directly.
    const host = request.headers.get('host')
    try {
      if (host && new URL(origin).host === host) return
    } catch {
      // malformed Origin falls through to the rejection
    }
  } else if (request.headers.get('Sec-Fetch-Site') === 'same-origin') {
    return
  }
  throw new ApiError(403, 'CSRF_REJECTED', 'Cross-origin admin request rejected')
}

/** Throws 404 when the admin surface is disabled, 401 when the request carries no valid credential. */
export async function requireAdmin(request: Request, cfg: OemConfig, url: URL): Promise<void> {
  if (!cfg.adminPassword) throw new NotFoundError()
  const header = request.headers.get('Authorization')
  if (header?.startsWith('Bearer ')) {
    if (cfg.adminToken && (await safeEqual(header.slice(7), cfg.adminToken))) return
    throw new UnauthorizedError('Invalid admin credentials')
  }
  const cookie = readCookie(request.headers.get('Cookie'), ADMIN_COOKIE)
  if (cookie && cfg.sessionSecret && (await verifySession(cfg.sessionSecret, cfg.adminPassword, cookie))) {
    assertSameOrigin(request, url)
    return
  }
  throw new UnauthorizedError('Admin login required')
}

/** Cookie-only check for page loads, where a redirect rather than a 401 is the right answer. */
export async function hasAdminSession(request: Request, cfg: OemConfig): Promise<boolean> {
  const cookie = readCookie(request.headers.get('Cookie'), ADMIN_COOKIE)
  return !!(cookie && cfg.adminPassword && cfg.sessionSecret && (await verifySession(cfg.sessionSecret, cfg.adminPassword, cookie)))
}

export function requireSessionSecret(cfg: OemConfig): string {
  if (!cfg.sessionSecret) {
    throw new ApiError(500, 'SESSION_SECRET_MISSING', 'OEM_SESSION_SECRET must be set to use admin login')
  }
  return cfg.sessionSecret
}

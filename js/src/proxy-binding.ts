import { createHash } from 'node:crypto'
import type { ProxyConfig } from './types'

export type ProxyInput = string | { kind: 'managed'; managedProxyId?: string } | null

export type ProxyBinding =
  | { kind: 'managed'; managedProxyId: string }
  | { kind: 'local'; localProxyId: string }
  | { kind: 'url'; url: string }

export type BindingPlan =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'claim' }
  | { action: 'bindManaged'; managedProxyId: string }
  | { action: 'bindUrl'; url: string }

/**
 * Masks proxy userinfo (`user:pass@`) before a url reaches an Error message -
 * these get thrown out of `profile()` into whatever logs the caller's stack
 * traces, and an unredacted url puts the proxy password there in plaintext.
 * A url with no `@` (no credentials) passes through unchanged.
 */
function redactProxyUrl(url: string): string {
  return url.replace(/^([a-zA-Z][\w+.-]*:\/\/)?[^/@]*@/, (_m, scheme?: string) => `${scheme ?? ''}***@`)
}

/**
 * WHATWG URL drops an explicit default port (443 for https, 80 for http, ...)
 * from `.port` for "special" schemes, even when the caller wrote it out - so a
 * plain `new URL(url)` on `https://h.io:443` reports no port at all. Reparsing
 * under a shimmed non-special scheme (`x-<scheme>://...`) keeps the authority
 * parsing (userinfo/host/port) but skips that default-port drop; the real
 * scheme is tracked separately and restored by the caller.
 */
function parseProxyUrl(url: string): { scheme: string; parsed: URL } {
  const idx = url.indexOf('://')
  if (idx === -1) throw new Error(`Invalid proxy url: ${redactProxyUrl(url)}`)
  const scheme = url.slice(0, idx).toLowerCase()
  let parsed: URL
  try {
    parsed = new URL(`x-${scheme}://${url.slice(idx + 3)}`)
  } catch {
    throw new Error(`Invalid proxy url: ${redactProxyUrl(url)}`)
  }
  if (!parsed.hostname) throw new Error(`Invalid proxy url: ${redactProxyUrl(url)}`)
  return { scheme, parsed }
}

/**
 * Canonical form for "is this the same proxy". Credentials are decoded because
 * a library row round-trips them percent-encoded (`proxyConfigToUrl`) while a
 * caller usually types them raw - comparing the two forms verbatim would report
 * a change that is not one.
 */
export function normalizeProxyUrl(url: string): string {
  const { scheme, parsed } = parseProxyUrl(url)
  const user = parsed.username ? decodeURIComponent(parsed.username) : ''
  const pass = parsed.password ? decodeURIComponent(parsed.password) : ''
  const auth = user ? `${user}${pass ? `:${pass}` : ''}@` : ''
  const port = parsed.port ? `:${parsed.port}` : ''
  return `${scheme}://${auth}${parsed.hostname.toLowerCase()}${port}`
}

const SCHEME_TYPES: Record<string, ProxyConfig['type']> = {
  socks5: 'SOCKS5', socks: 'SOCKS5', http: 'HTTP', https: 'HTTP', ssh: 'SSH',
}

export function proxyUrlToConfig(url: string): ProxyConfig {
  const { scheme, parsed } = parseProxyUrl(url)
  const type = SCHEME_TYPES[scheme]
  if (!type) throw new Error(`Unsupported proxy scheme: ${scheme}`)
  const port = Number(parsed.port)
  if (!port) throw new Error(`Proxy url needs a port: ${redactProxyUrl(url)}`)
  const config: ProxyConfig = { type, host: parsed.hostname.toLowerCase(), port }
  if (parsed.username) config.username = decodeURIComponent(parsed.username)
  if (parsed.password) config.password = decodeURIComponent(parsed.password)
  return config
}

/**
 * Deterministic, so the same endpoint pushed twice collides on the server's
 * unique (userId, clientId) instead of piling up duplicate library rows. The
 * password is deliberately out: rotating it must not orphan the row.
 */
export function proxyLibraryClientId(config: ProxyConfig): string {
  const seed = `${config.type}://${config.username ?? ''}@${config.host}:${config.port}`
  return `sdk-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`
}

export function planBinding(
  current: ProxyBinding | undefined,
  currentUrl: string | undefined,
  input: ProxyInput | undefined,
): BindingPlan {
  if (input === undefined) return { action: 'keep' }
  if (input === null) return current ? { action: 'clear' } : { action: 'keep' }
  if (typeof input === 'string') {
    const next = normalizeProxyUrl(input)
    if (currentUrl && normalizeProxyUrl(currentUrl) === next) return { action: 'keep' }
    return { action: 'bindUrl', url: input }
  }
  if (input.managedProxyId) {
    if (current?.kind === 'managed' && current.managedProxyId === input.managedProxyId) {
      return { action: 'keep' }
    }
    return { action: 'bindManaged', managedProxyId: input.managedProxyId }
  }
  return current?.kind === 'managed' ? { action: 'keep' } : { action: 'claim' }
}

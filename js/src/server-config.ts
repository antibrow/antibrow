import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_SERVER = 'https://antibrow.com'
export const DEFAULT_KERNEL_MANIFEST_URL = 'https://download.antibrow.com/fp-browser-versions.json'
export const DEFAULT_APP_VERSIONS_URL = 'https://download.antibrow.com/app-versions.json'
export const DEFAULT_RECIPE_REGISTRY_URL = 'https://raw.githubusercontent.com/antibrow/recipes/main/registry.json'
export const DEFAULT_LIVEVIEW_RELAY_URL = 'wss://liveview-relay.antibrow.com'
export const SERVER_CONFIG_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000
/** A server without /config would otherwise cost a full timeout on every call. */
export const SERVER_CONFIG_FAILURE_TTL_MS = 2 * 60 * 1000
const recentFailures = new Map<string, number>()

export interface ServerConfig {
  brand: {
    name: string
    logoUrl: string
    accent: string
    links: { website: string; docs: string; upgrade: string; support: string }
  }
  kernelManifestUrl: string
  appVersionsUrl: string
  /** Empty means recipes are off on this server. */
  recipeRegistryUrl: string
  features: {
    cloudSync: boolean
    team: boolean
    share: boolean
    managedProxy: boolean
    liveView: boolean
    realDevices: boolean
    emailLogin: boolean
  }
}

export type ServerFeature = 'managedProxy' | 'liveView' | 'realDevices' | 'recipes'

const FEATURE_LABEL: Record<ServerFeature, string> = {
  managedProxy: 'managed proxies',
  liveView: 'Live View',
  realDevices: 'real-device fingerprints',
  recipes: 'recipes',
}

export class FeatureUnavailableError extends Error {
  readonly feature: string
  constructor(feature: string, message: string) {
    super(message)
    this.name = 'FeatureUnavailableError'
    this.feature = feature
  }
}

/** Explicit value, then `ANTI_DETECT_BROWSER_SERVER`, then the default; no trailing slash. */
export function resolveServer(explicit?: string): string {
  const raw = explicit || process.env.ANTI_DETECT_BROWSER_SERVER || DEFAULT_SERVER
  return raw.replace(/\/+$/, '')
}

export function isDefaultServer(server?: string): boolean {
  return resolveServer(server) === DEFAULT_SERVER
}

function antibrowDefaults(): ServerConfig {
  return {
    brand: {
      name: 'AntiBrow',
      logoUrl: '',
      accent: '',
      links: { website: 'https://antibrow.com', docs: '', upgrade: '', support: '' },
    },
    kernelManifestUrl: DEFAULT_KERNEL_MANIFEST_URL,
    appVersionsUrl: DEFAULT_APP_VERSIONS_URL,
    recipeRegistryUrl: DEFAULT_RECIPE_REGISTRY_URL,
    features: {
      cloudSync: true, team: true, share: true, managedProxy: true, liveView: true, realDevices: true, emailLogin: true,
    },
  }
}

/** For a custom server we could not ask: nothing that would route traffic to our own services. */
function unknownServerDefaults(): ServerConfig {
  return {
    brand: { name: '', logoUrl: '', accent: '', links: { website: '', docs: '', upgrade: '', support: '' } },
    kernelManifestUrl: DEFAULT_KERNEL_MANIFEST_URL,
    appVersionsUrl: DEFAULT_APP_VERSIONS_URL,
    recipeRegistryUrl: '',
    features: {
      cloudSync: true, team: false, share: false, managedProxy: false, liveView: false, realDevices: false, emailLogin: false,
    },
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Error(`server config: ${field} is not a string`)
  return v
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`server config: features.${field} is not a boolean`)
  return v
}

export function parseServerConfig(body: unknown): ServerConfig {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.brand !== 'object' || !b.brand) throw new Error('server config: missing brand')
  if (typeof b.features !== 'object' || !b.features) throw new Error('server config: missing features')
  const brand = b.brand as Record<string, unknown>
  const links = (brand.links ?? {}) as Record<string, unknown>
  const f = b.features as Record<string, unknown>
  return {
    brand: {
      name: str(brand.name, 'brand.name'),
      logoUrl: str(brand.logoUrl ?? '', 'brand.logoUrl'),
      accent: str(brand.accent ?? '', 'brand.accent'),
      links: {
        website: str(links.website ?? '', 'brand.links.website'),
        docs: str(links.docs ?? '', 'brand.links.docs'),
        upgrade: str(links.upgrade ?? '', 'brand.links.upgrade'),
        support: str(links.support ?? '', 'brand.links.support'),
      },
    },
    kernelManifestUrl: str(b.kernelManifestUrl, 'kernelManifestUrl'),
    appVersionsUrl: str(b.appVersionsUrl, 'appVersionsUrl'),
    recipeRegistryUrl: str(b.recipeRegistryUrl, 'recipeRegistryUrl'),
    features: {
      cloudSync: bool(f.cloudSync, 'cloudSync'),
      team: bool(f.team, 'team'),
      share: bool(f.share, 'share'),
      managedProxy: bool(f.managedProxy, 'managedProxy'),
      liveView: bool(f.liveView, 'liveView'),
      realDevices: bool(f.realDevices, 'realDevices'),
      emailLogin: bool(f.emailLogin, 'emailLogin'),
    },
  }
}

export function serverConfigCachePath(server: string, cacheDir?: string): string {
  const dir = cacheDir || path.join(os.homedir(), '.anti-detect-browser')
  const id = createHash('sha256').update(resolveServer(server)).digest('hex').slice(0, 12)
  return path.join(dir, `server-config-${id}.json`)
}

function readCache(file: string): { config: ServerConfig; ageMs: number } | undefined {
  try {
    const config = parseServerConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
    return { config, ageMs: Date.now() - fs.statSync(file).mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * The server's brand, feature switches and manifest locations. Cached for an
 * hour; a failed request reads the cache however old, then falls back to
 * built-in values that never point a custom server's user at our services.
 */
export async function getServerConfig(
  server: string,
  opts?: { cacheDir?: string; force?: boolean },
): Promise<ServerConfig> {
  const base = resolveServer(server)
  const file = serverConfigCachePath(base, opts?.cacheDir)
  const cached = readCache(file)
  if (!opts?.force && cached && cached.ageMs < SERVER_CONFIG_TTL_MS) return cached.config
  const fallback = () => cached?.config ?? (base === DEFAULT_SERVER ? antibrowDefaults() : unknownServerDefaults())
  const failedAt = recentFailures.get(file)
  if (!opts?.force && failedAt !== undefined && Date.now() - failedAt < SERVER_CONFIG_FAILURE_TTL_MS) return fallback()

  try {
    const res = await fetch(`${base}/api/v1/config`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const config = parseServerConfig(await res.json())
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(config))
    } catch { /* a read-only cache dir still gets the fresh answer */ }
    recentFailures.delete(file)
    return config
  } catch {
    recentFailures.set(file, Date.now())
    return fallback()
  }
}

/** Our own server's answer is the built-in one, so asking it would only add a request. */
export async function effectiveServerConfig(server?: string, opts?: { cacheDir?: string }): Promise<ServerConfig> {
  const base = resolveServer(server)
  return base === DEFAULT_SERVER ? antibrowDefaults() : getServerConfig(base, opts)
}

export async function assertServerFeature(
  server: string | undefined,
  feature: ServerFeature,
  opts?: { cacheDir?: string },
): Promise<ServerConfig> {
  const config = await effectiveServerConfig(server, opts)
  const on = feature === 'recipes' ? config.recipeRegistryUrl !== '' : config.features[feature]
  if (!on) {
    throw new FeatureUnavailableError(
      feature,
      `The server ${resolveServer(server)} does not support ${FEATURE_LABEL[feature]}.`,
    )
  }
  return config
}

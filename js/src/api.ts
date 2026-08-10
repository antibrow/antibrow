import type { ProfileConfig, SyncedProfile, ProfileSyncPage, ProxyConfig, SyncedProxy, ProxySyncPage } from './types'
import { encodePathSegment } from './url-path'

const DEFAULT_SERVER = 'https://antibrow.com'

interface ProfileOptions {
  key: string
  server?: string
  name: string
  tags?: string[]
  id?: string
  config?: ProfileConfig
}

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, Accept: 'application/json' }
}

function jsonHeaders(key: string): Record<string, string> {
  return { ...authHeaders(key), 'Content-Type': 'application/json' }
}

export async function createProfile(options: ProfileOptions): Promise<SyncedProfile> {
  const { key, name, tags, id, config } = options
  const server = options.server || DEFAULT_SERVER
  const url = new URL('/api/v1/profiles', server)

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: jsonHeaders(key),
    body: JSON.stringify({ id, name, tags, config }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to create profile: HTTP ${response.status}. ${errorBody}`)
  }

  return await response.json() as SyncedProfile
}

export interface UpdateProfileOptions {
  key: string
  server?: string
  /** clientId (preferred) or name - used as the path identifier. */
  id: string
  name?: string
  tags?: string[]
  config?: ProfileConfig
}

export async function updateProfile(options: UpdateProfileOptions): Promise<SyncedProfile> {
  const { key, id, name, tags, config } = options
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/profiles/${encodePathSegment(id)}`, server)

  const response = await fetch(url.toString(), {
    method: 'PUT',
    headers: jsonHeaders(key),
    body: JSON.stringify({ name, tags, config }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to update profile: HTTP ${response.status}. ${errorBody}`)
  }

  return await response.json() as SyncedProfile
}

export async function getProfile(options: Omit<ProfileOptions, 'tags'>): Promise<SyncedProfile> {
  const { key, name } = options
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/profiles/${encodePathSegment(name)}`, server)

  const response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(key) })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to get profile: HTTP ${response.status}. ${errorBody}`)
  }
  return await response.json() as SyncedProfile
}

export async function getOrCreateProfile(options: ProfileOptions): Promise<SyncedProfile> {
  const { key, name, tags, server, id, config } = options

  try {
    return await getProfile({ key, server, name })
  } catch (error) {
    if (error instanceof Error && error.message.includes('HTTP 404')) {
      try {
        return await createProfile({ key, server, name, tags, id, config })
      } catch (createError) {
        if (createError instanceof Error && createError.message.includes('HTTP 409')) {
          return await getProfile({ key, server, name })
        }
        throw createError
      }
    }
    throw error
  }
}

export async function listServerProfiles(options: { key: string; server?: string }): Promise<SyncedProfile[]> {
  const page = await syncPullProfiles(options)
  return page.profiles
}

export async function syncPullProfiles(options: { key: string; server?: string; since?: string }): Promise<ProfileSyncPage> {
  const { key, since } = options
  const server = options.server || DEFAULT_SERVER
  const url = new URL('/api/v1/profiles', server)
  if (since) url.searchParams.set('since', since)

  const response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(key) })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to pull profiles: HTTP ${response.status}. ${errorBody}`)
  }

  const body = await response.json() as Partial<ProfileSyncPage>
  return { profiles: body.profiles ?? [], serverTime: body.serverTime ?? '' }
}

export async function deleteProfile(options: { key: string; server?: string; id?: string; name?: string }): Promise<void> {
  const { key, id, name } = options
  const ident = id ?? name
  if (!ident) throw new Error('deleteProfile requires an id or name')
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/profiles/${encodePathSegment(ident)}`, server)

  const response = await fetch(url.toString(), { method: 'DELETE', headers: authHeaders(key) })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to delete profile: HTTP ${response.status}. ${errorBody}`)
  }
}

export interface LaunchProfile {
  /** Profile name - pass as LaunchOptions.profile. */
  profile: string
  /** Managed proxy id (LaunchOptions.proxyId). */
  proxyId?: string
  /** Resolved Playwright proxy URL for a local proxy ref (LaunchOptions.proxy). */
  proxy?: string
}

export async function getProfileForLaunch(options: { key: string; server?: string; id?: string; name?: string }): Promise<LaunchProfile> {
  const { key, id, name } = options
  const ident = id ?? name
  if (!ident) throw new Error('getProfileForLaunch requires an id or name')
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/profiles/${encodePathSegment(ident)}`, server)

  const response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(key) })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to fetch profile for launch: HTTP ${response.status}. ${errorBody}`)
  }

  const synced = await response.json() as SyncedProfile
  if (typeof synced.name !== 'string') throw new Error('Invalid profile response: missing "name" field')
  const out: LaunchProfile = { profile: synced.name }
  const c = synced.config
  if (c?.proxy?.kind === 'managed') {
    out.proxyId = c.proxy.managedProxyId
  } else if (c?.proxy?.kind === 'local') {
    const localId = c.proxy.localProxyId
    const page = await syncPullUserProxies({ key, server })
    const found = page.proxies.find((p) => p.id === localId)
    if (found?.config) out.proxy = proxyConfigToUrl(found.config)
  }
  return out
}

function archiveUrl(options: { key: string; server?: string; name: string }): string {
  const server = options.server || DEFAULT_SERVER
  return new URL(`/api/v1/profiles/${encodePathSegment(options.name)}/archive`, server).toString()
}

export async function getProfileArchiveUrls(options: {
  key: string
  server?: string
  name: string
}): Promise<{ downloadUrl?: string; uploadUrl?: string; version?: string }> {
  const url = archiveUrl(options)
  const headers = authHeaders(options.key)
  const [getRes, postRes] = await Promise.all([
    fetch(url, { method: 'GET', headers }),
    fetch(url, { method: 'POST', headers }),
  ])

  const out: { downloadUrl?: string; uploadUrl?: string; version?: string } = {}
  if (getRes.ok) {
    // `version` is absent on servers predating archive generations; the caller
    // then just restores unconditionally, as it always did.
    const body = (await getRes.json()) as { downloadUrl?: string; version?: string }
    out.downloadUrl = body.downloadUrl
    out.version = body.version
  }
  if (postRes.ok) out.uploadUrl = ((await postRes.json()) as { uploadUrl?: string }).uploadUrl
  return out
}

/** Sign an upload slot only. The download side costs the server a HEAD on the
 *  cloud object, so anything that only needs to write (the re-sign after exit,
 *  a promotion to cloud) must not ask for the pair. */
export async function getProfileArchiveUploadUrl(options: {
  key: string
  server?: string
  name: string
}): Promise<string | undefined> {
  const res = await fetch(archiveUrl(options), { method: 'POST', headers: authHeaders(options.key) })
  if (!res.ok) return undefined
  return ((await res.json()) as { uploadUrl?: string }).uploadUrl
}

export interface ProfileStateCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface ProfileStateOrigin {
  origin: string
  localStorage: Array<{ name: string; value: string }>
}

export interface ProfileState {
  cookies: ProfileStateCookie[]
  origins: ProfileStateOrigin[]
  tabs: string[]
  permissions: Record<string, unknown> | null
  serviceWorkers: string | null
}

export async function uploadProfileState(options: {
  key: string
  server?: string
  name: string
  cookies: ProfileStateCookie[]
  origins?: ProfileStateOrigin[]
  tabs?: string[]
  permissions?: Record<string, unknown> | null
  serviceWorkers?: string | null
}): Promise<void> {
  const { key, name, cookies } = options
  const server = options.server || DEFAULT_SERVER
  const apiUrl = new URL(`/api/v1/profiles/${encodePathSegment(name)}/state`, server)
  const apiResponse = await fetch(apiUrl.toString(), { method: 'POST', headers: authHeaders(key) })

  if (!apiResponse.ok) {
    const errorBody = await apiResponse.text().catch(() => '')
    throw new Error(`Failed to get upload URL: HTTP ${apiResponse.status}. ${errorBody}`)
  }

  const { uploadUrl } = await apiResponse.json() as { uploadUrl: string }
  const stateData = JSON.stringify({
    cookies,
    origins: options.origins || [],
    tabs: options.tabs || [],
    permissions: options.permissions || null,
    serviceWorkers: options.serviceWorkers || null,
    updatedAt: new Date().toISOString(),
  })

  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    body: stateData,
    headers: { 'Content-Type': 'application/json' },
  })
  if (!uploadResponse.ok) throw new Error(`Failed to upload state to R2: HTTP ${uploadResponse.status}`)
}

export async function downloadProfileState(options: {
  key: string
  server?: string
  name: string
}): Promise<ProfileState | null> {
  const { key, name } = options
  const server = options.server || DEFAULT_SERVER
  const apiUrl = new URL(`/api/v1/profiles/${encodePathSegment(name)}/state`, server)
  const apiResponse = await fetch(apiUrl.toString(), { method: 'GET', headers: authHeaders(key) })

  if (!apiResponse.ok) {
    if (apiResponse.status === 404) return null
    const errorBody = await apiResponse.text().catch(() => '')
    throw new Error(`Failed to get download URL: HTTP ${apiResponse.status}. ${errorBody}`)
  }

  const { downloadUrl } = await apiResponse.json() as { downloadUrl: string }
  const dataResponse = await fetch(downloadUrl)
  if (dataResponse.status === 404 || dataResponse.status === 403) return null
  if (!dataResponse.ok) throw new Error(`Failed to download state from R2: HTTP ${dataResponse.status}`)
  return await dataResponse.json() as ProfileState
}

/** The upstream endpoint stays server-side; clients see only id/protocol/status. */
export interface ManagedProxy {
  id: string
  protocol: string
  status?: string | null
  displayName?: string
}

export interface ProxyQuota {
  limit: number
  usedThisMonth: number
  remaining: number
  holdCount: number
  holdCap: number
}


/** Default host for managed `relay://` proxies. */
export const DEFAULT_RELAY_HOST = 'proxy.antibrow.com'

/**
 * `relay://<proxyId>:<ticket>@<host>` for `--proxy-server`. The exit endpoint is
 * resolved server-side, and the credential is a short-lived ticket rather than
 * the account key, which would otherwise sit in the process command line.
 */
export function managedProxyToRelayUrl(
  proxyId: string,
  ticketSecret: string,
  host: string = DEFAULT_RELAY_HOST,
): string {
  return `relay://${encodeURIComponent(proxyId)}:${encodeURIComponent(ticketSecret)}@${host}`
}

interface ProxyApiOptions {
  key: string
  server?: string
}

export async function listProxies(
  options: ProxyApiOptions,
): Promise<{ proxies: ManagedProxy[]; quota: ProxyQuota }> {
  const server = options.server || DEFAULT_SERVER
  const url = new URL('/api/v1/proxies', server)
  const response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(options.key) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Failed to list proxies: HTTP ${response.status}. ${body}`)
  }
  return await response.json() as { proxies: ManagedProxy[]; quota: ProxyQuota }
}

async function proxyAction(
  options: ProxyApiOptions,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = options.server || DEFAULT_SERVER
  const url = new URL('/api/v1/proxies', server)
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: jsonHeaders(options.key),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Proxy ${String(body.action)} failed: HTTP ${response.status}. ${text}`)
  }
  return await response.json() as Record<string, unknown>
}

export async function claimManagedProxy(options: ProxyApiOptions): Promise<ManagedProxy> {
  const r = await proxyAction(options, { action: 'claim' })
  return r.proxy as ManagedProxy
}

export async function releaseManagedProxy(options: ProxyApiOptions & { proxyId: string }): Promise<void> {
  await proxyAction(options, { action: 'release', proxyId: options.proxyId })
}

export async function swapManagedProxy(options: ProxyApiOptions & { proxyId: string }): Promise<ManagedProxy> {
  const r = await proxyAction(options, { action: 'swap', proxyId: options.proxyId })
  return r.proxy as ManagedProxy
}

/** Shared by proxy endpoints gated on plan quota (403) and ownership (404). */
function throwIfProxyAccessDenied(response: Response): void {
  if (response.status === 403) {
    throw new Error('Proxy monthly quota exceeded for your plan. Upgrade or stop using another proxy this month.')
  }
  if (response.status === 404) {
    throw new Error('Proxy not found or does not belong to you (not_your_proxy).')
  }
}

export async function activateProxy(
  options: ProxyApiOptions & { proxyId: string },
): Promise<{ allowed: boolean; proxy?: ManagedProxy; quota?: ProxyQuota }> {
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/proxies/${encodeURIComponent(options.proxyId)}/activate`, server)
  const response = await fetch(url.toString(), { method: 'POST', headers: authHeaders(options.key) })
  throwIfProxyAccessDenied(response)
  const data = await response.json().catch(() => ({})) as {
    allowed?: boolean; reason?: string; proxy?: ManagedProxy; quota?: ProxyQuota
  }
  if (!response.ok) throw new Error(`Failed to activate proxy: HTTP ${response.status}`)
  return { allowed: data.allowed ?? true, proxy: data.proxy, quota: data.quota }
}

export interface ProxyTicket {
  ticketId: string
  username: string
  password: string
  host: string
  expiresAt: string
}

export async function issueProxyTicket(
  options: ProxyApiOptions & { proxyId: string; label?: string; ttlMinutes?: number },
): Promise<ProxyTicket> {
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/proxies/${encodeURIComponent(options.proxyId)}/ticket`, server)
  const body: Record<string, unknown> = {}
  if (options.label !== undefined) body.label = options.label
  if (options.ttlMinutes !== undefined) body.ttlMinutes = options.ttlMinutes
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: jsonHeaders(options.key),
    body: JSON.stringify(body),
  })
  // A deployed route answers 404 only with `not_your_proxy`. A bare 404 means
  // the endpoint isn't there at all (server not yet updated, or rolled back), and
  // saying "proxy not found" for that sends whoever debugs it down the wrong path.
  if (response.status === 404) {
    const body = await response.text().catch(() => '')
    if (!body.includes('not_your_proxy')) {
      throw new Error(
        'Proxy ticket endpoint not found (HTTP 404). This server does not support managed proxy tickets - upgrade the server, or pin an older SDK.',
      )
    }
  }
  throwIfProxyAccessDenied(response)
  if (!response.ok) throw new Error(`Failed to issue proxy ticket: HTTP ${response.status}`)
  return await response.json() as ProxyTicket
}

/** Best-effort: a ticket expires on its own, so a failed revoke is never fatal. */
export async function revokeProxyTicket(
  options: ProxyApiOptions & { proxyId: string; ticketId: string },
): Promise<void> {
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/proxies/${encodeURIComponent(options.proxyId)}/ticket`, server)
  url.searchParams.set('ticketId', options.ticketId)
  await fetch(url.toString(), { method: 'DELETE', headers: authHeaders(options.key) })
    .catch(() => undefined)
}

export interface AccountInfo {
  email: string
  plan: string
  expiresAt: string | null
  /** Max simultaneous browser instances (token `mi`). */
  concurrency: number
  /** Whether cloud profile sync is available (paid plans). */
  syncEnabled: boolean
  /** Cloud-sync profile limit (local profiles are unlimited). */
  profileLimit: number
  profileCount: number
  profileRemaining: number
}

export async function getAccount(options: { key: string; server?: string }): Promise<AccountInfo> {
  const server = options.server || DEFAULT_SERVER
  const url = new URL('/api/v1/account', server)
  const response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(options.key) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Failed to get account: HTTP ${response.status}. ${body}`)
  }
  return await response.json() as AccountInfo
}

export function proxyConfigToUrl(c: ProxyConfig): string {
  const scheme = c.type === 'SOCKS5' ? 'socks5' : c.type === 'SSH' ? 'ssh' : 'http'
  const auth = c.username ? `${encodeURIComponent(c.username)}:${encodeURIComponent(c.password ?? '')}@` : ''
  return `${scheme}://${auth}${c.host}:${c.port}`
}

export async function createUserProxy(options: { key: string; server?: string; id?: string; config: ProxyConfig }): Promise<SyncedProxy> {
  const { key, id, config } = options
  const server = options.server || DEFAULT_SERVER
  const url = new URL('/api/v1/proxy-library', server)
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: jsonHeaders(key),
    body: JSON.stringify({ id, config }),
  })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to create proxy: HTTP ${response.status}. ${errorBody}`)
  }
  return await response.json() as SyncedProxy
}

export async function updateUserProxy(options: { key: string; server?: string; id: string; config: ProxyConfig }): Promise<SyncedProxy> {
  const { key, id, config } = options
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/proxy-library/${encodeURIComponent(id)}`, server)
  const response = await fetch(url.toString(), {
    method: 'PUT',
    headers: jsonHeaders(key),
    body: JSON.stringify({ config }),
  })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to update proxy: HTTP ${response.status}. ${errorBody}`)
  }
  return await response.json() as SyncedProxy
}

export async function deleteUserProxy(options: { key: string; server?: string; id: string }): Promise<void> {
  const { key, id } = options
  const server = options.server || DEFAULT_SERVER
  const url = new URL(`/api/v1/proxy-library/${encodeURIComponent(id)}`, server)
  const response = await fetch(url.toString(), { method: 'DELETE', headers: authHeaders(key) })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to delete proxy: HTTP ${response.status}. ${errorBody}`)
  }
}

export async function syncPullUserProxies(options: { key: string; server?: string; since?: string }): Promise<ProxySyncPage> {
  const { key, since } = options
  const server = options.server || DEFAULT_SERVER
  const url = new URL('/api/v1/proxy-library', server)
  if (since) url.searchParams.set('since', since)
  const response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(key) })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Failed to pull proxies: HTTP ${response.status}. ${errorBody}`)
  }
  const body = await response.json() as Partial<ProxySyncPage>
  return { proxies: body.proxies ?? [], serverTime: body.serverTime ?? '' }
}

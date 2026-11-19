import { z } from 'zod'

// Wire shapes of the /api/v1 routes the SDK and desktop client consume. Objects
// are passthrough so a server that adds fields never fails a client-side parse.

const isoDate = z.string()

export const errorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }).passthrough(),
}).passthrough()

export const accountResponse = z.object({
  id: z.string(),
  email: z.string(),
  plan: z.string(),
  expiresAt: isoDate.nullable(),
  concurrency: z.number().int(),
  syncEnabled: z.boolean(),
  profileLimit: z.number().int(),
  profileCount: z.number().int(),
  profileRemaining: z.number().int(),
}).passthrough()

export const engineTokenResponse = z.object({
  token: z.string(),
  exp: z.number().int(),
  mi: z.number().int(),
  sync: z.boolean(),
}).passthrough()

const syncedProxyRef = z.union([
  z.object({ kind: z.literal('managed'), managedProxyId: z.string() }).passthrough(),
  z.object({ kind: z.literal('local'), localProxyId: z.string() }).passthrough(),
])

const profileConfig = z.object({
  group: z.string().optional(),
  label: z.string().optional(),
  color: z.string().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  proxy: syncedProxyRef.optional(),
}).passthrough()

export const profileResponse = z.object({
  id: z.string(),
  name: z.string(),
  config: profileConfig.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deletedAt: isoDate.nullable(),
}).passthrough()

export const profileListResponse = z.object({
  profiles: z.array(profileResponse),
  serverTime: isoDate,
}).passthrough()

export const archiveGetResponse = z.object({
  downloadUrl: z.string(),
  version: z.string().optional(),
}).passthrough()

export const archivePutResponse = z.object({
  uploadUrl: z.string(),
}).passthrough()

export const stateGetResponse = z.object({ downloadUrl: z.string() }).passthrough()
export const statePutResponse = z.object({ uploadUrl: z.string() }).passthrough()

export const cryptKeyResponse = z.union([
  z.object({ cryptKey: z.string() }).passthrough(),
  z.object({ cryptKey: z.null(), reason: z.literal('no_key') }).passthrough(),
])

const proxyConfig = z.object({
  type: z.enum(['SOCKS5', 'HTTP', 'SSH', 'RELAY']),
  host: z.string(),
  port: z.number().int(),
  username: z.string().optional(),
  password: z.string().optional(),
  label: z.string().optional(),
  country: z.string().optional(),
  url: z.string().optional(),
}).passthrough()

export const proxyLibraryItemResponse = z.object({
  id: z.string(),
  config: proxyConfig.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deletedAt: isoDate.nullable(),
}).passthrough()

export const proxyLibraryListResponse = z.object({
  proxies: z.array(proxyLibraryItemResponse),
  serverTime: isoDate,
}).passthrough()

export const configResponse = z.object({
  brand: z.object({
    name: z.string(),
    logoUrl: z.string(),
    accent: z.string(),
    links: z.object({
      website: z.string(),
      docs: z.string(),
      upgrade: z.string(),
      support: z.string(),
    }).passthrough(),
  }).passthrough(),
  kernelManifestUrl: z.string(),
  appVersionsUrl: z.string(),
  recipeRegistryUrl: z.string(),
  features: z.object({
    cloudSync: z.boolean(),
    team: z.boolean(),
    share: z.boolean(),
    managedProxy: z.boolean(),
    liveView: z.boolean(),
    realDevices: z.boolean(),
    emailLogin: z.boolean(),
  }).passthrough(),
}).passthrough()

export type AccountResponse = z.infer<typeof accountResponse>
export type EngineTokenResponse = z.infer<typeof engineTokenResponse>
export type ProfileResponse = z.infer<typeof profileResponse>
export type ProfileListResponse = z.infer<typeof profileListResponse>
export type ArchiveGetResponse = z.infer<typeof archiveGetResponse>
export type ArchivePutResponse = z.infer<typeof archivePutResponse>
export type StateGetResponse = z.infer<typeof stateGetResponse>
export type StatePutResponse = z.infer<typeof statePutResponse>
export type ProxyLibraryItemResponse = z.infer<typeof proxyLibraryItemResponse>
export type ProxyLibraryListResponse = z.infer<typeof proxyLibraryListResponse>
export type ConfigResponse = z.infer<typeof configResponse>
export type ErrorResponse = z.infer<typeof errorResponse>

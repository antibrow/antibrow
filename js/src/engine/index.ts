import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  ensureKernel,
  KERNEL_VERSIONS,
  DEFAULT_KERNEL_VERSION,
  findKernelVersion,
  refreshKernelVersions,
  kernelUpdateStatus,
  type KernelVersion,
} from './downloader'
import { loadOrGeneratePersona, type ApiLogMode } from './persona'
import { lookupProxyGeo, type ProxyGeo } from './geoip'
import { getLicenseToken } from './license'
import { launchKernel, type KernelSession } from './launcher'
import { downloadProfileCache, uploadProfileCache } from './profile-cache'

export { KERNEL_VERSIONS, DEFAULT_KERNEL_VERSION, ensureKernel, isKernelInstalled, findKernelVersion, listInstalledKernels, kernelDirSize, deleteKernel, kernelDir, kernelAvailableOnPlatform, kernelsForPlatform, allKernelVersions, registerKernelVersions, fetchRemoteKernelVersions, refreshKernelVersions, loadCachedKernelVersions, KERNEL_MANIFEST_URL, KERNEL_MANIFEST_TTL_MS, KERNEL_VERSION_CACHE_FILE, currentPlatform, installedKernelBuild, writeInstalledKernelBuild, kernelUpdateStatus, installedKernelUpdates } from './downloader'
export type { KernelVersion, KernelUpdateStatus } from './downloader'
export type { KernelSession as EngineSession } from './launcher'
export { downloadProfileCache, uploadProfileCache, packProfileCache, unpackProfileCache, exportProfileArchive, importProfileArchive, PROFILE_ARCHIVE_EXT } from './profile-cache'
export type { PortableProfileMeta, ImportedProfileMeta } from './profile-cache'
export { generatePersona, loadOrGeneratePersona } from './persona'
export type { Persona, ApiLogMode } from './persona'
export { getLicenseToken, fetchLicenseToken, type LicenseInfo } from './license'
export { lookupProxyGeo as lookupEngineProxyGeo, probeProxyExit, type ProxyGeo, type ProxyProbeResult } from './geoip'

export function defaultCacheDir(): string {
  return path.join(os.homedir(), '.anti-detect-browser')
}

export interface OpenProfileOptions {
  /** API key, exchanged for a license token. */
  key?: string
  /** License server base URL. */
  server?: string
  /** Profile name; also the cache subdirectory. */
  profileName: string
  /** Address-bar label. Defaults to profileName. */
  label?: string
  /** Pre-fetched license token, used instead of requesting a new one. */
  licenseToken?: string
  /** Proxy URL: scheme://user:pass@host:port */
  proxyUrl?: string
  headless?: boolean
  /** Presigned download URL for the profile archive (restores browser state). */
  archiveGetUrl?: string
  /** Prefer `getArchivePutUrl`: a presign rarely outlives a browsing session. */
  archivePutUrl?: string
  /** Resolved after exit; wins over `archivePutUrl`. Undefined skips the upload. */
  getArchivePutUrl?: () => Promise<string | undefined>
  /** Root cache directory. Defaults to ~/.anti-detect-browser */
  cacheDir?: string
  /** Explicit profile directory; takes precedence over cacheDir + profileName. */
  profileDir?: string
  /** For new profiles only; existing ones use their persona's version. */
  kernelVersion?: string
  /** Pull a newer build of this profile's kernel before launching. */
  updateKernelBeforeLaunch?: boolean
  /** Per-profile kernel behaviour. Omitted = kernel defaults. */
  canvasNoise?: boolean
  apiLog?: ApiLogMode
  webauthnCapture?: boolean
  onProgress?: (message: string) => void
  /** `download` runs before launch, `upload` after openProfile has returned. */
  onArchiveSync?: (e: ArchiveSyncEvent) => void
}

export interface ArchiveSyncEvent {
  phase: 'download' | 'upload'
  state: 'start' | 'done' | 'error'
  /** Set when state is 'error'; sync failure never throws. */
  error?: string
}

export interface OpenedProfile extends KernelSession {
  /** Proxy exit geo from this launch; the same lookup that set the timezone. */
  geo?: ProxyGeo
  /** The exit-triggered upload; prefer `onArchiveSync` over polling it. */
  archiveUpload?: Promise<void>
}

/**
 * Restore the archive, load the persona, download the kernel it requires, look
 * up the proxy timezone, launch over CDP, and upload the archive on exit.
 */
export async function openProfile(opts: OpenProfileOptions): Promise<OpenedProfile> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir()
  const profileDir = opts.profileDir ?? path.join(cacheDir, 'profiles', opts.profileName)
  fs.mkdirSync(profileDir, { recursive: true })

  // Restore first: persona.json carries the kernel version read below.
  if (opts.archiveGetUrl) {
    opts.onProgress?.('Restoring profile archive')
    opts.onArchiveSync?.({ phase: 'download', state: 'start' })
    await downloadProfileCache(opts.archiveGetUrl, profileDir).then(
      () => opts.onArchiveSync?.({ phase: 'download', state: 'done' }),
      (e: unknown) => opts.onArchiveSync?.({ phase: 'download', state: 'error', error: errText(e) }),
    )
  }

  // Versions newer than this release exist only in the manifest, so resolve the
  // catalogue first. `updateKernelBeforeLaunch` acts on the published build, so
  // it cannot read a cached one.
  await refreshKernelVersions(cacheDir, { force: opts.updateKernelBeforeLaunch })

  const defaultKv = opts.kernelVersion
    ? findKernelVersion(opts.kernelVersion)
    : DEFAULT_KERNEL_VERSION

  opts.onProgress?.('Loading persona')
  const persona = loadOrGeneratePersona(profileDir, defaultKv.version)

  const kv = findKernelVersion(persona.kernelVersion)

  if (opts.updateKernelBeforeLaunch) {
    const status = kernelUpdateStatus(cacheDir, kv.version)
    if (status?.updateAvailable) {
      opts.onProgress?.(`Updating kernel ${kv.label} to the latest build`)
      await ensureKernel(cacheDir, kv, opts.onProgress, { force: true })
    }
  }

  opts.onProgress?.(`Ensuring kernel ${kv.label}`)
  const exePath = await ensureKernel(cacheDir, kv, opts.onProgress)

  let timezone = persona.timezone
  let publicIp: string | undefined
  let geo: ProxyGeo | null = null
  if (opts.proxyUrl) {
    opts.onProgress?.('Looking up proxy geo')
    geo = await lookupProxyGeo(opts.proxyUrl).catch(() => null)
    if (geo?.timezone) timezone = geo.timezone
    if (geo?.ip) publicIp = geo.ip
  }

  opts.onProgress?.('Obtaining license token')
  const licenseToken =
    opts.licenseToken ?? (await getLicenseToken({ key: opts.key, server: opts.server })).token

  opts.onProgress?.('Launching kernel browser')
  const session: OpenedProfile = await launchKernel({
    exePath,
    profileDir,
    persona,
    timezone,
    publicIp,
    proxyUrl: opts.proxyUrl,
    licenseToken,
    label: opts.label ?? opts.profileName,
    headless: opts.headless,
    canvasNoise: opts.canvasNoise,
    apiLog: opts.apiLog,
    webauthnCapture: opts.webauthnCapture,
    onProgress: opts.onProgress,
  })
  if (geo) session.geo = geo

  // Decided at launch so the hook exists before the browser can exit; the URL
  // is resolved inside it.
  if (opts.getArchivePutUrl || opts.archivePutUrl) {
    session.onExit(() => {
      opts.onArchiveSync?.({ phase: 'upload', state: 'start' })
      session.archiveUpload = uploadArchive(profileDir, opts).then(
        () => opts.onArchiveSync?.({ phase: 'upload', state: 'done' }),
        (e: unknown) => opts.onArchiveSync?.({ phase: 'upload', state: 'error', error: errText(e) }),
      )
    })
  }

  return session
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Presign is fetched here, not carried from launch; a 40x retries once. */
async function uploadArchive(profileDir: string, opts: OpenProfileOptions): Promise<void> {
  const resolve = async (): Promise<string | undefined> =>
    opts.getArchivePutUrl ? await opts.getArchivePutUrl() : opts.archivePutUrl

  const url = await resolve()
  if (!url) throw new Error('No upload URL for the profile archive')
  try {
    await uploadProfileCache(profileDir, url)
  } catch (e) {
    const expired = /HTTP 40[13]/.test(errText(e))
    if (!expired || !opts.getArchivePutUrl) throw e
    const fresh = await opts.getArchivePutUrl()
    if (!fresh) throw e
    await uploadProfileCache(profileDir, fresh)
  }
}

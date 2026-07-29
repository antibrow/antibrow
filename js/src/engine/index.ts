import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  ensureKernel,
  KERNEL_VERSIONS,
  DEFAULT_KERNEL_VERSION,
  findKernelVersion,
  fetchRemoteKernelVersions,
  registerKernelVersions,
  kernelUpdateStatus,
  type KernelVersion,
} from './downloader'
import { loadOrGeneratePersona, type ApiLogMode } from './persona'
import { lookupProxyGeo, type ProxyGeo } from './geoip'
import { getLicenseToken } from './license'
import { launchKernel, type KernelSession } from './launcher'
import { downloadProfileCache, uploadProfileCache } from './profile-cache'

export { KERNEL_VERSIONS, DEFAULT_KERNEL_VERSION, ensureKernel, isKernelInstalled, findKernelVersion, listInstalledKernels, kernelDirSize, deleteKernel, kernelDir, kernelAvailableOnPlatform, kernelsForPlatform, allKernelVersions, registerKernelVersions, fetchRemoteKernelVersions, KERNEL_MANIFEST_URL, currentPlatform, installedKernelBuild, writeInstalledKernelBuild, kernelUpdateStatus, installedKernelUpdates } from './downloader'
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
  /** API key — used to fetch a license token from the server. */
  key?: string
  /** Server base URL — used with key to fetch the license token. */
  server?: string
  /** Profile identity — used as the local cache subdirectory name. */
  profileName: string
  /** Human-friendly window/address label shown by the kernel. Defaults to profileName. */
  label?: string
  /** Pre-fetched license token, used instead of requesting a new one. */
  licenseToken?: string
  /** Proxy URL: scheme://user:pass@host:port */
  proxyUrl?: string
  headless?: boolean
  /** Presigned download URL for the profile archive (restores browser state). */
  archiveGetUrl?: string
  /**
   * Presigned upload URL for the profile archive. Prefer `getArchivePutUrl`: a
   * presign is short-lived and a browsing session routinely outlives it.
   */
  archivePutUrl?: string
  /**
   * Resolve the upload URL after the browser has exited. Takes precedence over
   * `archivePutUrl`; returning undefined skips the upload.
   */
  getArchivePutUrl?: () => Promise<string | undefined>
  /** Root cache directory. Defaults to ~/.anti-detect-browser */
  cacheDir?: string
  /** Explicit profile directory; takes precedence over cacheDir + profileName. */
  profileDir?: string
  /**
   * Kernel version for new profiles. Existing profiles always use the version
   * recorded in their persona.json.
   */
  kernelVersion?: string
  /** Pull a newer build of this profile's kernel before launching. */
  updateKernelBeforeLaunch?: boolean
  /** Per-profile kernel behaviour. Omitted = kernel defaults. */
  canvasNoise?: boolean
  apiLog?: ApiLogMode
  webauthnCapture?: boolean
  onProgress?: (message: string) => void
  /**
   * Archive transfer lifecycle: `download` runs before the browser starts,
   * `upload` after it exits, i.e. after openProfile has already returned.
   */
  onArchiveSync?: (e: ArchiveSyncEvent) => void
}

export interface ArchiveSyncEvent {
  phase: 'download' | 'upload'
  state: 'start' | 'done' | 'error'
  /** Present when state is 'error'. The flow itself never throws on sync failure. */
  error?: string
}

export interface OpenedProfile extends KernelSession {
  /**
   * Exit geo of the proxy this session launched with. Same lookup that decides
   * the browser timezone, so it is fresh for this launch.
   */
  geo?: ProxyGeo
  /**
   * The exit-triggered archive upload, once started. Drive off `onArchiveSync`
   * rather than polling this.
   */
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

  const defaultKv = opts.kernelVersion
    ? findKernelVersion(opts.kernelVersion)
    : DEFAULT_KERNEL_VERSION

  opts.onProgress?.('Loading persona')
  const persona = loadOrGeneratePersona(profileDir, defaultKv.version)

  let kv = findKernelVersion(persona.kernelVersion)

  if (opts.updateKernelBeforeLaunch) {
    try {
      registerKernelVersions(await fetchRemoteKernelVersions())
      kv = findKernelVersion(persona.kernelVersion)
    } catch {
      /* offline: keep the installed build */
    }
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

  // Decided at launch so the exit hook exists before the browser can exit; the
  // URL itself is resolved inside the hook.
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

/**
 * Post-exit archive upload. The presign is fetched here rather than carried from
 * launch, because a session easily outlives it, and a rejected PUT is retried
 * once against a freshly issued URL.
 */
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

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  ensureKernel,
  KERNEL_VERSIONS,
  DEFAULT_KERNEL_VERSION,
  findKernelVersion,
  findKernelVersionStrict,
  refreshKernelVersions,
  kernelUpdateStatus,
  kernelSupportsAndroid,
  ANDROID_MIN_KERNEL_VERSION,
  ANDROID_MIN_KERNEL_BUILD,
  installedKernelBuild,
  type KernelVersion,
} from './downloader'
import { loadOrGeneratePersona, type ApiLogMode, type DeviceType, type PersonaInit } from './persona'
import { fetchRealDevice } from './devices'
import { lookupProxyGeo, type ProxyGeo } from './geoip'
import { getLicenseToken } from './license'
import { launchKernel, type KernelSession } from './launcher'
import {
  downloadProfileCache,
  uploadProfileCache,
  readArchiveVersion,
  writeArchiveVersion,
  clearArchiveVersion,
} from './profile-cache'
import { resolveProfileDir, readProfileMeta } from './profile-dir'

export { KERNEL_VERSIONS, DEFAULT_KERNEL_VERSION, ensureKernel, isKernelInstalled, findKernelVersion, findKernelVersionStrict, listInstalledKernels, kernelDirSize, deleteKernel, kernelDir, kernelAvailableOnPlatform, kernelsForPlatform, allKernelVersions, registerKernelVersions, fetchRemoteKernelVersions, refreshKernelVersions, loadCachedKernelVersions, KERNEL_MANIFEST_URL, KERNEL_MANIFEST_TTL_MS, KERNEL_VERSION_CACHE_FILE, currentPlatform, installedKernelBuild, writeInstalledKernelBuild, kernelUpdateStatus, installedKernelUpdates, kernelSupportsAndroid, kernelVersionAtLeast, ANDROID_MIN_KERNEL_VERSION, ANDROID_MIN_KERNEL_BUILD } from './downloader'
export type { KernelVersion, KernelUpdateStatus } from './downloader'
export type { KernelSession as EngineSession } from './launcher'
export { downloadProfileCache, uploadProfileCache, packProfileCache, unpackProfileCache, exportProfileArchive, importProfileArchive, PROFILE_ARCHIVE_EXT, ARCHIVE_VERSION_FILE, readArchiveVersion, writeArchiveVersion, clearArchiveVersion, normalizeArchiveVersion } from './profile-cache'
export type { PortableProfileMeta, ImportedProfileMeta } from './profile-cache'
export { generatePersona, loadOrGeneratePersona, readPersona } from './persona'
export type { Persona, ApiLogMode, DeviceType, CapturedFacts, PersonaInit } from './persona'
export { fetchRealDevice } from './devices'
export type { RealDevice } from './devices'
export { getLicenseToken, fetchLicenseToken, type LicenseInfo } from './license'
export { lookupProxyGeo as lookupEngineProxyGeo, probeProxyExit, type ProxyGeo, type ProxyProbeResult } from './geoip'
export { resolveProfileDir, resolveProfileDirSync, listProfileEntries, readProfileMeta, writeProfileMeta, sanitizeProfileName } from './profile-dir'
export type { ProfileEntry, ProfileMeta, ResolvedProfile } from './profile-dir'

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
  /** The cloud archive's generation. Equal to the local marker means this
   *  machine already holds it and the restore is skipped. */
  archiveVersion?: string
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
  /** Reopen the previous session's tabs. Default true. */
  restoreTabs?: boolean
  /** Device profile. New profiles only; an existing one keeps its own. */
  deviceType?: DeviceType
  /** Draw the identity from the real-device library (paid). New profiles only. */
  realFingerprint?: boolean
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
 * Decide what identity a brand-new profile gets. Runs after the archive is
 * restored, because persona.json travels inside the archive - checking earlier
 * would mint a fresh identity for a profile that already has one on another
 * machine.
 */
export async function resolvePersonaInit(
  profileDir: string,
  opts: Pick<OpenProfileOptions, 'deviceType' | 'realFingerprint' | 'key' | 'server'>,
): Promise<PersonaInit | undefined> {
  if (fs.existsSync(path.join(profileDir, 'persona.json'))) return undefined
  if (!opts.deviceType && !opts.realFingerprint) return undefined
  const device = opts.realFingerprint
    ? await fetchRealDevice({
        os: opts.deviceType === 'android' ? 'android' : 'windows',
        key: opts.key,
        server: opts.server,
      })
    : undefined
  return { deviceType: opts.deviceType, device }
}

/** An Android config on a pre-mobile kernel is worse than no Android at all. */
export function assertAndroidKernel(version: string | undefined, build: string | undefined): void {
  if (kernelSupportsAndroid(version, build)) return
  throw new Error(
    `Android profiles need kernel ${ANDROID_MIN_KERNEL_VERSION} built on or after ` +
      `${ANDROID_MIN_KERNEL_BUILD.slice(0, 10)}; this install reports version "${version ?? 'unknown'}" ` +
      `build "${build ?? 'unknown'}". Update the kernel and retry.`,
  )
}

/**
 * Restore the archive, load the persona, download the kernel it requires, look
 * up the proxy timezone, launch over CDP, and upload the archive on exit.
 */
export async function openProfile(opts: OpenProfileOptions): Promise<OpenedProfile> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir()
  // An explicit directory wins: callers that keep their own profile registry
  // (the desktop app) already know which directory this profile owns. Its own
  // record still names it, though - that record is the directory's identity,
  // and the archive is addressed by name.
  const resolved = opts.profileDir
    ? {
        dir: opts.profileDir,
        id: readProfileMeta(opts.profileDir)?.id ?? path.basename(opts.profileDir),
        name: readProfileMeta(opts.profileDir)?.name ?? opts.profileName,
      }
    : await resolveProfileDir({
        cacheDir,
        profileName: opts.profileName,
        key: opts.key,
        server: opts.server,
        onProgress: opts.onProgress,
      })
  const profileDir = resolved.dir
  fs.mkdirSync(profileDir, { recursive: true })

  // Restore first: persona.json carries the kernel version read below.
  if (opts.archiveGetUrl) {
    const local = readArchiveVersion(profileDir)
    // Equality, not ordering - an ETag has none. The case that matters: the last
    // upload failed, so the cloud still holds the generation this machine has,
    // and restoring it would erase newer local work.
    if (opts.archiveVersion && local && local === opts.archiveVersion) {
      opts.onProgress?.('Profile archive already current; skipping restore')
    } else {
      opts.onProgress?.('Restoring profile archive')
      opts.onArchiveSync?.({ phase: 'download', state: 'start' })
      await downloadProfileCache(opts.archiveGetUrl, profileDir).then(
        (restored) => {
          if (restored && opts.archiveVersion) writeArchiveVersion(profileDir, opts.archiveVersion)
          opts.onArchiveSync?.({ phase: 'download', state: 'done' })
        },
        (e: unknown) => opts.onArchiveSync?.({ phase: 'download', state: 'error', error: errText(e) }),
      )
    }
  }

  // Versions newer than this release exist only in the manifest, so resolve the
  // catalogue first. `updateKernelBeforeLaunch` acts on the published build, so
  // it cannot read a cached one.
  await refreshKernelVersions(cacheDir, { force: opts.updateKernelBeforeLaunch })

  const personaInit = await resolvePersonaInit(profileDir, opts)

  // An Android profile is pinned to the kernel that carries the mobile patches.
  // That pin must never resolve to something else: the Android version lives
  // only in the manifest, so a plain lookup would hand back the compiled-in
  // default and freeze a desktop kernel into a profile claiming to be a phone.
  const wantsAndroid = personaInit?.deviceType === 'android'
  const requestedVersion = wantsAndroid ? ANDROID_MIN_KERNEL_VERSION : opts.kernelVersion
  const defaultKv = wantsAndroid
    ? findKernelVersionStrict(ANDROID_MIN_KERNEL_VERSION)
    : requestedVersion
      ? findKernelVersion(requestedVersion)
      : DEFAULT_KERNEL_VERSION

  opts.onProgress?.('Loading persona')
  const persona = loadOrGeneratePersona(profileDir, defaultKv.version, personaInit)

  const kv = persona.deviceType === 'android'
    ? findKernelVersionStrict(persona.kernelVersion)
    : findKernelVersion(persona.kernelVersion)

  if (opts.updateKernelBeforeLaunch) {
    const status = kernelUpdateStatus(cacheDir, kv.version)
    if (status?.updateAvailable) {
      opts.onProgress?.(`Updating kernel ${kv.label} to the latest build`)
      await ensureKernel(cacheDir, kv, opts.onProgress, { force: true })
    }
  }

  opts.onProgress?.(`Ensuring kernel ${kv.label}`)
  const exePath = await ensureKernel(cacheDir, kv, opts.onProgress)

  if (persona.deviceType === 'android') {
    let build = installedKernelBuild(cacheDir, kv.version)
    if (!kernelSupportsAndroid(kv.version, build)) {
      // The marker can lag a rebuild of the same version, so force one refetch
      // before giving up.
      opts.onProgress?.('Updating kernel for Android device support')
      await ensureKernel(cacheDir, kv, opts.onProgress, { force: true })
      build = installedKernelBuild(cacheDir, kv.version)
    }
    assertAndroidKernel(kv.version, build)
  }

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
    label: opts.label ?? resolved.name,
    headless: opts.headless,
    canvasNoise: opts.canvasNoise,
    apiLog: opts.apiLog,
    webauthnCapture: opts.webauthnCapture,
    restoreTabs: opts.restoreTabs,
    rttMs: geo?.rttMs,
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
  let version: string | undefined
  try {
    version = await uploadProfileCache(profileDir, url)
  } catch (e) {
    const expired = /HTTP 40[13]/.test(errText(e))
    if (!expired || !opts.getArchivePutUrl) throw e
    const fresh = await opts.getArchivePutUrl()
    if (!fresh) throw e
    version = await uploadProfileCache(profileDir, fresh)
  }
  // No ETag means we cannot name what we just wrote; drop the marker so the next
  // launch restores rather than trusting a stale generation.
  if (version) writeArchiveVersion(profileDir, version)
  else clearArchiveVersion(profileDir)
}

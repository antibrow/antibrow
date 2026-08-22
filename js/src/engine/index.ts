import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  ensureKernel,
  KERNEL_VERSIONS,
  defaultKernelVersion,
  findKernelVersion,
  findKernelVersionStrict,
  normalizeKernelVersion,
  refreshKernelVersions,
  kernelUpdateStatus,
  kernelSupportsAndroid,
  kernelReadsAppLocaleFromConfig,
  resolveAndroidKernel,
  ANDROID_MIN_KERNEL_VERSION,
  installedKernelBuild,
  type KernelVersion,
} from './downloader'
import { loadOrGeneratePersona, readPersona, writePersona, withKernelVersion, type ApiLogMode, type DeviceType, type Persona, type PersonaInit } from './persona'
import { fetchRealDevice } from './devices'
import { lookupDirectGeo, lookupProxyGeo, type ProxyGeo } from './geoip'
import { getLicenseToken } from './license'
import { launchKernel, type KernelSession } from './launcher'
import {
  downloadProfileCache,
  uploadProfileCache,
  readArchiveVersion,
  writeArchiveVersion,
  clearArchiveVersion,
} from './profile-cache'
import { resolveProfileDir, resolveProfileDirSync, readProfileMeta, settleCryptState, type ProfileRootOptions } from './profile-dir'
import { fetchProfileCryptKey, resolveCryptKey } from './crypt-key'

export { KERNEL_VERSIONS, DEFAULT_KERNEL_VERSION, defaultKernelVersion, ensureKernel, isKernelInstalled, findKernelVersion, findKernelVersionStrict, normalizeKernelVersion, migrateLegacyKernelDirs, listInstalledKernels, kernelDirSize, deleteKernel, kernelDir, kernelAvailableOnPlatform, kernelsForPlatform, allKernelVersions, registerKernelVersions, fetchRemoteKernelVersions, refreshKernelVersions, loadCachedKernelVersions, KERNEL_MANIFEST_URL, KERNEL_MANIFEST_TTL_MS, KERNEL_VERSION_CACHE_FILE, currentPlatform, installedKernelBuild, writeInstalledKernelBuild, kernelUpdateStatus, installedKernelUpdates, kernelSupportsAndroid, kernelReadsAppLocaleFromConfig, kernelVersionAtLeast, androidCapableKernels, resolveAndroidKernel, ANDROID_MIN_KERNEL_VERSION, APP_LOCALE_MIN_KERNEL_VERSION, APP_LOCALE_MIN_KERNEL_BUILD } from './downloader'
export type { KernelVersion, KernelUpdateStatus } from './downloader'
export type { KernelSession as EngineSession } from './launcher'
export { downloadProfileCache, uploadProfileCache, packProfileCache, packProfileCacheWithReport, lastProfilePackReport, unpackProfileCache, exportProfileArchive, importProfileArchive, PROFILE_ARCHIVE_EXT, ARCHIVE_VERSION_FILE, readArchiveVersion, writeArchiveVersion, clearArchiveVersion, normalizeArchiveVersion } from './profile-cache'
export type { ProfilePackReport, ProfilePackResult } from './profile-cache'
export type { PortableProfileMeta, ImportedProfileMeta } from './profile-cache'
export { generatePersona, loadOrGeneratePersona, readPersona, writePersona, withKernelVersion } from './persona'
export type { Persona, ApiLogMode, DeviceType, CapturedFacts, PersonaInit } from './persona'
export { fetchRealDevice } from './devices'
export type { RealDevice } from './devices'
export { getLicenseToken, fetchLicenseToken, type LicenseInfo } from './license'
export { lookupProxyGeo as lookupEngineProxyGeo, lookupDirectGeo, probeProxyExit, type ProxyGeo, type ProxyProbeResult } from './geoip'
export { resolveProfileDir, resolveProfileDirSync, listProfileEntries, readProfileMeta, writeProfileMeta, isProfileEncrypted, markProfileEncrypted, unmarkProfileEncrypted, readCryptState, writeCryptState, settleCryptState, isCryptKeyPending, markCryptKeyPending, clearCryptKeyPending, profileCryptMarker, CRYPT_STATE_FILE, CRYPT_PENDING_FILE, sanitizeProfileName, profilesRoot, TEMPORARY_PROFILES_DIR } from './profile-dir'
export type { CryptSettlement } from './profile-dir'
export { fetchProfileCryptKey, parseCryptKeyBody, resolveCryptKey } from './crypt-key'
export { exportProfileArchiveAsync, runCryptRekey, buildRekeyArgs, parseRekeyCode, CryptRekeyError, NO_CRYPT_KEY, REKEY_TIMEOUT_CODE } from './crypt-rekey'
export type { ExportProfileArchiveOptions, CryptRekeyOptions, RekeyRequest, RekeyRunner } from './crypt-rekey'
export type { ProfileEntry, ProfileMeta, ResolvedProfile, ProfileRootOptions } from './profile-dir'

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
  /** Pre-fetched encryption key, used instead of asking the server for one.
   *  Ignored unless the profile directory is marked as created under a key. */
  cryptKey?: string
  /** Where the encryption key comes from when the profile needs one. Defaults
   *  to this account's own profile endpoint; a guest passes the shared one. */
  getCryptKey?: () => Promise<string | undefined>
  /** Proxy URL: scheme://user:pass@host:port */
  proxyUrl?: string
  /** Resolved after the kernel is in place; wins over `proxyUrl`. A managed
   *  credential is single-session, and a first launch on a new machine spends
   *  many minutes downloading a kernel before the browser exists - one taken
   *  before that download can be dead by the time it is used. */
  getProxyUrl?: () => Promise<string | undefined>
  headless?: boolean
  /** Whether the new window takes focus. Default true. */
  focusWindow?: boolean
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
  /** Use the temporary profile tree. Never touches the server. */
  temporary?: boolean
  /** Cloud row id the caller already holds; saves a duplicate profile GET. */
  serverProfileId?: string
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
export function assertAndroidKernel(version: string | undefined): void {
  if (kernelSupportsAndroid(version)) return
  throw new Error(
    `Android profiles need kernel ${ANDROID_MIN_KERNEL_VERSION} or newer; this install reports ` +
      `version "${version ?? 'unknown'}". Update the kernel and retry.`,
  )
}

/**
 * Whether the cloud archive has to be laid over this profile. Equality, not
 * ordering - an ETag has none. The case that matters: the last upload failed, so
 * the cloud still holds the generation this machine has, and restoring it would
 * erase newer local work (a kernel switch included: persona.json is in the
 * archive and the restore runs before it is read).
 */
export function shouldRestoreArchive(local: string | undefined, server: string | undefined): boolean {
  return !(server && local && local === server)
}

export interface SetProfileKernelVersionOptions extends ProfileRootOptions {
  /** Target kernel, e.g. "151". A legacy full version string is accepted. */
  version: string
  /** Profile to move; ignored when `profileDir` is given. */
  profileName?: string
  profileDir?: string
  cacheDir?: string
  /**
   * The profile's cloud archive. Given it, the switch is committed there before
   * this resolves; without it the switch is local to this directory and the
   * next restore replaces it.
   */
  archive?: {
    /** Presigned GET for the current cloud copy. */
    getUrl?: string
    /** Its generation, compared against this directory's marker. */
    version?: string
    /** Resolved at the moment of upload - a presign rarely outlives the pack. */
    getPutUrl?: () => Promise<string | undefined>
  }
}

/**
 * Move an existing profile to another kernel major, keeping its identity: only
 * the three version-derived persona fields change.
 *
 * With `archive`, the whole thing is one committed operation: the current cloud
 * copy comes down first (another machine may hold a newer one), the persona
 * moves, and the result goes back up - and a failed upload rolls the persona
 * back rather than leaving the switch half-made. That is what makes the switch
 * hold everywhere, including a second cache directory on this same machine:
 * they all restore from the archive, and the archive now carries it.
 */
export async function setProfileKernelVersion(opts: SetProfileKernelVersionOptions): Promise<Persona> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir()
  const dir = opts.profileDir
    ?? (opts.profileName && resolveProfileDirSync(cacheDir, opts.profileName, { temporary: opts.temporary }).dir)
  if (!dir) throw new Error('setProfileKernelVersion needs a profileDir or a profileName')

  // Start from the cloud copy: moving a stale local one and uploading it would
  // discard whatever another machine last saved.
  if (opts.archive?.getUrl && shouldRestoreArchive(readArchiveVersion(dir), opts.archive.version)) {
    if (await downloadProfileCache(opts.archive.getUrl, dir)) {
      if (opts.archive.version) writeArchiveVersion(dir, opts.archive.version)
      else clearArchiveVersion(dir)
    }
  }

  const persona = readPersona(dir)
  if (!persona) {
    throw new Error(
      `Profile at ${dir} has no persona yet, so there is no identity to move. ` +
        'Create it with openProfile({ kernelVersion }) instead.',
    )
  }

  // Versions published after this release exist only in the manifest, and the
  // lookup is strict for the same reason the Android one is: silently answering
  // with the compiled-in default would leave the profile on its old kernel while
  // reporting the new one.
  await refreshKernelVersions(cacheDir)
  const kv = findKernelVersionStrict(opts.version)
  if (persona.deviceType === 'android') assertAndroidKernel(kv.version)

  const next = withKernelVersion(persona, kv.version)
  writePersona(dir, next)

  const getPutUrl = opts.archive?.getPutUrl
  if (getPutUrl) {
    try {
      const putUrl = await getPutUrl()
      if (putUrl) {
        const generation = await uploadProfileCache(dir, putUrl)
        if (generation) writeArchiveVersion(dir, generation)
        else clearArchiveVersion(dir)
      }
    } catch (error) {
      // A switch that reached this directory but not the cloud is the drift
      // this function exists to prevent: the caller would report the new
      // version while every other copy still restores the old one.
      writePersona(dir, persona)
      throw error
    }
  }
  return next
}

/**
 * Say so when a restore just changed which browser core this profile runs.
 *
 * The cloud copy is authoritative, so the swap itself is correct - but in
 * silence it is indistinguishable from the profile having always been on that
 * version, which is what makes "the app says 152 and it launched 150" so hard
 * to explain.
 */
export function reportRestoredKernelChange(
  profileDir: string,
  before: string | undefined,
  onProgress?: (message: string) => void,
): void {
  if (!before || !onProgress) return
  const after = normalizeKernelVersion(readPersona(profileDir)?.kernelVersion)
  if (!after || after === normalizeKernelVersion(before)) return
  onProgress(`Cloud archive moved this profile from Chrome ${normalizeKernelVersion(before)} to ${after}`)
}

/**
 * Bring a profile's persona onto the kernel version its caller believes it is
 * running, and report either way.
 *
 * Callers that keep their own registry (the desktop app, a launcher script)
 * hand `openProfile` a stored kernel version on every launch, while the version
 * that actually runs comes from persona.json. The two drift apart whenever the
 * stored one moves on its own - cloud sync copies that field between machines
 * and never touches the profile directory - and the drift used to be silent:
 * the row read 152, the browser launched 150 and introduced itself as Chrome
 * 150 to every site.
 *
 * A refused move is reported, not thrown: the persona's own version is a
 * working launch, and breaking it would be a worse answer than running the
 * older kernel with the reason said out loud.
 */
export async function reconcileKernelVersion(opts: {
  profileDir: string
  persona: Persona
  /** The caller's stored version, if it keeps one. */
  requested?: string
  cacheDir: string
  onProgress?: (message: string) => void
}): Promise<Persona> {
  // Both sides are normalised: profiles created before the majors-only change
  // still carry the full four-segment string, which is never rewritten just for
  // being read, and a raw comparison would call that a mismatch.
  const requested = normalizeKernelVersion(opts.requested)
  if (!requested || requested === normalizeKernelVersion(opts.persona.kernelVersion)) return opts.persona
  try {
    const next = await setProfileKernelVersion({
      profileDir: opts.profileDir, version: requested, cacheDir: opts.cacheDir,
    })
    opts.onProgress?.(
      `Moving profile from Chrome ${opts.persona.kernelVersion} to ${next.kernelVersion}`,
    )
    return next
  } catch (error) {
    opts.onProgress?.(
      `Cannot move this profile to Chrome ${requested}, launching on ` +
      `${opts.persona.kernelVersion}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return opts.persona
  }
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
        temporary: opts.temporary,
        serverId: opts.serverProfileId,
        onProgress: opts.onProgress,
      })
  const profileDir = resolved.dir
  fs.mkdirSync(profileDir, { recursive: true })

  // Restore first: persona.json carries the kernel version read below.
  const kernelBeforeRestore = readPersona(profileDir)?.kernelVersion
  if (opts.archiveGetUrl) {
    if (!shouldRestoreArchive(readArchiveVersion(profileDir), opts.archiveVersion)) {
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
      reportRestoredKernelChange(profileDir, kernelBeforeRestore, opts.onProgress)
    }
  }

  // After the restore, before the kernel install: crypt-state.json rides in the
  // archive, so on a second machine the restore is what tells us this profile's
  // data is encrypted. The directory decides - a key is never fetched without
  // its say-so, and a key that cannot be obtained fails the launch here rather
  // than being downgraded into a launch without the flag.
  //
  // Settled first, against the data the restore just laid down: it closes out a
  // previous session the kernel already answered (including one that ended in a
  // crash, before the exit hook below could run) and corrects a mark that data
  // contradicts, so what follows reads a directory that agrees with itself.
  settleCryptState(profileDir)
  const cryptKey = await resolveCryptKey({
    profileDir,
    cryptKey: opts.cryptKey,
    getCryptKey:
      opts.getCryptKey ??
      (opts.key
        ? () => fetchProfileCryptKey({ key: opts.key as string, server: opts.server, name: resolved.name })
        : undefined),
  })

  // Versions newer than this release exist only in the manifest, so resolve the
  // catalogue first. `updateKernelBeforeLaunch` acts on the published build, so
  // it cannot read a cached one.
  await refreshKernelVersions(cacheDir, { force: opts.updateKernelBeforeLaunch })

  const personaInit = await resolvePersonaInit(profileDir, opts)

  // An Android profile can only be created against a kernel that carries the
  // mobile patches, so the requested version is honoured only when it is one of
  // them - a plain lookup would hand back the compiled-in desktop default and
  // freeze it into a profile claiming to be a phone.
  const wantsAndroid = personaInit?.deviceType === 'android'
  const defaultKv = wantsAndroid
    ? resolveAndroidKernel(opts.kernelVersion)
    : opts.kernelVersion
      ? findKernelVersion(opts.kernelVersion)
      : defaultKernelVersion()

  opts.onProgress?.('Loading persona')
  // Only a profile that already had one can drift: a persona generated right
  // here is seeded from the very version the caller asked for.
  const hadPersona = !!readPersona(profileDir)
  const seeded = loadOrGeneratePersona(profileDir, defaultKv.version, personaInit)
  const persona = hadPersona
    ? await reconcileKernelVersion({
        profileDir, persona: seeded, requested: opts.kernelVersion, cacheDir, onProgress: opts.onProgress,
      })
    : seeded

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

  if (persona.deviceType === 'android') assertAndroidKernel(kv.version)

  // Deliberately after ensureKernel: everything from here to the spawn is
  // seconds, so a credential minted now is still alive when the kernel reads it.
  const proxyUrl = opts.getProxyUrl ? await opts.getProxyUrl() : opts.proxyUrl

  let timezone = persona.timezone
  let publicIp: string | undefined
  let rttMs: number | undefined
  let geo: ProxyGeo | null = null
  if (proxyUrl) {
    opts.onProgress?.('Looking up proxy geo')
    geo = await lookupProxyGeo(proxyUrl).catch(() => null)
    if (geo?.timezone) timezone = geo.timezone
    if (geo?.ip) publicIp = geo.ip
  } else {
    // Traffic exits from this machine, so this machine's geo is what the
    // persona has to agree with. Not published on the session: `geo` there
    // means the proxy's exit, and a direct answer would read as one. Short
    // timeout because nothing here blocks a launch - a network that swallows
    // the request must not add ten seconds to every start.
    opts.onProgress?.('Looking up exit geo')
    const direct = await lookupDirectGeo(4_000).catch(() => null)
    if (direct?.timezone) timezone = direct.timezone
    if (direct?.ip) publicIp = direct.ip
    rttMs = direct?.rttMs
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
    proxyUrl,
    licenseToken,
    cryptKey,
    label: opts.label ?? resolved.name,
    headless: opts.headless,
    focusWindow: opts.focusWindow,
    localeFromConfig: kernelReadsAppLocaleFromConfig(kv.version, installedKernelBuild(cacheDir, kv.version)),
    canvasNoise: opts.canvasNoise,
    apiLog: opts.apiLog,
    webauthnCapture: opts.webauthnCapture,
    restoreTabs: opts.restoreTabs,
    rttMs: geo?.rttMs ?? rttMs,
    onProgress: opts.onProgress,
  })
  if (geo) session.geo = geo

  // Decided at launch so the hook exists before the browser can exit; the URL
  // is resolved inside it.
  const uploads = !!(opts.getArchivePutUrl || opts.archivePutUrl)
  session.onExit(() => {
    // The kernel has stopped and flushed `Local State`, so this is the first
    // moment the outcome of --fp-crypt-key can be read - and the last one before
    // the pack below turns this directory into the archive every other machine
    // will restore. A build that ignored the switch settles as plain here, so
    // nothing claims an encryption that was never applied.
    settleCryptState(profileDir)
    if (!uploads) return
    opts.onArchiveSync?.({ phase: 'upload', state: 'start' })
    session.archiveUpload = uploadArchive(profileDir, opts).then(
      () => opts.onArchiveSync?.({ phase: 'upload', state: 'done' }),
      (e: unknown) => opts.onArchiveSync?.({ phase: 'upload', state: 'error', error: errText(e) }),
    )
  })

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

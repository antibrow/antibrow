import type {
  AntiDetectBrowserOptions,
  LaunchOptions,
  LaunchResult,
  LiveViewStreamOptions,
} from './types'
import {
  getProfile,
  getOrCreateProfile,
  activateProxy,
  managedProxyToRelayUrl,
  issueProxyTicket,
  revokeProxyTicket,
  DEFAULT_RELAY_HOST,
  getProfileArchiveUrls,
  getProfileArchiveUploadUrl,
} from './api'
import { ensureCacheDir } from './profile'
import {
  openProfile,
  getLicenseToken,
  ensureKernel,
  findKernelVersion,
  refreshKernelVersions,
  installedKernelUpdates,
  readProfileMeta,
  type EngineSession,
  type KernelUpdateStatus,
  type OpenProfileOptions,
} from './engine'
import { LiveViewStream, registerLiveSession, unregisterLiveSession, heartbeatLiveSession } from './liveview'
import { checkClientVersion, SDK_VERSION, type VersionCheckResult } from './version'
import { clearTemporaryProfiles, type ClearTemporaryOptions, type ClearedTemporaryProfile } from './temporary-profiles'

export type SyncMode = 'off' | 'existing' | 'create'

/**
 * A launch never creates a cloud profile on its own: an automation run that
 * mints a name per task would otherwise fill the account's sync quota with
 * profiles nobody asked to keep.
 */
export function resolveSyncMode(input: {
  temporary: boolean
  sync?: boolean
  licenseSync: boolean
}): SyncMode {
  if (input.temporary) {
    if (input.sync === true) {
      throw new Error('A temporary profile cannot be synced. Drop `temporary` or drop `sync: true`.')
    }
    return 'off'
  }
  if (input.sync === false) return 'off'
  if (input.sync === true) {
    if (!input.licenseSync) throw new Error('Cloud sync is not available on your plan.')
    return 'create'
  }
  return input.licenseSync ? 'existing' : 'off'
}

export interface BuildOpenProfileOptionsInput {
  key?: string
  server?: string
  profileName: string
  licenseToken: string
  proxyUrl?: string
  archive: { downloadUrl?: string; uploadUrl?: string; version?: string }
  getArchivePutUrl?: () => Promise<string | undefined>
  cacheDir?: string
  profileDir?: string
  temporary: boolean
  options: LaunchOptions
}

/**
 * Assembles the engine's `openProfile()` call from a `launch()` invocation.
 * Pulled out as a pure function so the device-option plumbing (deviceType,
 * realFingerprint, label) is testable without starting a browser: feed it
 * deterministic inputs and assert on the object it returns.
 */
export function buildOpenProfileOptions(input: BuildOpenProfileOptionsInput): OpenProfileOptions {
  const { key, server, profileName, licenseToken, proxyUrl, archive, getArchivePutUrl, cacheDir, profileDir, temporary, options } = input
  return {
    key,
    server,
    profileName,
    licenseToken,
    proxyUrl,
    archiveGetUrl: archive.downloadUrl,
    archiveVersion: archive.version,
    // Presence decides whether an upload happens; the URL itself is signed
    // again after exit, since a session usually outlives this one.
    archivePutUrl: archive.uploadUrl,
    getArchivePutUrl,
    cacheDir: profileDir ? undefined : cacheDir,
    profileDir,
    temporary,
    headless: options.headless,
    focusWindow: options.focusWindow,
    updateKernelBeforeLaunch: options.updateKernelBeforeLaunch,
    deviceType: options.deviceType,
    realFingerprint: options.realFingerprint,
    label: options.label,
  }
}

export class AntiDetectBrowser {
  private readonly key: string
  private readonly server?: string
  private readonly cacheDir: string
  private readonly relayUrl: string
  private readonly proxyHost: string
  private readonly notify: (message: string) => void
  private readonly temporary: boolean
  private activeSessions: Map<string, {
    session: EngineSession
    profileName: string
    liveView?: LiveViewStream
    heartbeatInterval?: ReturnType<typeof setInterval>
    ticket?: { proxyId: string; ticketId: string }
  }> = new Map()
  private versionCheckPromise?: Promise<VersionCheckResult>
  private versionWarned = false
  /** Sync conclusion per `<mode>:<name>`, so a relaunch loop probes the server once. */
  private syncedProfiles: Map<string, boolean> = new Map()
  private kernelUpdateChecked = false
  /** Local-only notice already printed for this name, so a relaunch loop prints it once. */
  private localOnlyNotified: Set<string> = new Set()

  constructor(options: AntiDetectBrowserOptions) {
    if (!options.key) {
      throw new Error('API key is required. Pass { key: "your-api-key" } to AntiDetectBrowser constructor.')
    }
    this.key = options.key
    this.server = options.server || 'https://antibrow.com'
    this.cacheDir = ensureCacheDir(options.cacheDir)
    this.relayUrl = options.relayUrl || 'wss://liveview-relay.antibrow.com'
    this.proxyHost = options.proxyHost || DEFAULT_RELAY_HOST
    this.notify = options.notify ?? ((m) => console.log(m))
    this.temporary = options.temporary ?? false
  }

  async launch(options: LaunchOptions): Promise<LaunchResult> {
    if (!options.profile) {
      throw new Error('The "profile" option is required. Pass a profile name to launch().')
    }
    if ('kernel' in options || 'kernelVersion' in options || 'os' in options || 'seed' in options || 'fingerprint' in options) {
      throw new Error('Legacy fingerprint/kernel launch options were removed. engine generates the browser identity locally per profile.')
    }
    for (const [, s] of this.activeSessions) {
      if (s.profileName === options.profile) {
        throw new Error(
          `Profile "${options.profile}" is already in use by an active browser session. ` +
          'Close the existing session first, or use a different profile name.',
        )
      }
    }

    await this.ensureVersionOk()

    // Advisory only: never blocks the launch, and never updates behind the
    // caller's back. With the flag on, openProfile updates before launching.
    if (!options.updateKernelBeforeLaunch) this.maybeNotifyKernelUpdate()

    // Cached locally and only refetched near expiry, so this is cheap in loops.
    // Concurrency is capped by the kernel, not here.
    const license = await getLicenseToken({ key: this.key, server: this.server })

    // Resolved before anything is issued server-side: a rejected combination
    // must not leave a live proxy ticket behind.
    const temporary = options.temporary ?? this.temporary
    const syncMode = resolveSyncMode({ temporary, sync: options.sync, licenseSync: license.sync })

    let proxyUrl: string | undefined = options.proxy
    let ticket: { proxyId: string; ticketId: string } | undefined
    if (options.proxyId) {
      // Activate first (metering + ownership check), then take a short-lived
      // credential: the account key must never reach the command line.
      const activation = await activateProxy({
        key: this.key, server: this.server, proxyId: options.proxyId,
      })
      if (!activation.proxy) {
        throw new Error('Proxy activation did not return proxy credentials.')
      }
      const issued = await issueProxyTicket({
        key: this.key, server: this.server, proxyId: activation.proxy.id, label: options.profile,
      })
      ticket = { proxyId: activation.proxy.id, ticketId: issued.ticketId }
      proxyUrl = managedProxyToRelayUrl(issued.username, issued.password, this.proxyHost)
    }

    // An explicit directory carries its own identity, and the archive is addressed
    // by name - resolve it the same way openProfile does, or the restore lands in a
    // directory that belongs to a different profile.
    const profileName = options.userDataDir
      ? readProfileMeta(options.userDataDir)?.name ?? options.profile
      : options.profile

    let archive: { downloadUrl?: string; uploadUrl?: string; version?: string } = {}
    let session: EngineSession
    try {
      if (syncMode !== 'off' && await this.hasCloudProfile(profileName, syncMode, options.tags)) {
        archive = await getProfileArchiveUrls({
          key: this.key,
          server: this.server,
          name: profileName,
        }).catch(() => ({}))
      }

      session = await openProfile(buildOpenProfileOptions({
        key: this.key,
        server: this.server,
        profileName,
        licenseToken: license.token,
        proxyUrl,
        archive,
        getArchivePutUrl: archive.uploadUrl
          ? () => getProfileArchiveUploadUrl({ key: this.key, server: this.server, name: profileName })
          : undefined,
        cacheDir: this.cacheDir,
        profileDir: options.userDataDir,
        temporary,
        options,
      }))
    } catch (error) {
      // A launch that never opened a browser has no close hook to revoke on, so
      // the ticket would stay live for its full lifetime. Retrying against a
      // flaky proxy would mint one live credential per attempt.
      if (ticket) {
        revokeProxyTicket({ key: this.key, server: this.server, ...ticket }).catch(() => {})
      }
      throw error
    }
    const { context } = session
    const page = context.pages()[0] ?? await context.newPage()

    const sessionId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    this.activeSessions.set(sessionId, { session, profileName: options.profile, ticket })

    let liveViewInfo: { sessionKey: string; viewUrl: string } | undefined
    if (options.liveView) {
      try {
        const lvOptions: LiveViewStreamOptions = typeof options.liveView === 'object' ? options.liveView : {}
        const reg = await registerLiveSession({
          key: this.key, server: this.server, sessionKey: sessionId,
          profileName: options.profile, label: options.label, ua: '',
        })
        const stream = new LiveViewStream(context, page, this.relayUrl, reg.sessionKey, reg.relayToken, lvOptions)
        await stream.start()
        liveViewInfo = { sessionKey: reg.sessionKey, viewUrl: reg.viewUrl }
        const stored = this.activeSessions.get(sessionId)
        if (stored) {
          stored.liveView = stream
          stored.heartbeatInterval = setInterval(() => {
            heartbeatLiveSession({ key: this.key, server: this.server, sessionKey: sessionId }).catch(() => {})
          }, 30_000)
        }
      } catch { /* optional */ }
    }

    const closeSession = async () => {
      await session.close()
    }

    context.on('close', () => {
      const stored = this.activeSessions.get(sessionId)
      if (stored?.liveView) {
        stored.liveView.stop().catch(() => {})
        unregisterLiveSession({ key: this.key, server: this.server, sessionKey: sessionId }).catch(() => {})
      }
      if (stored?.heartbeatInterval) clearInterval(stored.heartbeatInterval)
      if (stored?.ticket) {
        revokeProxyTicket({
          key: this.key, server: this.server, ...stored.ticket,
        }).catch(() => {})
      }
      this.activeSessions.delete(sessionId)
    })

    return {
      browser: { close: closeSession },
      context,
      page,
      profileDir: session.profileDir,
      ...(liveViewInfo ? { liveView: liveViewInfo } : {}),
    }
  }

  /** Whether the server holds this profile; `create` mode makes it so.
   *  Cached per mode: a default launch's "no" must not answer for a later
   *  explicit `sync: true`, whose whole point is to create the row. */
  private async hasCloudProfile(name: string, mode: SyncMode, tags?: string[]): Promise<boolean> {
    const cacheKey = `${mode}:${name}`
    const cached = this.syncedProfiles.get(cacheKey)
    if (cached !== undefined) return cached
    try {
      if (mode === 'create') {
        await getOrCreateProfile({ key: this.key, server: this.server, name, tags })
        // A created row is one the server now knows, so the default mode has to
        // stop answering "no" for this name.
        this.syncedProfiles.set(`existing:${name}`, true)
      } else {
        await getProfile({ key: this.key, server: this.server, name })
      }
      this.syncedProfiles.set(cacheKey, true)
      return true
    } catch (error) {
      // Only a definitive "no such profile" is worth remembering. Caching a
      // dropped connection or a 5xx would keep a long-lived process local-only
      // for the rest of its life, silently never uploading again.
      const definitive = error instanceof Error && error.message.includes('HTTP 404')
      if (definitive && mode !== 'create') {
        this.syncedProfiles.set(cacheKey, false)
        this.notifyLocalOnly(name)
      }
      return false
    }
  }

  /** Once per name per process: a default launch of a name the server has
   *  never heard of silently stays local-only, which is easy to miss until
   *  a machine switch loses the data. */
  private notifyLocalOnly(name: string): void {
    if (this.localOnlyNotified.has(name)) return
    this.localOnlyNotified.add(name)
    this.notify(
      `[anti-detect-browser] Profile "${name}" is local-only; pass { sync: true } to sync it to the cloud.`,
    )
  }

  private async ensureVersionOk(): Promise<void> {
    if (!this.versionCheckPromise) {
      this.versionCheckPromise = checkClientVersion({
        client: 'sdk', version: SDK_VERSION, server: this.server,
      }).catch(() => ({ status: 'ok', current: SDK_VERSION } as VersionCheckResult))
    }
    const vc = await this.versionCheckPromise

    if (vc.status === 'required') {
      throw new Error(
        `anti-detect-browser ${SDK_VERSION} is no longer supported` +
        (vc.minSupported ? ` (minimum supported: ${vc.minSupported})` : '') +
        '. Please upgrade: npm install anti-detect-browser@latest' +
        (vc.downloadUrl ? ` - ${vc.downloadUrl}` : ''),
      )
    }
    if (vc.status === 'recommended' && !this.versionWarned) {
      this.versionWarned = true
      console.warn(
        '[anti-detect-browser] A newer version is available' +
        (vc.latest ? ` (${vc.latest})` : '') +
        `. You are on ${SDK_VERSION}. Upgrade: npm install anti-detect-browser@latest`,
      )
    }
  }

  /** One entry per installed kernel; check `.updateAvailable`. */
  async checkKernelUpdates(): Promise<KernelUpdateStatus[]> {
    // Forced: an explicit check must not answer from a cached manifest.
    await refreshKernelVersions(this.cacheDir, { force: true })
    return installedKernelUpdates(this.cacheDir)
  }

  /** True when any installed kernel has a newer build available. */
  async hasKernelUpdate(): Promise<boolean> {
    return (await this.checkKernelUpdates()).some((k) => k.updateAvailable)
  }

  /** Once per process, print a notice if an installed kernel is out of date. */
  private maybeNotifyKernelUpdate(): void {
    if (this.kernelUpdateChecked) return
    this.kernelUpdateChecked = true
    void this.checkKernelUpdates()
      .then((updates) => {
        const outdated = updates.filter((u) => u.updateAvailable)
        if (!outdated.length) return
        const list = outdated.map((u) => u.label || u.version).join(', ')
        this.notify(
          `[anti-detect-browser] A newer browser kernel build is available for: ${list}. ` +
          'Run browser.updateKernel() to update now, or launch with { updateKernelBeforeLaunch: true }.',
        )
      })
      .catch(() => { /* offline: stay quiet */ })
  }

  /** Update installed kernels (or just `version`); returns what was updated. */
  async updateKernel(version?: string, onProgress?: (message: string) => void): Promise<string[]> {
    const updates = await this.checkKernelUpdates()
    const targets = (version ? updates.filter((u) => u.version === version) : updates)
      .filter((u) => u.updateAvailable)
    const updated: string[] = []
    for (const u of targets) {
      await ensureKernel(this.cacheDir, findKernelVersion(u.version), onProgress, { force: true })
      updated.push(u.version)
    }
    return updated
  }

  /** Delete this cache directory's temporary profiles, skipping live sessions. */
  clearTemporaryProfiles(opts?: ClearTemporaryOptions): ClearedTemporaryProfile[] {
    const live = Array.from(this.activeSessions.values()).map((s) => s.session.profileDir)
    return clearTemporaryProfiles(this.cacheDir, { ...opts, skipDirs: [...(opts?.skipDirs ?? []), ...live] })
  }

  async close(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [, s] of this.activeSessions) {
      if (s.liveView) promises.push(s.liveView.stop().catch(() => {}))
      if (s.heartbeatInterval) clearInterval(s.heartbeatInterval)
      promises.push(s.session.close().catch(() => {}))
    }
    await Promise.all(promises)
    this.activeSessions.clear()
  }

  get sessionCount(): number {
    return this.activeSessions.size
  }
}

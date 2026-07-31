import type {
  AntiDetectBrowserOptions,
  LaunchOptions,
  LaunchResult,
  LiveViewStreamOptions,
} from './types'
import {
  getOrCreateProfile,
  activateProxy,
  managedProxyToRelayUrl,
  DEFAULT_RELAY_HOST,
  getProfileArchiveUrls,
} from './api'
import { ensureCacheDir } from './profile'
import {
  openProfile,
  getLicenseToken,
  ensureKernel,
  findKernelVersion,
  fetchRemoteKernelVersions,
  registerKernelVersions,
  installedKernelUpdates,
  type EngineSession,
  type KernelUpdateStatus,
} from './engine'
import { LiveViewStream, registerLiveSession, unregisterLiveSession, heartbeatLiveSession } from './liveview'
import { checkClientVersion, SDK_VERSION, type VersionCheckResult } from './version'
import { installLabel, labelOptions } from './label'

export class AntiDetectBrowser {
  private readonly key: string
  private readonly server?: string
  private readonly cacheDir: string
  private readonly relayUrl: string
  private readonly proxyHost: string
  private readonly notify: (message: string) => void
  private activeSessions: Map<string, {
    session: EngineSession
    profileName: string
    liveView?: LiveViewStream
    heartbeatInterval?: ReturnType<typeof setInterval>
  }> = new Map()
  private versionCheckPromise?: Promise<VersionCheckResult>
  private versionWarned = false
  /**
   * Profiles already ensured server-side this process. Only sync-capable plans
   * need a server row, and skipping the round-trip keeps relaunch loops cheap.
   */
  private ensuredProfiles: Set<string> = new Set()
  private kernelUpdateChecked = false

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

    let proxyUrl: string | undefined = options.proxy
    if (options.proxyId) {
      // Activate first (metering + ownership check), then address it by id.
      const activation = await activateProxy({
        key: this.key, server: this.server, proxyId: options.proxyId,
      })
      if (!activation.proxy) {
        throw new Error('Proxy activation did not return proxy credentials.')
      }
      proxyUrl = managedProxyToRelayUrl(this.key, activation.proxy.id, this.proxyHost)
    }

    // Only sync-capable plans touch the server; otherwise everything runs from
    // the local profile directory.
    let archive: { downloadUrl?: string; uploadUrl?: string } = {}
    if (license.sync) {
      if (!this.ensuredProfiles.has(options.profile)) {
        const ensured = await getOrCreateProfile({
          key: this.key,
          server: this.server,
          name: options.profile,
          tags: options.tags,
        })
          .then(() => true)
          .catch(() => false)
        if (ensured) this.ensuredProfiles.add(options.profile)
      }
      archive = await getProfileArchiveUrls({
        key: this.key,
        server: this.server,
        name: options.profile,
      }).catch(() => ({}))
    }

    const session = await openProfile({
      key: this.key,
      server: this.server,
      profileName: options.profile,
      licenseToken: license.token,
      proxyUrl,
      archiveGetUrl: archive.downloadUrl,
      // Presence decides whether an upload happens; the URL itself is signed
      // again after exit, since a session usually outlives this one.
      archivePutUrl: archive.uploadUrl,
      getArchivePutUrl: archive.uploadUrl
        ? () => getProfileArchiveUrls({ key: this.key, server: this.server, name: options.profile })
            .then((a) => a.uploadUrl)
        : undefined,
      cacheDir: options.userDataDir ? undefined : this.cacheDir,
      profileDir: options.userDataDir,
      headless: options.headless,
      updateKernelBeforeLaunch: options.updateKernelBeforeLaunch,
    })
    const { context } = session
    const page = context.pages()[0] ?? await context.newPage()

    if (options.label) {
      const labelArg = labelOptions(options.label, options.color)
      if (labelArg) {
        await context.addInitScript(installLabel, labelArg)
        for (const p of context.pages()) await p.evaluate(installLabel, labelArg).catch(() => {})
      }
    }

    const sessionId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    this.activeSessions.set(sessionId, { session, profileName: options.profile })

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

  /**
   * Report which installed kernels have a newer build published. One entry per
   * installed kernel; check `.updateAvailable`. Offline, nothing is flagged.
   */
  async checkKernelUpdates(): Promise<KernelUpdateStatus[]> {
    try {
      registerKernelVersions(await fetchRemoteKernelVersions())
    } catch {
      /* offline: compare against whatever is known locally */
    }
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

  /**
   * Update installed kernels to their latest published build, or just `version`
   * when given. Returns the versions actually updated.
   */
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

import fs from 'node:fs'
import { AntiDetectBrowser, resolveSyncMode } from './browser'
import {
  claimManagedProxy, createUserProxy, deleteProfile, getOrCreateProfile, getProfile,
  getProfileArchiveUploadUrl, proxyConfigToUrl, swapManagedProxy, syncPullUserProxies, updateProfile,
} from './api'
import {
  exportProfileArchiveAsync, getLicenseToken, readProfileMeta, resolveProfileDirSync, uploadProfileCache,
  writeProfileMeta, type ProfileMeta,
} from './engine'
import { ensureCacheDir } from './profile'
import type { AntiDetectBrowserOptions, LaunchOptions, LaunchResult, SyncedProfile } from './types'
import {
  planBinding, proxyLibraryClientId, proxyUrlToConfig, type BindingPlan, type ProxyBinding, type ProxyInput,
} from './proxy-binding'

export type SessionOptions = Pick<LaunchOptions,
  'headless' | 'label' | 'focusWindow' | 'liveView' | 'updateKernelBeforeLaunch'>

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export interface ProfileOptions extends AntiDetectBrowserOptions {
  name: string
  proxy?: ProxyInput
  sync?: boolean
  temporary?: boolean
  tags?: string[]
  group?: string
  userDataDir?: string
  deviceType?: 'desktop' | 'android'
  realFingerprint?: boolean
}

/**
 * Rejected both at compile time (`SessionOptions` omits them) and here at
 * runtime, for JavaScript callers with no type checker to catch it. A
 * profile's proxy travels with the profile, not with a single launch.
 */
const SESSION_ONLY = ['proxy', 'proxyId', 'profile', 'sync', 'temporary', 'tags', 'group'] as const

const SESSION_ONLY_HINT: Record<(typeof SESSION_ONLY)[number], string> = {
  proxy: "A profile's proxy comes from its binding - set it with profile({ proxy }) or p.setProxy().",
  proxyId: "A profile's proxy comes from its binding - set it with profile({ proxy }) or p.setProxy().",
  profile: "A handle's name is fixed - create a new one with profile({ name }) instead.",
  sync: "A profile's sync state lives on the handle - set it with profile({ sync }), " +
    'p.enableSync(), or p.dangerousDisconnectSync().',
  temporary: "A handle's temporary flag is fixed - create a new one with profile({ temporary: true }) instead.",
  tags: "A profile's tags live on the handle - set them with profile({ tags }) or p.setTags().",
  group: "A profile's group lives on the handle - set it with profile({ group }) or p.setGroup().",
}

export class ProfileHandle {
  readonly name: string

  private _id: string
  private _synced: boolean
  private _proxy: ProxyBinding | undefined
  /** Live sync intent, independent of the frozen constructor option -
   *  `enableSync()`/`dangerousDisconnectSync()` flip it so a later `launch()`
   *  reflects what the handle is now, not what it was asked for at birth. */
  private syncIntent: boolean | undefined
  private group: string | undefined
  private tags: string[]
  private readonly browser: AntiDetectBrowser
  private readonly options: ProfileOptions
  private readonly notify: (message: string) => void

  constructor(input: {
    options: ProfileOptions
    browser: AntiDetectBrowser
    id: string
    synced: boolean
    proxy: ProxyBinding | undefined
    group: string | undefined
    tags: string[]
  }) {
    this.options = input.options
    this.browser = input.browser
    this.name = input.options.name
    this._id = input.id
    this._synced = input.synced
    this._proxy = input.proxy
    this.syncIntent = input.options.sync
    this.group = input.group
    this.tags = input.tags
    this.notify = input.options.notify ?? ((m) => console.log(m))
  }

  /** Read-only from the outside - writing this to spoof sync state would let
   *  a caller send later calls down the wrong (cloud vs. local) path. */
  get id(): string {
    return this._id
  }

  /** Read-only from the outside, for the same reason as `id` - a caller
   *  writing this directly could redirect API calls to the wrong profile. */
  get synced(): boolean {
    return this._synced
  }

  /** Read-only, guarded the same way `id`/`synced` are - a caller overwriting
   *  it would desync the value `launch()`/`export()` actually use. */
  get proxy(): ProxyBinding | undefined {
    return this._proxy
  }

  /**
   * Re-resolved by name on every access rather than cached from `profile()`'s
   * one-time local lookup: `openProfile`'s own (async, server-aware) directory
   * resolution renames this directory to the server id on essentially every
   * synced profile's first `launch()` - a cached path would silently point at
   * a directory that no longer exists. An explicit `userDataDir` is pinned
   * and never renamed by `openProfile`, so it short-circuits the lookup.
   */
  get dir(): string {
    if (this.options.userDataDir) return this.options.userDataDir
    return resolveProfileDirSync(
      ensureCacheDir(this.options.cacheDir), this.name, { temporary: this.options.temporary },
    ).dir
  }

  async launch(options: SessionOptions = {}): Promise<LaunchResult> {
    for (const key of SESSION_ONLY) {
      if (key in options) {
        throw new Error(`"${key}" is not a session option. ${SESSION_ONLY_HINT[key]}`)
      }
    }
    const managed = this._proxy?.kind === 'managed' ? this._proxy.managedProxyId : undefined
    const url = this._proxy?.kind === 'url' ? this._proxy.url : await this.bindingUrl()
    return this.browser.launch({
      ...options,
      profile: this.name,
      sync: this.syncIntent,
      temporary: this.options.temporary,
      // Inert in practice: profile() already resolved the row (and reconciled
      // group/tags against it), so browser.launch()'s own create-only write
      // never gets a chance to see anything but an already-matching value.
      // Forwarded as current state (not the constructor's frozen options) so
      // a launch after setGroup()/setTags() reflects them, for symmetry with
      // `sync` above rather than as a working write path.
      tags: this.tags,
      group: this.group,
      userDataDir: this.options.userDataDir,
      deviceType: this.options.deviceType,
      realFingerprint: this.options.realFingerprint,
      ...(managed ? { proxyId: managed } : url ? { proxy: url } : {}),
    })
  }

  /**
   * Archives what is on disk right now - no implicit cloud download, so a
   * caller wanting the latest cloud state has to launch once first.
   */
  async export(filePath?: string): Promise<Buffer | string> {
    const buf = await exportProfileArchiveAsync(this.dir, {
      id: this.id,
      name: this.name,
      proxyUrl: await this.bindingUrl(),
      deviceType: this.options.deviceType,
      realFingerprint: this.options.realFingerprint,
    }, {
      // Only an encrypted profile uses any of this: it is converted on a copy
      // before packing, which needs its key, a kernel and a licence.
      key: this.options.key,
      server: this.options.server,
      cacheDir: ensureCacheDir(this.options.cacheDir),
    })
    if (!filePath) return buf
    fs.writeFileSync(filePath, buf)
    return filePath
  }

  async setProxy(next: ProxyInput): Promise<void> {
    await this.applyBinding(next)
  }

  async swapProxy(): Promise<void> {
    if (this._proxy?.kind !== 'managed') {
      throw new Error('swapProxy() only applies to a managed proxy. Bind one with { kind: "managed" } first.')
    }
    const swapped = await swapManagedProxy({
      key: this.options.key, server: this.options.server, proxyId: this._proxy.managedProxyId,
    })
    this._proxy = { kind: 'managed', managedProxyId: swapped.id }
    await this.persistBinding()
  }

  /**
   * Local -> cloud. Creating the row is not enough: without the data upload
   * the cloud copy is an empty shell, and another machine opens a blank
   * browser. `sameStringArray`/config.group compare against the freshly
   * created row the same way profile() reconciles it - the row may already
   * have existed with different values.
   */
  async enableSync(): Promise<void> {
    // Same rejection resolveSyncMode would throw for profile({ temporary: true,
    // sync: true }) - a temporary profile's directory is never meant to reach
    // the server, and enableSync() is exactly that reached from the other side.
    if (this.options.temporary) resolveSyncMode({ temporary: true, sync: true, licenseSync: false })
    if (this.synced) return
    const created = await getOrCreateProfile({
      key: this.options.key, server: this.options.server, name: this.name,
      tags: this.tags.length ? this.tags : undefined,
      config: this.group !== undefined ? { group: this.group } : undefined,
    })
    this._id = created.id
    this._synced = true

    if (!sameStringArray(created.tags ?? [], this.tags)) {
      await updateProfile({ key: this.options.key, server: this.options.server, id: this.id, tags: this.tags })
    }
    if ((created.config?.group ?? undefined) !== this.group) {
      await updateProfile({
        key: this.options.key, server: this.options.server, id: this.id,
        config: { ...(created.config ?? {}), group: this.group },
      })
    }

    // A url binding was machine-local; it has to become a library row to travel.
    if (this._proxy?.kind === 'url') {
      this._proxy = { kind: 'local', localProxyId: await this.pushToLibrary(this._proxy.url) }
    }
    await this.persistBinding()

    const putUrl = await getProfileArchiveUploadUrl({
      key: this.options.key, server: this.options.server, name: this.name,
    })
    if (putUrl) await uploadProfileCache(this.dir, putUrl)
    // The handle now behaves as if `sync: true` had been passed from the
    // start: a later launch() must not fall back to the frozen constructor
    // value, or the archive this call just uploaded never gets exercised
    // again (the exact "empty shell on another machine" this method exists
    // to prevent).
    this.syncIntent = true
  }

  /**
   * Irreversible: the cloud row and its archive go away, freeing the
   * cloud-sync slot. The local directory is untouched and stays launchable -
   * the proxy binding, group and tags are carried down into profile.json
   * first, read fresh from the server rather than trusted from memory, so the
   * profile keeps its identity after the row is gone.
   *
   * The pre-read tolerates a 404: a stale `synced` flag after a concurrent
   * delete from another machine, or a second call racing the first, must
   * still finish (falling back to whatever this handle already holds)
   * rather than get stuck permanently throwing. `deleteProfile` itself is
   * idempotent server-side (a tombstoned row still returns success), so only
   * the read needs this - a non-404 failure still propagates.
   */
  async dangerousDisconnectSync(): Promise<void> {
    if (!this.synced) return
    const current = await getProfile({ key: this.options.key, server: this.options.server, name: this.name })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('HTTP 404')) return undefined
        throw error
      })
    const proxy = current?.config?.proxy ?? this._proxy
    const group = current?.config?.group ?? this.group
    const tags = current?.tags ?? this.tags

    await deleteProfile({ key: this.options.key, server: this.options.server, name: this.name })

    this._synced = false
    this._proxy = proxy
    this.group = group
    this.tags = tags
    writeProfileMeta(this.dir, { ...this.readLocalMeta(), proxy, group, tags })
    // The row this handle used to point at is gone; a later launch() sending
    // `sync: true` (the frozen constructor value, if that is what was passed)
    // would ask browser.launch() to create-or-get it again, silently
    // recreating exactly what this call just deleted and re-consuming the
    // sync slot.
    this.syncIntent = false
  }

  getGroup(): string | undefined {
    return this.group
  }

  async setGroup(group: string | null): Promise<void> {
    const next = group === null ? undefined : group
    if (this.synced) {
      const current = await getProfile({ key: this.options.key, server: this.options.server, name: this.name })
      await updateProfile({
        key: this.options.key, server: this.options.server, id: this.id,
        config: { ...(current.config ?? {}), group: next },
      })
    } else {
      writeProfileMeta(this.dir, { ...this.readLocalMeta(), group: next })
    }
    this.group = next
  }

  getTags(): string[] {
    return this.tags
  }

  /**
   * Server-side, tags live only in the top-level `tags` column, never in
   * `ProfileConfig.tags` - that field belongs to the desktop app, and a
   * read-modify-write through it here would fight the desktop's own writes.
   */
  async setTags(tags: string[]): Promise<void> {
    if (this.synced) {
      await updateProfile({ key: this.options.key, server: this.options.server, id: this.id, tags })
    } else {
      writeProfileMeta(this.dir, { ...this.readLocalMeta(), tags })
    }
    this.tags = tags
  }

  private readLocalMeta(): ProfileMeta {
    return readProfileMeta(this.dir) ?? { id: this.id, name: this.name, origin: 'local' as const }
  }

  /**
   * The bound proxy as a url, needed to tell "is this the same proxy the
   * caller just passed" and to feed a library-backed binding to launch(). A
   * `local` binding only stores an id, so resolving it costs a proxy-library
   * pull - the managed and raw-url kinds are free.
   */
  private async bindingUrl(): Promise<string | undefined> {
    if (this._proxy?.kind === 'url') return this._proxy.url
    if (this._proxy?.kind !== 'local') return undefined
    const page = await syncPullUserProxies({ key: this.options.key, server: this.options.server })
    const row = page.proxies.find((p) => p.id === (this._proxy as { localProxyId: string }).localProxyId)
    return row?.config ? proxyConfigToUrl(row.config) : undefined
  }

  /**
   * Not on the public interface (spec §3) - `setProxy()` is the only exposed
   * way in. Kept reachable for `profile()`'s initial binding by routing
   * through `setProxy()` itself rather than calling this directly from
   * outside the class: TypeScript's `private` is enforced at the class
   * boundary, same-file or not, so there is no way to call this from the
   * factory function without either that route or losing real privacy.
   */
  private async applyBinding(input: ProxyInput): Promise<void> {
    const plan = planBinding(this._proxy, await this.bindingUrl(), input)
    if (plan.action === 'keep') return
    this._proxy = await this.resolvePlan(plan)
    await this.persistBinding()
  }

  private async resolvePlan(plan: Exclude<BindingPlan, { action: 'keep' }>): Promise<ProxyBinding | undefined> {
    if (plan.action === 'clear') return undefined
    if (plan.action === 'claim') {
      const claimed = await claimManagedProxy({ key: this.options.key, server: this.options.server })
      return { kind: 'managed', managedProxyId: claimed.id }
    }
    if (plan.action === 'bindManaged') {
      return { kind: 'managed', managedProxyId: plan.managedProxyId }
    }
    if (!this.synced) return { kind: 'url', url: plan.url }
    try {
      return { kind: 'local', localProxyId: await this.pushToLibrary(plan.url) }
    } catch (error) {
      // The library is a paid feature. A downgraded account still gets a
      // working browser here - the binding just stops travelling to other
      // machines.
      if (error instanceof Error && error.message.includes('HTTP 403')) {
        this.notify(
          `Proxy for "${this.name}" is stored on this machine only: the proxy library needs a paid plan.`,
        )
        return { kind: 'url', url: plan.url }
      }
      throw error
    }
  }

  /**
   * The deterministic client id is the dedup: a colliding create means the
   * row is already there, and the id we would have used is the one to
   * reference. No extra GET needed.
   */
  private async pushToLibrary(url: string): Promise<string> {
    const config = proxyUrlToConfig(url)
    const id = proxyLibraryClientId(config)
    try {
      const created = await createUserProxy({ key: this.options.key, server: this.options.server, id, config })
      return created.id
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('HTTP 409')) return id
      throw error
    }
  }

  private async persistBinding(): Promise<void> {
    // A url binding has no place in the cloud config (SyncedProxyRef has no
    // url form), so it lands locally even on a synced profile - that is the
    // 403 fallback above, and the only case where the two storages disagree.
    if (this.synced && this._proxy?.kind !== 'url') {
      const current = await getProfile({ key: this.options.key, server: this.options.server, name: this.name })
      const proxy = this._proxy?.kind === 'managed' || this._proxy?.kind === 'local' ? this._proxy : undefined
      await updateProfile({
        key: this.options.key, server: this.options.server, id: this.id,
        config: { ...(current.config ?? {}), proxy },
      })
      return
    }
    writeProfileMeta(this.dir, { ...this.readLocalMeta(), proxy: this._proxy })
  }
}

export async function profile(options: ProfileOptions): Promise<ProfileHandle> {
  if (!options.key) throw new Error('API key is required. Pass { key: "your-api-key" } to profile().')
  if (!options.name) throw new Error('The "name" option is required. Pass a profile name to profile().')

  const temporary = options.temporary ?? false

  // Resolved before any network call, so a rejected combination costs nothing.
  const offline = temporary || options.sync === false
  const licenseSync = offline
    ? false
    : (await getLicenseToken({ key: options.key, server: options.server })).sync
  const syncMode = resolveSyncMode({ temporary, sync: options.sync, licenseSync })

  const cacheDir = ensureCacheDir(options.cacheDir)
  const resolved = resolveProfileDirSync(cacheDir, options.name, { temporary })
  const dir = options.userDataDir ?? resolved.dir

  let synced = false
  let server: SyncedProfile | undefined
  if (syncMode === 'create') {
    server = await getOrCreateProfile({
      key: options.key, server: options.server, name: options.name, tags: options.tags,
      config: options.group !== undefined ? { group: options.group } : undefined,
    })
    synced = true
  } else if (syncMode === 'existing') {
    server = await getProfile({ key: options.key, server: options.server, name: options.name })
      .catch(() => undefined)
    synced = !!server
  }

  // getOrCreateProfile is GET-first: an already-existing row is returned as-is,
  // so a group/tags passed here would otherwise be silently dropped whenever
  // the profile already exists on the server. Reconciled the same way proxy
  // bindings are - passed and different from current -> write; passed and
  // already equal -> no request. The equality check is mandatory: without it
  // every profile() call carrying a group would PUT even when nothing changed.
  // The written value, not the write's response, becomes the handle's state -
  // same as setGroup/setTags, which never trust an echo back either.
  let tagsOverride: string[] | undefined
  let groupOverride: string | undefined
  if (synced && server) {
    if (options.tags !== undefined && !sameStringArray(server.tags ?? [], options.tags)) {
      await updateProfile({ key: options.key, server: options.server, id: server.id, tags: options.tags })
      tagsOverride = options.tags
    }
    if (options.group !== undefined && server.config?.group !== options.group) {
      await updateProfile({
        key: options.key, server: options.server, id: server.id,
        config: { ...(server.config ?? {}), group: options.group },
      })
      groupOverride = options.group
    }
  }

  // Local storage for group/tags mirrors the synced create path: passed ->
  // written (whole-value replace); omitted -> whatever is already there.
  let localMeta = synced ? undefined : readProfileMeta(dir)
  if (!synced && (options.group !== undefined || options.tags !== undefined)) {
    localMeta = {
      ...(localMeta ?? { id: resolved.id, name: options.name, origin: 'local' as const }),
      ...(options.group !== undefined ? { group: options.group } : {}),
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
    }
    writeProfileMeta(dir, localMeta)
  }

  const handle = new ProfileHandle({
    options,
    browser: new AntiDetectBrowser(options),
    id: server?.id ?? resolved.id,
    synced,
    proxy: synced ? server?.config?.proxy : localMeta?.proxy,
    group: synced ? (groupOverride ?? server?.config?.group) : localMeta?.group,
    tags: synced ? (tagsOverride ?? server?.tags ?? []) : (localMeta?.tags ?? []),
  })
  // `undefined` is `applyBinding`'s own "keep" case - skipping the call
  // entirely for it is what lets that method stay genuinely private (see its
  // doc comment) instead of needing to be reachable from this factory.
  if (options.proxy !== undefined) await handle.setProxy(options.proxy)
  return handle
}

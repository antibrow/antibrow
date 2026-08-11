import type { Page, BrowserContext } from 'playwright-core'

export interface AntiDetectBrowserOptions {
  /** API key for the service */
  key: string
  /** Server URL, defaults to SaaS address */
  server?: string
  /** Local cache directory for kernel and profile data */
  cacheDir?: string
  /** Live view relay WebSocket URL */
  relayUrl?: string
  /** Relay host used for managed proxies. */
  proxyHost?: string
  /**
   * Sink for one-off advisory notices. Defaults to `console.log`; the MCP server
   * redirects it to stderr so notices cannot corrupt the JSON-RPC channel.
   */
  notify?: (message: string) => void
  /**
   * Default for `launch({ temporary })`. Temporary profiles live in their own
   * directory tree, so profile managers never enumerate throwaway runs.
   */
  temporary?: boolean
}

export interface LaunchOptions {
  /** Tags stored on the profile metadata when auto-creating it */
  tags?: string[]
  /** Proxy address: protocol://user:pass@host:port */
  proxy?: string
  /** Managed proxy id. When set, the SDK activates it and injects it, taking precedence over `proxy`. */
  proxyId?: string
  /** Profile name for persistent browser data */
  profile: string
  /**
   * Text the kernel draws in front of the address bar, so several open windows
   * are tellable apart. Defaults to the profile name.
   */
  label?: string
  /**
   * @deprecated No longer has any effect. It used to colour a label injected
   * into the page; the label is drawn by the kernel now, and the kernel's
   * switch takes no colour.
   */
  color?: string
  /** Headless mode, default false */
  headless?: boolean
  /**
   * Whether the new window takes focus. Default true. `false` opens it behind
   * whatever is in front, so a launch does not interrupt what you are doing -
   * the window is still there, just not focused. Needs a kernel build that
   * carries the switch; older ones focus the window either way.
   */
  focusWindow?: boolean
  /** User data directory for this local profile */
  userDataDir?: string
  /** Enable live view streaming to the dashboard */
  liveView?: boolean | LiveViewStreamOptions
  /** Update this profile's kernel before launching, if a newer build exists. */
  updateKernelBeforeLaunch?: boolean
  /**
   * Simulate an Android phone running on this desktop/server, instead of a
   * desktop browser. Applies only when the profile is first created; an
   * existing profile keeps the device type frozen in its own persona.
   */
  deviceType?: 'desktop' | 'android'
  /**
   * Draw this profile's identity from the Captured-machine fingerprint library
   * instead of generating one (paid plans; the server rejects free-plan
   * requests). Applies only when the profile is first created.
   */
  realFingerprint?: boolean
  /** Overrides the constructor's `temporary`. Temporary profiles are local-only. */
  temporary?: boolean
  /**
   * Cloud sync for this profile. Left unset, the profile syncs only if the
   * server already knows the name - a launch never creates a cloud profile by
   * itself. `true` creates it; `false` keeps everything local.
   */
  sync?: boolean
}

export interface LiveViewStreamOptions {
  /** JPEG quality (1-100), default 60 */
  quality?: number
  /** Max frame width, default 1280 */
  maxWidth?: number
  /** Max frame height, default 720 */
  maxHeight?: number
  /** Send every Nth frame, default 2 */
  everyNthFrame?: number
}

export interface LaunchResult {
  /** Browser-like handle with close(). */
  browser: { close(): Promise<void> }
  /** Playwright BrowserContext connected to engine over CDP */
  context: BrowserContext
  /** First Page instance */
  page: Page
  /** Profile directory path */
  profileDir: string
  /** Live view info (only present when Live View is enabled) */
  liveView?: { sessionKey: string; viewUrl: string }
}

/** Reference to a proxy carried in a synced profile config. */
export type SyncedProxyRef =
  | { kind: 'managed'; managedProxyId: string }
  | { kind: 'local'; localProxyId: string }

/** Portable profile config stored server-side; the identity stays local. */
export interface ProfileConfig {
  group?: string
  label?: string
  color?: string
  note?: string
  tags?: string[]
  proxy?: SyncedProxyRef
  /** Per-profile kernel switches. */
  canvasNoise?: boolean
  apiLog?: import('./engine/persona').ApiLogMode
  webauthnCapture?: boolean
  /** Fixed when the profile was created; travels so every machine shows the
   *  same identity before the profile is ever launched there. */
  deviceType?: import('./engine/persona').DeviceType
  realFingerprint?: boolean
}

/** Wire shape returned by the profile sync endpoints. */
export interface SyncedProfile {
  id: string
  name: string
  config: ProfileConfig | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** Delta-pull envelope from GET /api/v1/profiles. */
export interface ProfileSyncPage {
  profiles: SyncedProfile[]
  serverTime: string
}

export interface McpSession {
  id: string
  context: BrowserContext
  page: Page
  profileDir: string
  profileName: string
  createdAt: Date
  liveViewStream?: import('./liveview').LiveViewStream
}

/** A user's own proxy definition. */
export interface ProxyConfig {
  type: 'SOCKS5' | 'HTTP' | 'SSH'
  host: string
  port: number
  username?: string
  password?: string
  label?: string
  country?: string
}

/** Wire shape from the proxy-library sync endpoints. */
export interface SyncedProxy {
  id: string
  config: ProxyConfig | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** Delta-pull envelope from GET /api/v1/proxy-library. */
export interface ProxySyncPage {
  proxies: SyncedProxy[]
  serverTime: string
}


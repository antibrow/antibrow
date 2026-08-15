import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ANDROID_FALLBACK_DEVICES } from './android-devices'
import type { RealDevice } from './devices'
import { normalizeKernelVersion } from './downloader'

const GPUS = [
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.9316)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.4577)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3699)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3179)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.12027.9001)'],
] as const

// Mainstream Windows laptop resolutions; dpr is never 1.
const SCREENS: readonly [number, number, number][] = [
  [1536, 864, 1.25],
  [1280, 720, 1.5],
  [1707, 960, 1.5],
  [1280, 800, 1.5],
  [1440, 900, 1.25],
]

const HW_CONCURRENCY = [4, 8, 12, 16] as const
const DEVICE_MEMORY = [8, 16] as const

function randHex16(): string {
  return randomBytes(8).toString('hex')
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

export type DeviceType = 'desktop' | 'android'

/**
 * Facts lifted verbatim from one real device. Every entry maps to an existing
 * kernel config channel, so this block swaps invented values for that machine's
 * real ones without needing kernel changes. An absent entry falls back to the
 * generated value, which is why every field is optional - and why the three
 * UA-CH strings (`uaArchitecture`, `uaBitness`, `uaModel`) and the `uaMobile`
 * boolean are optional rather than defaulted: `""` and `false` are real values
 * on mobile, distinct from "not captured".
 */
export interface CapturedFacts {
  platform?: string
  vendor?: string
  maxTouchPoints?: number
  colorDepth?: number
  availW?: number
  availH?: number
  prefersColorScheme?: string
  connectionEffectiveType?: string
  connectionRtt?: number
  connectionDownlink?: number
  connectionType?: string
  /** `<= 0` is the wire encoding for Infinity, which JSON cannot express. */
  connectionDownlinkMax?: number
  uaPlatform?: string
  uaPlatformVersion?: string
  uaArchitecture?: string
  uaBitness?: string
  uaModel?: string
  uaMobile?: boolean
  audioSampleRate?: number
  audioMaxChannelCount?: number
  fonts?: string[]
  webglExtensions?: string[]
}

export interface Persona {
  seed: string
  canvasSeed: string
  audioSeed: string
  domrectSeed: string
  chromeMajor: number
  /** Chrome major only, e.g. "150" — see `normalizeKernelVersion`. */
  kernelVersion: string
  ua: string
  hardwareConcurrency: number
  deviceMemory: number
  screenW: number
  screenH: number
  devicePixelRatio: number
  gpuVendor: string
  gpuRenderer: string
  languages: string[]
  /** Fallback timezone; overridden at launch from proxy GeoIP. */
  timezone: string
  /**
   * A real device's WebGL report, replayed verbatim so the GL facts stay
   * anchored to one machine. When absent the kernel synthesizes the report
   * from the GPU strings alone.
   */
  capturedWebgl?: Record<string, unknown>
  /** Absent means desktop, so existing profiles keep their current behaviour. */
  deviceType?: DeviceType
  androidModel?: string
  androidOsMajor?: number
  captured?: CapturedFacts
}

/**
 * JS-API access log. `off` writes nothing, `curated` logs the built-in
 * fingerprint-related allowlist, `all` logs every access.
 */
export type ApiLogMode = 'off' | 'curated' | 'all'

export const API_LOG_FILE = 'fp-api-log.jsonl'

/** Android majors we vary the bundled devices across; the corpus rows sit at 15-16. */
const ANDROID_OS_MAJORS = [13, 14, 15, 16] as const

/**
 * Flatten one device row into the persona fields that replay it. The corpus
 * spells its WebGL keys in camelCase while the replay channel expects the
 * capture tool's uppercase names, so this is also where that translation lives.
 */
export function deviceToPersonaParts(
  device: RealDevice,
  chromeMajor: number,
  /**
   * Override the Android major. Used only for the bundled rows, to keep every
   * free-tier profile from reporting one system version. A library row keeps
   * its own - `device.osMajor` is the UA string's frozen 10 and would clobber
   * the real version that lives in uaData.platformVersion.
   */
  osMajorOverride?: number,
): Partial<Persona> {
  const webgl: Record<string, unknown> = {}
  if (device.webgl.version) webgl.VERSION = device.webgl.version
  if (device.webgl.shadingLanguageVersion) webgl.SHADING_LANGUAGE_VERSION = device.webgl.shadingLanguageVersion
  if (device.webgl.version2) webgl.VERSION2 = device.webgl.version2
  if (device.webgl.shadingLanguageVersion2) webgl.SHADING_LANGUAGE_VERSION2 = device.webgl.shadingLanguageVersion2
  if (device.webgl.params) webgl.params = device.webgl.params
  if (device.webgl.shaderPrecision) webgl.shaderPrecision = device.webgl.shaderPrecision

  const android = device.os === 'android'
  const ua = device.navigator.uaData ?? {}
  const platformVersion = osMajorOverride != null ? `${osMajorOverride}.0.0` : ua.platformVersion
  const major = osMajorOverride ?? (parseInt(platformVersion ?? '', 10) || undefined)
  const captured: CapturedFacts = {
    platform: device.navigator.platform,
    vendor: device.navigator.vendor,
    maxTouchPoints: device.navigator.maxTouchPoints,
    colorDepth: device.screen.colorDepth,
    availW: device.screen.availWidth,
    availH: device.screen.availHeight,
    connectionEffectiveType: device.connection?.effectiveType,
    connectionType: device.connection?.type,
    // `RealDevice` carries `null` for "no cap reported"; `CapturedFacts` only
    // knows "not captured" (undefined), so null collapses into that.
    connectionDownlinkMax: device.connection?.downlinkMax ?? undefined,
    uaPlatform: ua.platform,
    uaPlatformVersion: platformVersion,
    uaArchitecture: ua.architecture,
    uaBitness: ua.bitness,
    uaModel: ua.model,
    uaMobile: ua.mobile,
    audioSampleRate: device.audio?.sampleRate,
    audioMaxChannelCount: device.audio?.maxChannelCount,
    fonts: device.fonts,
    webglExtensions: device.webgl.extensions,
  }
  // rtt and downlink stay generated: they follow the proxy we measure at launch,
  // not the machine the corpus came off.

  return {
    deviceType: android ? 'android' : 'desktop',
    androidModel: android ? device.model : undefined,
    androidOsMajor: android ? major : undefined,
    ua: device.ua.replace('{major}', String(chromeMajor)),
    hardwareConcurrency: device.navigator.hardwareConcurrency,
    deviceMemory: device.navigator.deviceMemory,
    screenW: device.screen.width,
    screenH: device.screen.height,
    devicePixelRatio: device.screen.devicePixelRatio,
    gpuVendor: device.webgl.unmaskedVendor,
    gpuRenderer: device.webgl.unmaskedRenderer,
    captured,
    capturedWebgl: Object.keys(webgl).length > 0 ? webgl : undefined,
  } as Partial<Persona>
}

export interface PersonaInit {
  deviceType?: DeviceType
  /** A device row from the library; absent means use the bundled table. */
  device?: RealDevice
}

export function generatePersona(chromeMajor = 149, kernelVersion = '149', init?: PersonaInit): Persona {
  const wantsAndroid = init?.deviceType === 'android' || init?.device?.os === 'android'
  const device = init?.device ?? (wantsAndroid ? pick(ANDROID_FALLBACK_DEVICES) : undefined)
  if (device) {
    const base = generateDesktopPersona(chromeMajor, kernelVersion)
    // The bundled rows are fixed, so vary the Android major to keep free-tier
    // profiles from all reporting one system version. A library row keeps its
    // own captured version.
    const osMajorOverride = init?.device ? undefined : pick(ANDROID_OS_MAJORS)
    const parts = deviceToPersonaParts(device, chromeMajor, osMajorOverride)
    for (const [key, value] of Object.entries(parts)) {
      if (value !== undefined) (base as unknown as Record<string, unknown>)[key] = value
    }
    return base
  }
  return generateDesktopPersona(chromeMajor, kernelVersion)
}

function generateDesktopPersona(chromeMajor: number, kernelVersion: string): Persona {
  const [screenW, screenH, devicePixelRatio] = pick(SCREENS)
  const [gpuVendor, gpuRenderer] = pick(GPUS)
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`
  return {
    seed: randHex16(),
    canvasSeed: randHex16(),
    audioSeed: randHex16(),
    domrectSeed: randHex16(),
    chromeMajor,
    kernelVersion,
    ua,
    hardwareConcurrency: pick(HW_CONCURRENCY),
    deviceMemory: pick(DEVICE_MEMORY),
    screenW,
    screenH,
    devicePixelRatio,
    gpuVendor,
    gpuRenderer,
    languages: ['en-US', 'en'],
    timezone: 'America/Los_Angeles',
  }
}

/**
 * Translate a captured `webgl` blob into the fields the kernel replays. Each
 * `shaderPrecision` triple becomes a "min,max,precision" string; anything
 * malformed is dropped rather than passed on.
 */
function capturedWebglConfig(captured: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!captured) return {}
  const out: Record<string, unknown> = {}
  if (typeof captured.VERSION === 'string') out.version = captured.VERSION
  if (typeof captured.SHADING_LANGUAGE_VERSION === 'string') out.shadingLanguageVersion = captured.SHADING_LANGUAGE_VERSION
  // The webgl2 context reports its own version pair. Replaying only the webgl1
  // half leaves GL1 telling the truth while GL2 keeps the synthesized strings.
  if (typeof captured.VERSION2 === 'string') out.version2 = captured.VERSION2
  if (typeof captured.SHADING_LANGUAGE_VERSION2 === 'string') out.shadingLanguageVersion2 = captured.SHADING_LANGUAGE_VERSION2
  if (captured.params && typeof captured.params === 'object') out.params = captured.params
  if (captured.shaderPrecision && typeof captured.shaderPrecision === 'object') {
    const precision: Record<string, string> = {}
    for (const [key, value] of Object.entries(captured.shaderPrecision as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number')) {
        precision[key] = value.join(',')
      }
    }
    if (Object.keys(precision).length > 0) out.shaderPrecision = precision
  }
  return out
}

/**
 * WebGPU identity derived from the WebGL renderer, so `navigator.gpu` names the
 * same GPU the WebGL unmasked strings do: a cross-API mismatch is exactly what
 * fingerprint scanners look for. An empty vendor means "leave it alone".
 */
function webgpuIdentity(renderer: string): { vendor: string; architecture: string } {
  const r = renderer.toLowerCase()
  if (r.includes('nvidia')) return { vendor: 'nvidia', architecture: '' }
  if (r.includes('amd') || r.includes('radeon')) return { vendor: 'amd', architecture: 'rdna-3' }
  if (r.includes('intel')) {
    let architecture: string
    if (r.includes('iris') && r.includes('xe')) architecture = 'gen-12lp'
    else if (r.includes('arc')) architecture = 'xe-lpg'
    else if (r.includes('uhd') || r.includes('hd graphics')) architecture = 'gen-9'
    else architecture = 'gen-12lp'
    return { vendor: 'intel', architecture }
  }
  return { vendor: '', architecture: '' }
}

/**
 * Chromium's http-RTT cut-offs for navigator.connection.effectiveType. Copied
 * from net/nqe/network_quality_estimator_params.h's
 * kHttpRttEffectiveConnectionTypeThresholds (SLOW_2G 2010, 2G 1420, 3G 272 -
 * enum order is UNKNOWN, OFFLINE, SLOW_2G, 2G, 3G, 4G) and treated as
 * approximate: what matters is that the trio we report is internally
 * consistent, not that it matches one specific Chrome build to the
 * millisecond.
 */
export const ECT_RTT_THRESHOLDS = { fourG: 272, threeG: 1420, twoG: 2010 } as const

/**
 * Build a self-consistent navigator.connection. Chrome rounds rtt to 25ms and
 * downlink to 25kbps (0.025Mbps) and derives effectiveType from rtt, so a
 * mismatched trio ('4g' with rtt 800, '3g' with 10Mbps) is a contradiction
 * rather than camouflage. rtt comes from the proxy probe when there is one: a
 * site that measures latency itself then agrees with what we report.
 */
export function deriveConnection(
  seed: string,
  rttMs?: number,
): { effectiveType: string; rtt: number; downlink: number } {
  const seedSum = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const measured = typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0
  // Unmeasured (no proxy, or the lookup failed): stay under the 4g threshold so
  // the trio holds, but vary per persona - this used to be one global constant.
  const raw = measured ? rttMs : 50 + (seedSum % 9) * 25
  const rtt = Math.min(3000, Math.max(25, Math.round(raw / 25) * 25))
  const effectiveType =
    rtt < ECT_RTT_THRESHOLDS.fourG ? '4g'
      : rtt < ECT_RTT_THRESHOLDS.threeG ? '3g'
        : rtt < ECT_RTT_THRESHOLDS.twoG ? '2g'
          : 'slow-2g'
  // Bandwidth is too expensive to measure on the launch path, so it stays
  // seed-derived - but capped by effectiveType so the pair agrees.
  const [minDl, maxDl] = effectiveType === '4g' ? [1, 10] : [0.4, 1.5]
  const steps = Math.round((maxDl - minDl) / 0.025)
  const downlink = Math.round((minDl + (seedSum % (steps + 1)) * 0.025) * 1000) / 1000
  return { effectiveType, rtt, downlink }
}

// `allow` is a whitelist over the kernel's probeable font set - left empty it
// hides nothing, and every host font (macOS/Linux system fonts on a
// non-Windows host, or the AOSP set on Android) stays enumerable.
const WINDOWS_ALLOW_FONTS = [
  'Arial',
  'Arial Black',
  'Bahnschrift',
  'Calibri',
  'Cambria',
  'Cambria Math',
  'Candara',
  'Comic Sans MS',
  'Consolas',
  'Constantia',
  'Corbel',
  'Courier New',
  'Ebrima',
  'Franklin Gothic Medium',
  'Gabriola',
  'Gadugi',
  'Georgia',
  'Impact',
  'Ink Free',
  'Javanese Text',
  'Leelawadee UI',
  'Lucida Console',
  'Lucida Sans Unicode',
  'MV Boli',
  'Marlett',
  'Microsoft Sans Serif',
  'Palatino Linotype',
  'Segoe Print',
  'Segoe Script',
  'Segoe UI',
  'Segoe UI Emoji',
  'Segoe UI Symbol',
  'Sitka',
  'Sylfaen',
  'Symbol',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'Webdings',
  'Wingdings',
]

// The stock AOSP family names. Known gap: no desktop host ships Roboto or Noto,
// and an allow-list only subtracts - it cannot conjure a font. What it does buy
// is keeping host-only families (Segoe UI, Helvetica Neue, Menlo) out of the
// enumerable set. A replayed device overrides this with what that phone really
// resolved, which on Android is the alias set (Arial, Helvetica, ...).
const ANDROID_ALLOW_FONTS = [
  'Roboto', 'Roboto Condensed', 'Roboto Mono', 'Noto Sans', 'Noto Serif',
  'Noto Sans Mono', 'Noto Color Emoji', 'Droid Sans Mono',
  'Carrois Gothic SC', 'Coming Soon', 'Cutive Mono', 'Dancing Script',
]

/** Per-profile kernel behaviour that is not part of the identity. */
export interface FpConfigSettings {
  /**
   * Canvas/WebGL readback noise. Absent/true = noise. false reports the real
   * hardware pixels, so every profile on this machine shares one canvas hash
   * but scanners that flag any perturbation are satisfied.
   */
  canvasNoise?: boolean
  apiLog?: ApiLogMode
  /** Where the kernel writes the API log; required unless the mode is 'off'. */
  apiLogPath?: string
  /** Measured proxy round-trip; drives the whole connection trio. */
  rttMs?: number
}

/** Serialize persona to the fp-config.json schema expected by the kernel. */
export function personaToFpConfig(
  persona: Persona,
  opts: { label: string; timezone: string; publicIp?: string } & FpConfigSettings,
): Record<string, unknown> {
  const android = persona.deviceType === 'android'
  // Android has no taskbar; the real avail size arrives via `captured` anyway.
  const availH = android ? persona.screenH : persona.screenH - 48
  const webrtc = opts.publicIp
    ? { mode: 'passthrough', publicIp: opts.publicIp }
    : { mode: 'disable' }
  // Deterministic colour scheme from the seed.
  const seedSum = persona.seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const colorScheme = seedSum % 10 < 7 ? 'light' : 'dark'
  const webgl: Record<string, unknown> = {
    unmaskedVendor: persona.gpuVendor,
    unmaskedRenderer: persona.gpuRenderer,
    ...capturedWebglConfig(persona.capturedWebgl),
  }
  const canvas: Record<string, unknown> = { seed: persona.canvasSeed }
  // Only emitted when noise is explicitly off; the kernel already defaults on.
  if (opts.canvasNoise === false) {
    webgl.mode = 'off'
    canvas.mode = 'off'
  }
  const gpu = webgpuIdentity(persona.gpuRenderer)
  const webgpu = gpu.vendor ? { vendor: gpu.vendor, architecture: gpu.architecture } : {}
  const apiLog = opts.apiLog ?? 'off'
  const navPlatform = android ? 'Linux armv81' : 'Win32'
  const maxTouchPoints = android ? 5 : 0
  const uaData: Record<string, unknown> = android
    ? {
        platform: 'Android',
        platformVersion: `${persona.androidOsMajor ?? 15}.0.0`,
        // Empty is the real value here, not "unconfigured": mobile Chrome sends
        // empty Arch and Bitness hints. Kernels that treat empty as unset fall
        // back to the host and leak x86/64, which is why an Android profile
        // pins a kernel build.
        architecture: '',
        bitness: '',
        wow64: false,
        model: persona.androidModel ?? '',
        // Low entropy, sent on every navigation. A UA string that says Android
        // beside a false mobile bit is a one-line contradiction.
        mobile: true,
      }
    : {
        platform: 'Windows',
        platformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        wow64: false,
        model: '',
      }
  const uiFont = android ? 'Roboto' : 'Segoe UI'
  const genericFonts = android
    ? {
        standard: 'Roboto',
        serif: 'Noto Serif',
        sansSerif: 'Roboto',
        cursive: 'Dancing Script',
        fantasy: 'Roboto',
        monospace: 'Droid Sans Mono,Noto Sans Mono',
        math: 'Noto Serif',
      }
    : {
        standard: 'Times New Roman',
        serif: 'Times New Roman',
        sansSerif: 'Arial',
        cursive: 'Comic Sans MS',
        fantasy: 'Impact',
        monospace: 'Consolas,Courier New',
        math: 'Cambria Math,Times New Roman',
      }
  const allowFonts = android ? ANDROID_ALLOW_FONTS : WINDOWS_ALLOW_FONTS
  const config: Record<string, unknown> = {
    version: 1,
    seed: persona.seed,
    label: opts.label,
    timezone: opts.timezone,
    navigator: {
      userAgent: persona.ua,
      platform: navPlatform,
      vendor: 'Google Inc.',
      language: persona.languages[0] ?? 'en-US',
      languages: persona.languages,
      hardwareConcurrency: persona.hardwareConcurrency,
      deviceMemory: persona.deviceMemory,
      maxTouchPoints,
      // Every UA-CH key must be listed: an omitted one falls back to the real
      // host, which is how a Windows persona used to leak the host OS. Two
      // naming traps: `platform` is "Windows" (not navigator.platform's "Win32")
      // and `architecture` is "x86" even on x64 - `bitness` carries the 64.
      uaData,
    },
    screen: {
      width: persona.screenW,
      height: persona.screenH,
      availWidth: persona.screenW,
      availHeight: availH,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: persona.devicePixelRatio,
    },
    webgl,
    webgpu,
    canvas,
    audio: { seed: persona.audioSeed },
    domrect: { seed: persona.domrectSeed },
    webrtc,
    connection: deriveConnection(persona.seed, opts.rttMs),
    prefersColorScheme: colorScheme,
    // `generic` maps the five CSS generic families plus 'standard' so they
    // resolve to a platform font instead of falling through to the host's own
    // generic-family settings. monospace and math list comma-separated
    // fallbacks so a host missing the first still resolves to a distinct,
    // non-host font rather than its own default.
    fonts: {
      uiFont,
      keepCjk: 0,
      block: [],
      allow: allowFonts,
      generic: genericFonts,
    },
    apilog: { enabled: apiLog !== 'off', mode: apiLog, path: opts.apiLogPath ?? '' },
  }
  if (android) {
    // Only Android writes this key. A desktop profile that suddenly grows one
    // would read as changed to the full-sync diff.
    config.device = {
      type: 'android',
      pointer: 'coarse',
      hover: 'none',
      viewport: 'mobile',
      orientation: 'portrait-primary',
      outerWidth: persona.screenW,
      outerHeight: persona.screenH,
    }
  }
  const cap = persona.captured
  if (cap) {
    const nav = config.navigator as Record<string, unknown>
    const uaData = nav.uaData as Record<string, unknown>
    const screen = config.screen as Record<string, unknown>
    if (cap.platform) nav.platform = cap.platform
    if (cap.vendor) nav.vendor = cap.vendor
    if (cap.maxTouchPoints != null) nav.maxTouchPoints = cap.maxTouchPoints
    if (cap.uaPlatform) uaData.platform = cap.uaPlatform
    if (cap.uaPlatformVersion) uaData.platformVersion = cap.uaPlatformVersion
    // Presence, not truthiness: "" is what mobile Chrome actually sends.
    if (cap.uaArchitecture !== undefined) uaData.architecture = cap.uaArchitecture
    if (cap.uaBitness !== undefined) uaData.bitness = cap.uaBitness
    if (cap.uaModel !== undefined) uaData.model = cap.uaModel
    if (cap.uaMobile !== undefined) uaData.mobile = cap.uaMobile
    if (cap.availW) screen.availWidth = cap.availW
    if (cap.availH) screen.availHeight = cap.availH
    if (cap.colorDepth) {
      screen.colorDepth = cap.colorDepth
      screen.pixelDepth = cap.colorDepth
    }
    if (cap.prefersColorScheme) config.prefersColorScheme = cap.prefersColorScheme
    const connection = config.connection as Record<string, unknown>
    if (cap.connectionEffectiveType) connection.effectiveType = cap.connectionEffectiveType
    if (cap.connectionRtt != null) connection.rtt = cap.connectionRtt
    if (cap.connectionDownlink != null) connection.downlink = cap.connectionDownlink
    if (cap.connectionType) connection.type = cap.connectionType
    if (cap.connectionDownlinkMax != null) connection.downlinkMax = cap.connectionDownlinkMax
    const audio = config.audio as Record<string, unknown>
    if (cap.audioSampleRate) audio.sampleRate = cap.audioSampleRate
    if (cap.audioMaxChannelCount) audio.maxChannelCount = cap.audioMaxChannelCount
    if (cap.fonts?.length) (config.fonts as Record<string, unknown>).allow = cap.fonts
    if (cap.webglExtensions?.length) webgl.extensions = { allow: cap.webglExtensions }
  }
  return config
}

const PERSONA_FILE = 'persona.json'

/** The persisted persona, or undefined when this profile has no identity yet.
 *  Never writes: callers that must not decide the identity use this. */
export function readPersona(profileDir: string): Persona | undefined {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(profileDir, PERSONA_FILE), 'utf8')) as Persona
    if (!p || typeof p !== 'object') return undefined
    // Profiles created before kernels went major-only carry a full version
    // string. Normalizing in memory only: the file rides the cloud archive, and
    // an older client on another machine still needs to resolve what it wrote.
    if (p.kernelVersion) p.kernelVersion = normalizeKernelVersion(p.kernelVersion)
    return p
  } catch {
    return undefined
  }
}

export function writePersona(profileDir: string, persona: Persona): void {
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, PERSONA_FILE), JSON.stringify(persona, null, 2), 'utf8')
}

/**
 * The same identity on another Chrome major. Only these three fields follow the
 * kernel version - every seed, the GPU, the screen and the captured facts are
 * version-independent, and re-rolling them would hand the site a brand new
 * device behind the same cookies.
 */
export function withKernelVersion(persona: Persona, version: string): Persona {
  const kernelVersion = normalizeKernelVersion(version)
  const chromeMajor = parseInt(kernelVersion, 10)
  if (!chromeMajor) throw new Error(`Malformed kernel version: ${version}`)
  return {
    ...persona,
    kernelVersion,
    chromeMajor,
    ua: persona.ua.replace(/Chrome\/\d+/, `Chrome/${chromeMajor}`),
  }
}

/** Load the persisted persona, or generate and persist a new one. */
export function loadOrGeneratePersona(profileDir: string, defaultKernelVersion?: string, init?: PersonaInit): Persona {
  const file = path.join(profileDir, PERSONA_FILE)
  const fallback = normalizeKernelVersion(defaultKernelVersion) || '149'
  if (fs.existsSync(file)) {
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Persona
      if (!p.kernelVersion) {
        p.kernelVersion = fallback
        fs.writeFileSync(file, JSON.stringify(p, null, 2))
      } else {
        p.kernelVersion = normalizeKernelVersion(p.kernelVersion)
      }
      return p
    } catch { /* corrupted: regenerate */ }
  }
  const chromeMajor = parseInt(fallback, 10) || 149
  const persona = generatePersona(chromeMajor, fallback, init)
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(persona, null, 2))
  return persona
}

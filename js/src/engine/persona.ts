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
    // The trio travels together or not at all - see deriveConnection.
    connectionEffectiveType: device.connection?.effectiveType,
    connectionRtt: device.connection?.rtt,
    connectionDownlink: device.connection?.downlink,
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
 * The two webgl2 keys are asymmetric with their webgl1 counterparts: the kernel
 * returns `version`/`shadingLanguageVersion` verbatim but wraps the `2` pair in
 * its own "WebGL 2.0 (…)" prefix. A capture records what the browser reported,
 * which is the wrapped form, so passing it straight through produced
 * "WebGL 2.0 (WebGL 2.0 (OpenGL ES 3.0 Chromium))" - a string no browser emits.
 */
function innerGlString(reported: string): string {
  const open = reported.indexOf('(')
  return open > 0 && reported.endsWith(')') ? reported.slice(open + 1, -1) : reported
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
  if (typeof captured.VERSION2 === 'string') out.version2 = innerGlString(captured.VERSION2)
  if (typeof captured.SHADING_LANGUAGE_VERSION2 === 'string') {
    out.shadingLanguageVersion2 = innerGlString(captured.SHADING_LANGUAGE_VERSION2)
  }
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
  // Whitelist, not a replacement: the kernel intersects it with what the host
  // GPU really supports. Leaving it out kept the extension list host-shaped
  // while every other GL fact came from the captured machine.
  if (Array.isArray(captured.extensions) && captured.extensions.length) {
    out.extensions = { allow: captured.extensions }
  }
  return out
}

/**
 * The capability surface a Windows Chrome answers with over D3D11. Without it
 * only the two unmasked strings are spoofed and `getParameter`, the shader
 * precision ranges and the extension list keep reporting the host GPU, so a
 * persona claiming D3D11 replies with Metal or Mesa numbers - one API
 * contradicting itself, which is harder evidence than any single odd value.
 *
 * Taken from 133 real Windows captures: every entry below was unanimous across
 * Intel, NVIDIA and AMD. Keys are the decimal GLenum the kernel looks up.
 */
const D3D11_PARAMS: Readonly<Record<string, number>> = {
  3379: 16384, 3408: 4, 3410: 8, 3411: 8, 3412: 8, 3413: 8, 3414: 24, 3415: 0,
  34024: 16384, 34047: 16, 34076: 16384, 34921: 16, 34930: 16, 35660: 16,
  35661: 32, 36348: 30, 36349: 1024,
}

/** highp/mediump/lowp, vertex and fragment; "min,max,precision" per the kernel. */
const D3D11_SHADER_PRECISION: Readonly<Record<string, string>> = {
  '35632-36336': '127,127,23', '35632-36337': '127,127,23', '35632-36338': '127,127,23',
  '35632-36339': '31,30,0', '35632-36340': '31,30,0', '35632-36341': '31,30,0',
  '35633-36336': '127,127,23', '35633-36337': '127,127,23', '35633-36338': '127,127,23',
  '35633-36339': '31,30,0', '35633-36340': '31,30,0', '35633-36341': '31,30,0',
}

const D3D11_EXTENSIONS = [
  'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_clip_control',
  'EXT_color_buffer_half_float', 'EXT_depth_clamp', 'EXT_disjoint_timer_query',
  'EXT_float_blend', 'EXT_frag_depth', 'EXT_polygon_offset_clamp', 'EXT_sRGB',
  'EXT_shader_texture_lod', 'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic',
  'EXT_texture_mirror_clamp_to_edge', 'KHR_parallel_shader_compile',
  'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives',
  'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float',
  'OES_texture_half_float_linear', 'OES_vertex_array_object',
  'WEBGL_blend_func_extended', 'WEBGL_color_buffer_float',
  'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture',
  'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw',
  'WEBGL_polygon_mode',
]

/**
 * The Windows GL report for a persona with no real-device capture behind it.
 * A capture overrides this field by field, so a replayed machine is unaffected.
 */
function windowsWebglConfig(gpuVendor: string): Record<string, unknown> {
  // MAX_VERTEX_UNIFORM_VECTORS is the one value that splits by vendor: NVIDIA
  // reports one fewer than Intel and AMD. Pairing an NVIDIA renderer string
  // with 4096 is a mismatch a GL-aware scanner can name.
  const maxVertexUniformVectors = gpuVendor.includes('NVIDIA') ? 4095 : 4096
  return {
    version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    // The webgl2 pair is the inner string only - see innerGlString.
    version2: 'OpenGL ES 3.0 Chromium',
    shadingLanguageVersion2: 'OpenGL ES GLSL ES 3.0 Chromium',
    params: { ...D3D11_PARAMS, 36347: maxVertexUniformVectors },
    shaderPrecision: D3D11_SHADER_PRECISION,
    extensions: { allow: D3D11_EXTENSIONS },
  }
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
  captured?: Pick<CapturedFacts, 'connectionEffectiveType' | 'connectionRtt' | 'connectionDownlink'>,
): { effectiveType: string; rtt: number; downlink: number } {
  const seedSum = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const measured = typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0
  // A captured trio is one real Chrome's own output, so it already agrees with
  // itself - replayed whole rather than re-derived, because Chrome weighs
  // downlink as well as rtt and our rtt-only approximation would "correct" a
  // true reading into a false one. Only with nothing measured: once the proxy
  // probe knows the real latency, a site can measure it too, and that latency
  // is this connection's, not the corpus machine's.
  if (
    !measured &&
    captured?.connectionEffectiveType &&
    captured.connectionRtt != null &&
    captured.connectionDownlink != null
  ) {
    return {
      effectiveType: captured.connectionEffectiveType,
      rtt: captured.connectionRtt,
      downlink: captured.connectionDownlink,
    }
  }
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
// enumerable set. A replayed device adds the names that phone really resolved,
// which on Android is the alias set (Arial, Helvetica, ...) - see mergeFonts.
const ANDROID_ALLOW_FONTS = [
  'Roboto', 'Roboto Condensed', 'Roboto Mono', 'Noto Sans', 'Noto Serif',
  'Noto Sans Mono', 'Noto Color Emoji', 'Droid Sans Mono',
  'Carrois Gothic SC', 'Coming Soon', 'Cutive Mono', 'Dancing Script',
]

/**
 * The families AOSP's fonts.xml aliases onto sans-serif/serif/monospace,
 * lowercased. These are the only non-AOSP names a stock phone can resolve, and
 * they are exactly what a width-comparison probe reports back - which is why a
 * captured Android font list looks like a desktop's and never names Roboto (the
 * default family measures identical to the probe's own baseline).
 */
const ANDROID_ALIAS_FONTS: ReadonlySet<string> = new Set([
  'arial', 'helvetica', 'tahoma', 'verdana', 'times', 'times new roman',
  'palatino', 'georgia', 'baskerville', 'goudy', 'fantasy', 'itc stone serif',
  'droid sans', 'courier', 'courier new', 'monaco',
])

/**
 * Android's font set is closed, so this is a whitelist rather than a list of
 * known offenders. A capture picks up whatever the collecting page had loaded
 * as a webfont, and a desktop browser wearing an Android UA gets through the
 * corpus filters now and then; either way the extra family enumerates as
 * installed on a phone that cannot have it.
 */
function keepAndroidFonts(fonts: readonly string[]): string[] {
  return fonts.filter((f) => {
    const key = f.trim().toLowerCase()
    return ANDROID_ALIAS_FONTS.has(key) || /^(?:roboto|noto|droid)\b/.test(key)
  })
}

/**
 * Families the host OS ships under the same name, lowercased. `fonts.allow` is
 * default-deny once non-empty, so anything listed but absent from the host
 * enumerates as installed while measuring like a family nobody has - the same
 * contradiction the allowlist exists to prevent. Membership is a property of
 * the host OS, not of this machine: a font the user installed themselves is
 * deliberately not counted, since dropping one family is a weak signal and
 * claiming one that cannot be drawn is a hard tell.
 *
 * darwin is /System/Library/Fonts/Supplemental, which every macOS ships.
 * linux has no equivalent - the MS core fonts are a separate package there, so
 * a Windows persona on Linux keeps only what the kernel bundles a stand-in for.
 */
const HOST_FONTS: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
  darwin: new Set([
    'andale mono', 'arial', 'arial black', 'arial narrow', 'arial unicode ms',
    'brush script mt', 'comic sans ms', 'courier new', 'georgia', 'impact',
    'microsoft sans serif', 'tahoma', 'times new roman', 'trebuchet ms',
    'verdana', 'webdings', 'wingdings', 'wingdings 2', 'wingdings 3',
  ]),
}

/**
 * Metric-compatible stand-ins the kernel ships and matches behind the original
 * family name. Windows-only families do not exist on another host, so
 * `measureText` returns one shared fallback width for all of them - the same
 * width a family nobody ever installed gets, which on a real Windows machine
 * never happens. The stand-ins stay out of `allow`, so none of them enumerates.
 * Keys must be lowercase and trimmed: that is the form the kernel looks up.
 */
const WINDOWS_FONT_ALIAS: Readonly<Record<string, string>> = {
  'segoe ui': 'Selawia',
  'segoe ui semibold': 'Selawia',
  'segoe ui symbol': 'Selawia',
  calibri: 'Carlina',
  cambria: 'Caladria',
  'cambria math': 'Caladria',
  consolas: 'Consolita',
  sylfaen: 'Sylfano',
  'franklin gothic medium': 'Franklito',
  ebrima: 'Ebrisa',
  'courier new': 'Courina',
  georgia: 'Georgina',
  // The only two whose open-source stand-in is metric-exact as published; the
  // rest above carry advances copied from the real family, so pointing these at
  // a same-looking substitute would be a downgrade.
  'times new roman': 'Liberation Serif',
  arial: 'Liberation Sans',
  // Deliberately absent: MS Gothic. An English Windows does not ship it either
  // (it arrives with the Japanese language pack), so measuring as absent is
  // what a real machine does.
}

/**
 * Keep only what this host can actually draw; a bundled stand-in exempts a
 * family. Phrased as a whitelist because a replayed real device brings whatever
 * fonts that machine had - an open set no hand-written exclusion list covers.
 * An empty result would switch `fonts.allow` back to hiding nothing, so it
 * falls back to the families a stand-in covers.
 */
function dropUnrenderable(fonts: readonly string[], host: NodeJS.Platform): string[] {
  const hostFonts = HOST_FONTS[host] ?? EMPTY_FONT_SET
  const kept = renderable(fonts, hostFonts)
  return kept.length ? kept : renderable(WINDOWS_ALLOW_FONTS, hostFonts)
}

const EMPTY_FONT_SET: ReadonlySet<string> = new Set()

function renderable(fonts: readonly string[], hostFonts: ReadonlySet<string>): string[] {
  return fonts.filter((f) => {
    const key = f.trim().toLowerCase()
    return key in WINDOWS_FONT_ALIAS || hostFonts.has(key)
  })
}

/** Case-insensitive union, first spelling wins. */
function mergeFonts(base: readonly string[], extra: readonly string[]): string[] {
  const out = [...base]
  const seen = new Set(base.map((f) => f.toLowerCase()))
  for (const font of extra) {
    const key = font.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(font)
  }
  return out
}

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
  /** Defaults to this machine. Only the font aliases depend on it. */
  hostPlatform?: NodeJS.Platform
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
    // Android personas always arrive with a capture, so there is no synthesized
    // OpenGL ES surface to fall back on and none is invented here.
    ...(android ? {} : windowsWebglConfig(persona.gpuVendor)),
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
        // Every family names a second, more widely installed choice. The first
        // wins wherever it exists; without the fallback a host missing it drops
        // the whole generic onto the fallback font, where it measures exactly
        // like a family nobody has - which is the contradiction being avoided.
        standard: 'Times New Roman,Georgia',
        serif: 'Times New Roman,Georgia',
        sansSerif: 'Arial,Verdana',
        cursive: 'Comic Sans MS,Trebuchet MS',
        fantasy: 'Impact,Arial Black',
        monospace: 'Consolas,Courier New',
        math: 'Cambria Math,Times New Roman,Georgia',
      }
  // Only when the host is not the OS the persona claims: on Windows those
  // families are the real thing, aliasing them would substitute a stand-in for
  // a font that is present, and nothing needs dropping.
  const hostPlatform = opts.hostPlatform ?? process.platform
  const foreignHost = !android && hostPlatform !== 'win32'
  const fontAlias = foreignHost ? WINDOWS_FONT_ALIAS : undefined
  const allowFonts = android ? ANDROID_ALLOW_FONTS
    : foreignHost ? dropUnrenderable(WINDOWS_ALLOW_FONTS, hostPlatform)
      : WINDOWS_ALLOW_FONTS
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
    connection: deriveConnection(persona.seed, opts.rttMs, persona.captured),
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
      ...(fontAlias ? { alias: fontAlias } : {}),
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
    // effectiveType/rtt/downlink are deliberately absent here: overriding one
    // third of the trio is what produced '4g' beside rtt 400. deriveConnection
    // owns all three.
    if (cap.connectionType) connection.type = cap.connectionType
    if (cap.connectionDownlinkMax != null) connection.downlinkMax = cap.connectionDownlinkMax
    const audio = config.audio as Record<string, unknown>
    if (cap.audioSampleRate) audio.sampleRate = cap.audioSampleRate
    if (cap.audioMaxChannelCount) audio.maxChannelCount = cap.audioMaxChannelCount
    if (cap.fonts?.length) {
      // A phone reports the names its font config aliases (Arial, Helvetica,
      // Georgia), not the families behind them, so replaying the capture alone
      // drops Roboto and the Notos - and with them sans-serif, serif and
      // monospace, which then all collapse onto one fallback width. A desktop
      // capture names real files, so it replaces outright.
      const fonts = config.fonts as Record<string, unknown>
      fonts.allow = android ? mergeFonts(ANDROID_ALLOW_FONTS, keepAndroidFonts(cap.fonts))
        : foreignHost ? dropUnrenderable(cap.fonts, hostPlatform)
          : cap.fonts
    }
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

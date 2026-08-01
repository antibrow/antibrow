import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

export interface Persona {
  seed: string
  canvasSeed: string
  audioSeed: string
  domrectSeed: string
  chromeMajor: number
  /** Full kernel version string, e.g. "149.0.7827.201". */
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
}

/**
 * JS-API access log. `off` writes nothing, `curated` logs the built-in
 * fingerprint-related allowlist, `all` logs every access.
 */
export type ApiLogMode = 'off' | 'curated' | 'all'

export const API_LOG_FILE = 'fp-api-log.jsonl'

export function generatePersona(chromeMajor = 149, kernelVersion = '149.0.7827.201'): Persona {
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
}

/** Serialize persona to the fp-config.json schema expected by the kernel. */
export function personaToFpConfig(
  persona: Persona,
  opts: { label: string; timezone: string; publicIp?: string } & FpConfigSettings,
): Record<string, unknown> {
  const availH = persona.screenH - 48
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
  return {
    version: 1,
    seed: persona.seed,
    label: opts.label,
    timezone: opts.timezone,
    navigator: {
      userAgent: persona.ua,
      platform: 'Win32',
      vendor: 'Google Inc.',
      language: persona.languages[0] ?? 'en-US',
      languages: persona.languages,
      hardwareConcurrency: persona.hardwareConcurrency,
      deviceMemory: persona.deviceMemory,
      maxTouchPoints: 0,
      // Every UA-CH key must be listed: an omitted one falls back to the real
      // host, which is how a Windows persona used to leak the host OS. Two
      // naming traps: `platform` is "Windows" (not navigator.platform's "Win32")
      // and `architecture` is "x86" even on x64 - `bitness` carries the 64.
      uaData: {
        platform: 'Windows',
        platformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        wow64: false,
        model: '',
      },
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
    connection: { effectiveType: '4g', rtt: 100, downlink: 10 },
    prefersColorScheme: colorScheme,
    // `allow` is a whitelist over the kernel's probeable font set - left empty
    // it hides nothing, and every host font (macOS/Linux system fonts on a
    // non-Windows host) stays enumerable. `generic` maps the five CSS generic
    // families plus 'standard' so they resolve to a Windows font instead of
    // falling through to the host's own generic-family settings. monospace and
    // math list comma-separated fallbacks so a host missing the first still
    // resolves to a distinct, non-host font rather than its own default.
    fonts: {
      uiFont: 'Segoe UI',
      keepCjk: 0,
      block: [],
      allow: [
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
      ],
      generic: {
        standard: 'Times New Roman',
        serif: 'Times New Roman',
        sansSerif: 'Arial',
        cursive: 'Comic Sans MS',
        fantasy: 'Impact',
        monospace: 'Consolas,Courier New',
        math: 'Cambria Math,Times New Roman',
      },
    },
    apilog: { enabled: apiLog !== 'off', mode: apiLog, path: opts.apiLogPath ?? '' },
  }
}

const PERSONA_FILE = 'persona.json'

/** Load the persisted persona, or generate and persist a new one. */
export function loadOrGeneratePersona(profileDir: string, defaultKernelVersion?: string): Persona {
  const file = path.join(profileDir, PERSONA_FILE)
  if (fs.existsSync(file)) {
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Persona
      if (!p.kernelVersion) {
        p.kernelVersion = defaultKernelVersion ?? '149.0.7827.201'
        fs.writeFileSync(file, JSON.stringify(p, null, 2))
      }
      return p
    } catch { /* corrupted: regenerate */ }
  }
  const kv = defaultKernelVersion ?? '149.0.7827.201'
  const chromeMajor = parseInt(kv.split('.')[0] ?? '149', 10)
  const persona = generatePersona(chromeMajor, kv)
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(persona, null, 2))
  return persona
}

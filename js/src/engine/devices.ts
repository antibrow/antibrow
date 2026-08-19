import { retryFetch } from '../retry-fetch'

/** One real device's bound set of facts, as served by the device library. */
export interface RealDevice {
  os: string
  /** UA template; `{major}` is filled in with the kernel's Chrome major. */
  ua: string
  model?: string
  /**
   * The OS major in the UA *string*, which UA reduction froze at 10 for every
   * modern Chrome on Android. It is NOT the real system version - that only
   * travels in `navigator.uaData.platformVersion`.
   */
  osMajor?: number
  navigator: {
    platform?: string
    vendor?: string
    hardwareConcurrency?: number
    deviceMemory?: number
    maxTouchPoints?: number
    uaData?: {
      platform?: string
      platformVersion?: string
      architecture?: string
      bitness?: string
      model?: string
      mobile?: boolean
      formFactors?: string[]
    }
  }
  screen: {
    width: number
    height: number
    availWidth?: number
    availHeight?: number
    colorDepth?: number
    devicePixelRatio?: number
    isExtended?: boolean
    orientation?: { angle: number; type: string }
  }
  audio?: { sampleRate?: number; maxChannelCount?: number }
  connection?: {
    effectiveType?: string
    rtt?: number
    downlink?: number
    type?: string
    downlinkMax?: number | null
    saveData?: boolean
  }
  fonts?: string[]
  webgl: {
    unmaskedVendor?: string
    unmaskedRenderer?: string
    version?: string
    version2?: string
    shadingLanguageVersion?: string
    shadingLanguageVersion2?: string
    params?: Record<string, number>
    shaderPrecision?: Record<string, number[]>
    extensions?: string[]
  }
}

const DEFAULT_SERVER = 'https://antibrow.com'

/**
 * Draw one device from the library. Never falls back to a generated persona:
 * the caller asked for a real fingerprint explicitly, and quietly handing back
 * a synthetic one would leave them believing something untrue about the profile.
 */
export async function fetchRealDevice(opts: {
  os: 'android' | 'windows'
  key?: string
  server?: string
}): Promise<RealDevice> {
  const server = (opts.server ?? DEFAULT_SERVER).replace(/\/+$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`

  const res = await retryFetch(`${server}/api/v1/devices/pick?os=${opts.os}`, { headers })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      // The server sends `{ error: { code, message } }`; a bare string is only
      // accepted so an intermediary's simpler error body still reaches the user.
      const body = (await res.json()) as { error?: unknown }
      const err = body?.error
      if (typeof err === 'string') detail = err
      else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
        detail = (err as { message: string }).message
      }
    } catch {
      // Non-JSON error body: the status code is all we have.
    }
    throw new Error(`Real device lookup failed: ${detail}`)
  }

  const body = (await res.json()) as { device?: RealDevice }
  const device = body?.device
  // deviceToPersonaParts (persona.ts) reads every one of these fields with no
  // guard of its own, on the assumption that this function is the one place
  // that turns "well-formed real device, or throw" into a true statement. A
  // row that slips past here with a hole in it either surfaces as a bare
  // TypeError deep inside persona generation (missing navigator) or, worse,
  // as a silently skipped overlay key that leaves the caller's requested
  // profile carrying a synthetic screen/GPU value instead of the real one.
  const missing: string[] = []
  if (!device) missing.push('device')
  else {
    if (!device.ua) missing.push('ua')
    if (!device.navigator) missing.push('navigator')
    else {
      if (!device.navigator.hardwareConcurrency) missing.push('navigator.hardwareConcurrency')
      if (!device.navigator.deviceMemory) missing.push('navigator.deviceMemory')
    }
    if (!device.screen?.width) missing.push('screen.width')
    if (!device.screen?.height) missing.push('screen.height')
    if (!device.screen?.devicePixelRatio) missing.push('screen.devicePixelRatio')
    if (!device.webgl) missing.push('webgl')
    else {
      if (!device.webgl.unmaskedRenderer) missing.push('webgl.unmaskedRenderer')
      if (!device.webgl.unmaskedVendor) missing.push('webgl.unmaskedVendor')
    }
  }
  if (missing.length > 0) {
    throw new Error(`Real device lookup returned a malformed device: missing ${missing.join(', ')}`)
  }
  return device as RealDevice
}

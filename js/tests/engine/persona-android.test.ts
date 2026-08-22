import { describe, it, expect } from 'vitest'
import { generatePersona, personaToFpConfig, deviceToPersonaParts } from '../../src/engine/persona'
import { ANDROID_FALLBACK_DEVICES } from '../../src/engine/android-devices'

describe('android persona generation', () => {
  it('replays a whole bundled device', () => {
    const persona = generatePersona(151, '151.0.0.0', { deviceType: 'android' })
    expect(persona.deviceType).toBe('android')
    expect(ANDROID_FALLBACK_DEVICES.map((d) => d.model)).toContain(persona.androidModel)
    expect(persona.ua).toContain('Chrome/151.0.0.0 Mobile Safari')
    expect(persona.ua).toContain('(Linux; Android 10; K)')
    expect(persona.captured?.platform).toBe('Linux armv81')
    expect(persona.captured?.maxTouchPoints).toBe(5)
    expect(persona.capturedWebgl).toBeDefined()
    expect((persona.capturedWebgl as Record<string, unknown>).VERSION2).toContain('WebGL 2.0')
  })

  it('keeps the screen, cores and GPU bound to the one device it picked', () => {
    for (let i = 0; i < 20; i += 1) {
      const persona = generatePersona(151, '151.0.0.0', { deviceType: 'android' })
      const source = ANDROID_FALLBACK_DEVICES.find((d) => d.model === persona.androidModel)
      expect(source).toBeDefined()
      expect(persona.screenW).toBe(source?.screen.width)
      expect(persona.screenH).toBe(source?.screen.height)
      expect(persona.devicePixelRatio).toBe(source?.screen.devicePixelRatio)
      expect(persona.hardwareConcurrency).toBe(source?.navigator.hardwareConcurrency)
      expect(persona.gpuRenderer).toBe(source?.webgl.unmaskedRenderer)
      expect(persona.captured?.webglExtensions).toEqual(source?.webgl.extensions)
    }
  })

  it('varies the Android major within the plausible range', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 200; i += 1) {
      seen.add(generatePersona(151, '151.0.0.0', { deviceType: 'android' }).androidOsMajor ?? 0)
    }
    expect([...seen].sort()).toEqual([13, 14, 15, 16])
  })

  it('leaves desktop generation untouched', () => {
    const persona = generatePersona(150, '150.0.0.0')
    expect(persona.deviceType).toBeUndefined()
    expect(persona.captured).toBeUndefined()
    expect(persona.androidModel).toBeUndefined()
  })
})

describe('android fp-config', () => {
  const persona = { ...generatePersona(151, '151.0.0.0', { deviceType: 'android' }), seed: '0123456789abcdef' }
  const config = personaToFpConfig(persona, { label: 'demo', timezone: 'America/Los_Angeles' })
  const nav = config.navigator as Record<string, unknown>
  const uaData = nav.uaData as Record<string, unknown>
  const device = config.device as Record<string, unknown>
  const screen = config.screen as Record<string, unknown>

  it('writes the device block', () => {
    expect(device).toEqual({
      type: 'android',
      pointer: 'coarse',
      hover: 'none',
      viewport: 'mobile',
      orientation: 'portrait-primary',
      outerWidth: persona.screenW,
      outerHeight: persona.screenH,
    })
  })

  it('spells navigator.platform with the digit one', () => {
    expect(nav.platform).toBe('Linux armv81')
    expect(nav.platform).not.toBe('Linux armv8l')
  })

  it('keeps the four touch signals true together', () => {
    expect(nav.maxTouchPoints).toBe(5)
    expect(device.pointer).toBe('coarse')
    expect(device.hover).toBe('none')
    expect(device.viewport).toBe('mobile')
  })

  it('makes every UA channel say Android', () => {
    expect(config.navigator).toBeDefined()
    expect((nav.userAgent as string)).toContain('Mobile Safari')
    expect(uaData.platform).toBe('Android')
    expect(uaData.mobile).toBe(true)
    expect(uaData.architecture).toBe('')
    expect(uaData.bitness).toBe('')
    expect(uaData.model).toBe(persona.androidModel)
    expect(uaData.platformVersion).toBe(`${persona.androidOsMajor}.0.0`)
  })

  it('uses the captured avail size instead of the taskbar guess', () => {
    const source = ANDROID_FALLBACK_DEVICES.find((d) => d.model === persona.androidModel)
    expect(screen.availHeight).toBe(source?.screen.availHeight)
    expect(screen.availHeight).not.toBe(persona.screenH - 48)
  })

  it('serves Android fonts', () => {
    const fonts = config.fonts as Record<string, unknown>
    expect(fonts.uiFont).toBe('Roboto')
    expect(fonts.generic).toEqual({
      standard: 'Roboto',
      serif: 'Noto Serif',
      sansSerif: 'Roboto',
      cursive: 'Dancing Script',
      fantasy: 'Roboto',
      monospace: 'Droid Sans Mono,Noto Sans Mono',
      math: 'Noto Serif',
    })
  })
})

describe('deviceToPersonaParts', () => {
  it('normalizes the corpus webgl keys into the replay shape', () => {
    const parts = deviceToPersonaParts(ANDROID_FALLBACK_DEVICES[0], 151, 15)
    const webgl = parts.capturedWebgl as Record<string, unknown>
    expect(webgl.VERSION).toBe(ANDROID_FALLBACK_DEVICES[0].webgl.version)
    expect(webgl.SHADING_LANGUAGE_VERSION2).toBe(ANDROID_FALLBACK_DEVICES[0].webgl.shadingLanguageVersion2)
    expect(webgl.params).toEqual(ANDROID_FALLBACK_DEVICES[0].webgl.params)
    expect(parts.androidOsMajor).toBe(15)
    expect(parts.captured?.uaPlatformVersion).toBe('15.0.0')
  })
})

// A phone's font probe reports the names Android aliases (Arial, Helvetica,
// Georgia), never the families behind them, so a capture replayed as-is leaves
// `allow` without Roboto or the Notos. `allow` denies by default, so the three
// CSS generics then resolve to nothing and measure identically - one number
// where a real phone has three.
describe('an Android capture adds to the AOSP families, it does not replace them', () => {
  const capturedFonts = ['Arial', 'Baskerville', 'Courier New', 'Georgia', 'Helvetica', 'Verdana']

  function allowFor(deviceType: 'android' | 'desktop'): string[] {
    const persona = generatePersona(150, '150', deviceType === 'android' ? { deviceType } : undefined)
    const config = personaToFpConfig(
      { ...persona, deviceType, captured: { ...persona.captured, fonts: capturedFonts } },
      // Pinned: `allow` depends on the host, so an unpinned call filters the
      // desktop capture differently on each CI runner.
      { label: 'x', timezone: 'UTC', hostPlatform: 'win32' },
    )
    return (config.fonts as Record<string, unknown>).allow as string[]
  }

  it('keeps the families the generics point at', () => {
    const allow = allowFor('android')
    for (const family of ['Roboto', 'Noto Serif', 'Droid Sans Mono', 'Noto Sans Mono', 'Dancing Script']) {
      expect(allow).toContain(family)
    }
    for (const family of capturedFonts) expect(allow).toContain(family)
  })

  it('does not list a family twice', () => {
    const allow = allowFor('android')
    expect(new Set(allow.map((f) => f.toLowerCase())).size).toBe(allow.length)
  })

  it('still replaces outright on desktop, where a capture names real files', () => {
    expect(allowFor('desktop')).toEqual(capturedFonts)
  })
})

// The corpus is drawn from ordinary web visitors, so a row can carry the
// collecting page's own webfont, or belong to a desktop that wore a phone UA
// past the corpus filters. Either way the family enumerates as installed on a
// phone that has no glyphs for it, which measures like a family nobody has.
describe('a captured Android font list is filtered to what a phone can resolve', () => {
  function androidAllow(fonts: string[]): string[] {
    const persona = generatePersona(150, '150', { deviceType: 'android' })
    const config = personaToFpConfig(
      { ...persona, captured: { ...persona.captured, fonts } },
      { label: 'x', timezone: 'UTC', hostPlatform: 'win32' },
    )
    return (config.fonts as Record<string, unknown>).allow as string[]
  }

  it('drops a webfont the collecting page had loaded', () => {
    expect(androidAllow(['Arial', 'Montserrat', 'Source Sans Pro'])).not.toContain('Montserrat')
    expect(androidAllow(['Arial', 'Montserrat'])).toContain('Arial')
  })

  it('drops the desktop set a spoofed capture brings', () => {
    const allow = androidAllow([
      'Arial', 'DejaVu Sans', 'Liberation Serif', 'FreeSans', 'Nimbus Roman',
      'Cantarell', 'Segoe UI', 'Consolas', 'Helvetica Neue', 'Menlo',
    ])
    for (const family of ['DejaVu Sans', 'Liberation Serif', 'FreeSans', 'Nimbus Roman',
      'Cantarell', 'Segoe UI', 'Consolas', 'Helvetica Neue', 'Menlo']) {
      expect(allow).not.toContain(family)
    }
  })

  it('keeps every name AOSP aliases, plus the Roboto and Noto families', () => {
    const aliases = ['Arial', 'Baskerville', 'Courier New', 'Georgia', 'Helvetica',
      'Monaco', 'Palatino', 'Tahoma', 'Times New Roman', 'Verdana']
    const allow = androidAllow([...aliases, 'Noto Sans Thai', 'Roboto Flex'])
    for (const family of [...aliases, 'Noto Sans Thai', 'Roboto Flex']) {
      expect(allow).toContain(family)
    }
  })

  it('leaves the AOSP families in place when the whole capture is unusable', () => {
    const allow = androidAllow(['Montserrat', 'DejaVu Sans'])
    expect(allow).toContain('Roboto')
    expect(allow).not.toContain('Montserrat')
  })

})

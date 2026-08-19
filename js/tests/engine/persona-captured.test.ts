import { describe, it, expect } from 'vitest'
import { personaToFpConfig, generatePersona, type Persona } from '../../src/engine/persona'

function desktopPersona(): Persona {
  const base = generatePersona(150, '150.0.0.0')
  return { ...base, seed: '0123456789abcdef', screenW: 1536, screenH: 864 }
}

describe('capturedWebgl replays both GL contexts', () => {
  it('carries the webgl2 version strings through', () => {
    const persona: Persona = {
      ...desktopPersona(),
      capturedWebgl: {
        VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
        SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
        VERSION2: 'WebGL 2.0 (OpenGL ES 3.0 Chromium)',
        SHADING_LANGUAGE_VERSION2: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)',
        params: { '3379': 16384 },
        shaderPrecision: { '35632-36336': [15, 15, 10] },
      },
    }
    const webgl = personaToFpConfig(persona, { label: 'x', timezone: 'UTC' }).webgl as Record<string, unknown>
    expect(webgl.version).toBe('WebGL 1.0 (OpenGL ES 2.0 Chromium)')
    expect(webgl.version2).toBe('WebGL 2.0 (OpenGL ES 3.0 Chromium)')
    expect(webgl.shadingLanguageVersion2).toBe('WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)')
    expect(webgl.params).toEqual({ '3379': 16384 })
    expect(webgl.shaderPrecision).toEqual({ '35632-36336': '15,15,10' })
  })

  it('carries the extension list through', () => {
    // Without this the numeric GL face came from the captured machine while the
    // extension list still described the host GPU.
    const persona: Persona = {
      ...desktopPersona(),
      capturedWebgl: { extensions: ['EXT_sRGB', 'WEBGL_debug_renderer_info'] },
    }
    const webgl = personaToFpConfig(persona, { label: 'x', timezone: 'UTC' }).webgl as Record<string, unknown>
    expect(webgl.extensions).toEqual({ allow: ['EXT_sRGB', 'WEBGL_debug_renderer_info'] })
  })

  it('leaves the extension list alone when the capture has none', () => {
    const persona: Persona = { ...desktopPersona(), capturedWebgl: { params: { '3379': 16384 } } }
    const webgl = personaToFpConfig(persona, { label: 'x', timezone: 'UTC' }).webgl as Record<string, unknown>
    expect('extensions' in webgl).toBe(false)
  })
})

describe('captured facts override the generated defaults', () => {
  it('replaces navigator, screen, audio, connection and fonts', () => {
    const persona: Persona = {
      ...desktopPersona(),
      captured: {
        platform: 'Linux armv8l',
        vendor: 'Captured Vendor Inc.',
        maxTouchPoints: 10,
        colorDepth: 30,
        availW: 1530,
        availH: 800,
        prefersColorScheme: 'dark',
        connectionEffectiveType: '3g',
        connectionRtt: 350,
        connectionDownlink: 1.2,
        connectionType: 'wifi',
        connectionDownlinkMax: 0,
        uaPlatform: 'Chrome OS',
        uaPlatformVersion: '10.0.19045',
        uaArchitecture: 'x86',
        uaBitness: '64',
        uaModel: '',
        uaMobile: false,
        audioSampleRate: 44100,
        audioMaxChannelCount: 2,
        fonts: ['Arial', 'Verdana'],
        webglExtensions: ['EXT_sRGB', 'OES_texture_float'],
      },
    }
    const config = personaToFpConfig(persona, { label: 'x', timezone: 'UTC' })
    const nav = config.navigator as Record<string, unknown>
    const screen = config.screen as Record<string, unknown>
    const fonts = config.fonts as Record<string, unknown>
    const webgl = config.webgl as Record<string, unknown>

    expect(nav.platform).toBe('Linux armv8l')
    expect(nav.vendor).toBe('Captured Vendor Inc.')
    expect(nav.maxTouchPoints).toBe(10)
    expect((nav.uaData as Record<string, unknown>).platform).toBe('Chrome OS')
    expect((nav.uaData as Record<string, unknown>).platformVersion).toBe('10.0.19045')
    expect(screen.availWidth).toBe(1530)
    expect(screen.availHeight).toBe(800)
    expect(screen.colorDepth).toBe(30)
    expect(screen.pixelDepth).toBe(30)
    expect(config.prefersColorScheme).toBe('dark')
    expect(config.connection).toEqual({ effectiveType: '3g', rtt: 350, downlink: 1.2, type: 'wifi', downlinkMax: 0 })
    expect(config.audio).toEqual({ seed: persona.audioSeed, sampleRate: 44100, maxChannelCount: 2 })
    expect(fonts.allow).toEqual(['Arial', 'Verdana'])
    expect(webgl.extensions).toEqual({ allow: ['EXT_sRGB', 'OES_texture_float'] })
  })

  it('leaves a field alone when it was not captured', () => {
    const persona: Persona = { ...desktopPersona(), captured: { maxTouchPoints: 3 } }
    const config = personaToFpConfig(persona, { label: 'x', timezone: 'UTC' })
    const screen = config.screen as Record<string, unknown>
    expect((config.navigator as Record<string, unknown>).maxTouchPoints).toBe(3)
    expect(screen.availHeight).toBe(816)
    expect(screen.colorDepth).toBe(24)
    expect((config.fonts as Record<string, unknown>).uiFont).toBe('Segoe UI')
  })

  it('empty string and false are real captured values, not "unset"', () => {
    const persona: Persona = {
      ...desktopPersona(),
      captured: { uaArchitecture: '', uaBitness: '', uaModel: '', uaMobile: false },
    }
    const uaData = (personaToFpConfig(persona, { label: 'x', timezone: 'UTC' }).navigator as Record<string, unknown>)
      .uaData as Record<string, unknown>
    expect(uaData.architecture).toBe('')
    expect(uaData.bitness).toBe('')
    expect(uaData.model).toBe('')
    expect(uaData.mobile).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { personaToFpConfig, generatePersona, type Persona } from '../../src/engine/persona'

function desktop(gpuVendor: string, gpuRenderer: string): Persona {
  return { ...generatePersona(151, '151'), gpuVendor, gpuRenderer }
}

const cfg = (p: Persona) =>
  personaToFpConfig(p, { label: 'x', timezone: 'UTC' }).webgl as Record<string, unknown>

describe('a desktop persona with no capture still gets a D3D11 capability surface', () => {
  it('answers getParameter and getShaderPrecisionFormat with Windows values', () => {
    // Without these the two unmasked strings are the only spoofed part and every
    // limit, precision range and extension still describes the host GPU.
    const webgl = cfg(desktop('Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)'))
    const params = webgl.params as Record<string, number>
    expect(params['3379']).toBe(16384)
    expect(params['35661']).toBe(32)
    expect(webgl.version).toBe('WebGL 1.0 (OpenGL ES 2.0 Chromium)')
    // The kernel wraps the webgl2 pair itself; sending the wrapped form back
    // yields "WebGL 2.0 (WebGL 2.0 (…))".
    expect(webgl.version2).toBe('OpenGL ES 3.0 Chromium')
    expect((webgl.shaderPrecision as Record<string, string>)['35632-36336']).toBe('127,127,23')
    expect((webgl.extensions as { allow: string[] }).allow).toContain('WEBGL_compressed_texture_s3tc')
  })

  it('splits MAX_VERTEX_UNIFORM_VECTORS by vendor', () => {
    const nvidia = cfg(desktop('Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)'))
    const amd = cfg(desktop('Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)'))
    expect((nvidia.params as Record<string, number>)['36347']).toBe(4095)
    expect((amd.params as Record<string, number>)['36347']).toBe(4096)
  })

  it('invents nothing for Android, which always arrives with a real capture', () => {
    const android: Persona = { ...generatePersona(151, '151'), deviceType: 'android', capturedWebgl: undefined }
    expect(Object.keys(cfg(android)).sort()).toEqual(['unmaskedRenderer', 'unmaskedVendor'])
  })

  it('lets a capture win field by field', () => {
    const p: Persona = {
      ...desktop('Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)'),
      capturedWebgl: { params: { '3379': 8192 }, extensions: ['EXT_sRGB'] },
    }
    const webgl = cfg(p)
    expect(webgl.params).toEqual({ '3379': 8192 })
    expect(webgl.extensions).toEqual({ allow: ['EXT_sRGB'] })
    // Untouched by the capture, so the baseline still supplies it.
    expect(webgl.shadingLanguageVersion).toBe('WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)')
  })
})

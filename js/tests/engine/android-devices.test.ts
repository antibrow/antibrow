import { describe, it, expect } from 'vitest'
import { ANDROID_FALLBACK_DEVICES } from '../../src/engine/android-devices'

describe('bundled Android devices', () => {
  it('ships exactly the three curated models', () => {
    expect(ANDROID_FALLBACK_DEVICES.map((d) => d.model)).toEqual(['SM-S918U', 'moto g05', 'SM-S936U'])
  })

  it('spans two GPU families and three screen sizes', () => {
    const renderers = ANDROID_FALLBACK_DEVICES.map((d) => d.webgl.unmaskedRenderer ?? '')
    expect(renderers.filter((r) => r.includes('Adreno'))).toHaveLength(2)
    expect(renderers.filter((r) => r.includes('Mali'))).toHaveLength(1)
    const sizes = ANDROID_FALLBACK_DEVICES.map((d) => `${d.screen.width}x${d.screen.height}`)
    expect(new Set(sizes).size).toBe(3)
  })

  it('carries a whole WebGL report per device, not just the renderer string', () => {
    for (const device of ANDROID_FALLBACK_DEVICES) {
      expect(Object.keys(device.webgl.params ?? {}).length).toBeGreaterThan(10)
      expect(Object.keys(device.webgl.shaderPrecision ?? {}).length).toBeGreaterThan(5)
      expect(device.webgl.extensions?.length ?? 0).toBeGreaterThan(20)
    }
  })

  it('keeps every device on the frozen Android navigator surface', () => {
    for (const device of ANDROID_FALLBACK_DEVICES) {
      expect(device.navigator.platform).toBe('Linux armv81')
      expect(device.navigator.maxTouchPoints).toBe(5)
      expect(device.navigator.uaData?.mobile).toBe(true)
      expect(device.navigator.uaData?.architecture).toBe('')
      expect(device.navigator.uaData?.bitness).toBe('')
      expect(device.ua).toContain('{major}')
      expect(device.ua).toContain('Mobile Safari')
    }
  })

  it('keeps each device availHeight as captured rather than a guess', () => {
    const byModel = Object.fromEntries(ANDROID_FALLBACK_DEVICES.map((d) => [d.model, d]))
    expect(byModel['SM-S918U'].screen.availHeight).toBe(743)
    expect(byModel['moto g05'].screen.availHeight).toBe(917)
  })
})

import { describe, it, expect } from 'vitest'
import { buildOpenProfileOptions } from '../src/browser'

describe('launch options carry the device choice to the engine', () => {
  it('forwards deviceType and realFingerprint into the openProfile call', () => {
    const built = buildOpenProfileOptions({
      key: 'adb_test',
      server: 'https://antibrow.com',
      profileName: 'p',
      licenseToken: 'tok',
      archive: {},
      cacheDir: '/tmp/cache',
      temporary: false,
      options: { profile: 'p', deviceType: 'android', realFingerprint: true },
    })
    expect(built.deviceType).toBe('android')
    expect(built.realFingerprint).toBe(true)
  })

  it('forwards the label so the kernel draws it, with no page injection left', () => {
    const built = buildOpenProfileOptions({
      key: 'adb_test',
      server: 'https://antibrow.com',
      profileName: 'p',
      licenseToken: 'tok',
      archive: {},
      cacheDir: '/tmp/cache',
      temporary: false,
      options: { profile: 'p', label: 'acct@shop.com' },
    })
    expect(built.label).toBe('acct@shop.com')
  })

  it('forwards focusWindow so the kernel opens the window behind the caller', () => {
    const built = buildOpenProfileOptions({
      key: 'adb_test',
      server: 'https://antibrow.com',
      profileName: 'p',
      licenseToken: 'tok',
      archive: {},
      cacheDir: '/tmp/cache',
      temporary: false,
      options: { profile: 'p', focusWindow: false },
    })
    expect(built.focusWindow).toBe(false)
  })

  it('leaves both undefined when the caller does not ask for them', () => {
    const built = buildOpenProfileOptions({
      key: 'adb_test',
      server: 'https://antibrow.com',
      profileName: 'p',
      licenseToken: 'tok',
      archive: {},
      cacheDir: '/tmp/cache',
      temporary: false,
      options: { profile: 'p' },
    })
    expect(built.deviceType).toBeUndefined()
    expect(built.realFingerprint).toBeUndefined()
  })
})

// launch() -> buildOpenProfileOptions() -> openProfile() is the only path the
// desktop app and every SDK caller takes, so a field missing here is a public
// option that silently does nothing. `apiLog` was exactly that: documented on
// LaunchOptions, never reaching fp-config, so the kernel's API log could not be
// turned on at all from launch(). Assert the whole per-profile group, not one
// field - this hole existed because none of the three was covered.
describe('per-profile kernel switches reach the engine', () => {
  const base = {
    key: 'adb_test',
    server: 'https://antibrow.com',
    profileName: 'p',
    licenseToken: 'tok',
    archive: {},
    cacheDir: '/tmp/cache',
    temporary: false,
  }

  it('forwards apiLog, canvasNoise and webauthnCapture', () => {
    const built = buildOpenProfileOptions({
      ...base,
      options: { profile: 'p', apiLog: 'all', canvasNoise: false, webauthnCapture: false, restoreTabs: false },
    })
    expect(built.apiLog).toBe('all')
    expect(built.canvasNoise).toBe(false)
    expect(built.webauthnCapture).toBe(false)
    // A registration run wants a clean window: reopened tabs from the last
    // session show the site a browser that arrives already logged in elsewhere.
    expect(built.restoreTabs).toBe(false)
  })

  it('leaves them undefined when the caller named none, so the kernel keeps its defaults', () => {
    const built = buildOpenProfileOptions({ ...base, options: { profile: 'p' } })
    expect(built.apiLog).toBeUndefined()
    expect(built.canvasNoise).toBeUndefined()
    expect(built.webauthnCapture).toBeUndefined()
    expect(built.restoreTabs).toBeUndefined()
  })
})

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

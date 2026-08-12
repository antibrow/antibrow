import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolvePersonaInit, assertAndroidKernel, ANDROID_MIN_KERNEL_VERSION } from '../../src/engine/index'

function tmpProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adb-device-'))
}

afterEach(() => vi.unstubAllGlobals())

describe('resolvePersonaInit', () => {
  it('returns nothing for a plain desktop launch', async () => {
    const init = await resolvePersonaInit(tmpProfile(), {})
    expect(init).toBeUndefined()
  })

  it('asks for the bundled table when android is requested without a real fingerprint', async () => {
    const init = await resolvePersonaInit(tmpProfile(), { deviceType: 'android' })
    expect(init).toEqual({ deviceType: 'android', device: undefined })
  })

  it('fetches the android side of the library when a real fingerprint is asked for', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      device: {
        os: 'android', ua: 'UA {major}', model: 'X',
        screen: { width: 1, height: 2, devicePixelRatio: 3 },
        navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
        webgl: { unmaskedRenderer: 'r', unmaskedVendor: 'v' },
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const init = await resolvePersonaInit(tmpProfile(), { deviceType: 'android', realFingerprint: true, key: 'k' })
    expect(init?.device?.model).toBe('X')
    expect(String(fetchMock.mock.calls[0][0])).toContain('os=android')
  })

  it('maps a desktop real fingerprint onto the windows corpus', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      device: {
        os: 'windows', ua: 'UA {major}',
        screen: { width: 1, height: 2, devicePixelRatio: 1 },
        navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
        webgl: { unmaskedRenderer: 'r', unmaskedVendor: 'v' },
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await resolvePersonaInit(tmpProfile(), { realFingerprint: true, key: 'k' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('os=windows')
  })

  it('skips the lookup entirely when the profile already has a persona', async () => {
    const dir = tmpProfile()
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ seed: 'x' }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const init = await resolvePersonaInit(dir, { deviceType: 'android', realFingerprint: true, key: 'k' })
    expect(init).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('assertAndroidKernel', () => {
  it('passes the floor and anything above it through', () => {
    expect(() => assertAndroidKernel(ANDROID_MIN_KERNEL_VERSION)).not.toThrow()
    expect(() => assertAndroidKernel('152')).not.toThrow()
    // A legacy full version resolves to its major first.
    expect(() => assertAndroidKernel('151.7.7.7')).not.toThrow()
  })

  it('refuses a kernel below the minimum version', () => {
    expect(() => assertAndroidKernel('150')).toThrow(/Android profiles need/)
    expect(() => assertAndroidKernel('150.7.7.7')).toThrow(/Android profiles need/)
    expect(() => assertAndroidKernel(undefined)).toThrow(/Android profiles need/)
  })
})

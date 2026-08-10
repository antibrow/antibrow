import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchRealDevice } from '../../src/engine/devices'

const SAMPLE = {
  os: 'android',
  model: 'SM-S918U',
  osMajor: 10,
  ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Mobile Safari/537.36',
  navigator: {
    platform: 'Linux armv81',
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    uaData: { platform: 'Android', mobile: true },
  },
  screen: { width: 384, height: 824, devicePixelRatio: 2.8125 },
  webgl: {
    unmaskedRenderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',
    unmaskedVendor: 'Google Inc. (Qualcomm)',
  },
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchRealDevice', () => {
  it('requests the library with the api key and returns the device', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ device: SAMPLE }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const device = await fetchRealDevice({ os: 'android', key: 'adb_test', server: 'https://example.test' })

    expect(device.model).toBe('SM-S918U')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.test/api/v1/devices/pick?os=android')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer adb_test')
  })

  it('turns a 403 into a plan error rather than falling back', async () => {
    // The shape the server actually sends (ApiError.toJSON): a nested object,
    // not a string. Mocking a bare string here is what let the real 403 message
    // reach the user as a bare "HTTP 403".
    const body = { error: { code: 'FORBIDDEN', message: 'The Captured-machine fingerprint library requires a paid plan.' } }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 403 }))
    await expect(fetchRealDevice({ os: 'android', key: 'adb_free' })).rejects.toThrow(/requires a paid plan/)
  })

  it('still reads a plain string error body', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'upstream said no' }), { status: 502 }))
    await expect(fetchRealDevice({ os: 'android', key: 'adb_test' })).rejects.toThrow(/upstream said no/)
  })

  it('falls back to the status code when the body is not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>gateway</html>', { status: 502 }))
    await expect(fetchRealDevice({ os: 'android', key: 'adb_test' })).rejects.toThrow(/HTTP 502/)
  })

  it('rejects a device missing the numbers persona generation reads unguarded', async () => {
    for (const drop of ['hardwareConcurrency', 'deviceMemory'] as const) {
      const { [drop]: _dropped, ...navigator } = SAMPLE.navigator
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ device: { ...SAMPLE, navigator } }), { status: 200 }))
      await expect(fetchRealDevice({ os: 'android', key: 'adb_test' })).rejects.toThrow(new RegExp(drop))
    }
    const { devicePixelRatio: _dpr, ...screen } = SAMPLE.screen
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ device: { ...SAMPLE, screen } }), { status: 200 }))
    await expect(fetchRealDevice({ os: 'android', key: 'adb_test' })).rejects.toThrow(/devicePixelRatio/)
  })

  it('propagates a network failure instead of returning a synthetic device', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNRESET') })
    await expect(fetchRealDevice({ os: 'windows', key: 'adb_test' })).rejects.toThrow(/ECONNRESET/)
  })

  it('rejects a malformed payload', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ device: { os: 'android' } }), { status: 200 }))
    await expect(fetchRealDevice({ os: 'android', key: 'adb_test' })).rejects.toThrow(/malformed/i)
  })

  it('rejects a device missing screen.height, even with screen.width present', async () => {
    const partial = { ...SAMPLE, screen: { width: SAMPLE.screen.width } }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ device: partial }), { status: 200 }))
    await expect(fetchRealDevice({ os: 'android', key: 'adb_test' })).rejects.toThrow(/malformed/i)
  })

  it('rejects a device missing webgl.unmaskedRenderer, even with webgl present', async () => {
    const partial = { ...SAMPLE, webgl: { unmaskedVendor: SAMPLE.webgl.unmaskedVendor } }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ device: partial }), { status: 200 }))
    await expect(fetchRealDevice({ os: 'android', key: 'adb_test' })).rejects.toThrow(/malformed/i)
  })

  it('rejects a device missing navigator entirely', async () => {
    const { navigator: _navigator, ...partial } = SAMPLE
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ device: partial }), { status: 200 }))
    await expect(fetchRealDevice({ os: 'android', key: 'adb_test' })).rejects.toThrow(/malformed/i)
  })
})

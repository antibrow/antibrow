import crypto from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'

const relayFetch = vi.fn()
vi.mock('../../src/engine/relay-tunnel', async (orig) => {
  const actual = await orig<typeof import('../../src/engine/relay-tunnel')>()
  return { ...actual, relayFetch: (...args: unknown[]) => relayFetch(...args) }
})

const { probeProxyExit } = await import('../../src/engine/geoip')

afterEach(() => { relayFetch.mockReset() })

const KEY = crypto.randomBytes(32).toString('base64url')
const GEO = '{"status":"success","country":"United States","countryCode":"US","city":"Las Vegas","timezone":"America/Los_Angeles","query":"203.0.113.7"}'

describe('relay geo probing', () => {
  it('goes through the encrypted tunnel when the url carries a key', async () => {
    relayFetch.mockResolvedValue(GEO)

    const res = await probeProxyExit(`relay://alice:s3cret@r.example.com/?key=${KEY}`, 2000)

    expect(res.ok).toBe(true)
    expect(res.geo?.timezone).toBe('America/Los_Angeles')
    expect(res.geo?.ip).toBe('203.0.113.7')
    const arg = relayFetch.mock.calls[0]![0] as { host: string; port: number }
    expect(arg.host).toBe('ip-api.com')
    expect(arg.port).toBe(80)
  })

  it('reports a bad key instead of silently probing over the plaintext path', async () => {
    const res = await probeProxyExit('relay://alice:s3cret@r.example.com/?key=nope', 2000)

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/32 bytes/)
    expect(relayFetch).not.toHaveBeenCalled()
  })

  it('leaves keyless (managed) relays on the header path', async () => {
    // No key means the managed relay, which speaks the legacy header protocol;
    // a tunnel attempt there would break every managed-proxy launch.
    const res = await probeProxyExit('relay://id:ticket@proxy.example.com/', 200)

    expect(relayFetch).not.toHaveBeenCalled()
    expect(res.ok).toBe(false) // no network in tests; the point is which path ran
  })
})

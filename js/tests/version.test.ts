import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkClientVersion, SDK_VERSION } from '../src/version'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockFetch(handler: (url: string) => { ok: boolean; body: unknown }) {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input)
    const { ok, body } = handler(url)
    return { ok, json: async () => body } as Response
  }) as unknown as typeof fetch
}

describe('checkClientVersion', () => {
  it('builds the check URL with client + version and passes through "required"', async () => {
    let seen = ''
    mockFetch((url) => {
      seen = url
      return { ok: true, body: { status: 'required', latest: '2.0.0', minSupported: '1.5.0', downloadUrl: 'https://dl', notes: 'security fix' } }
    })
    const r = await checkClientVersion({ client: 'desktop', version: '1.0.0', server: 'https://api.test' })
    expect(seen).toContain('/api/v1/version/check')
    expect(seen).toContain('client=desktop')
    expect(seen).toContain('version=1.0.0')
    expect(r).toEqual({
      status: 'required', current: '1.0.0', latest: '2.0.0',
      minSupported: '1.5.0', downloadUrl: 'https://dl', notes: 'security fix',
    })
  })

  it('passes through "recommended"', async () => {
    mockFetch(() => ({ ok: true, body: { status: 'recommended', latest: '2.0.0' } }))
    const r = await checkClientVersion({ client: 'sdk', version: '1.0.0', server: 'https://api.test' })
    expect(r.status).toBe('recommended')
    expect(r.latest).toBe('2.0.0')
  })

  it('coerces an unknown status to "ok" (fail-open)', async () => {
    mockFetch(() => ({ ok: true, body: { status: 'banana' } }))
    const r = await checkClientVersion({ client: 'sdk', version: '1.0.0', server: 'https://api.test' })
    expect(r.status).toBe('ok')
    expect(r.current).toBe('1.0.0')
  })

  it('fails open to "ok" on a non-OK HTTP response', async () => {
    mockFetch(() => ({ ok: false, body: '' }))
    const r = await checkClientVersion({ client: 'sdk', version: '1.0.0', server: 'https://api.test' })
    expect(r.status).toBe('ok')
  })

  it('fails open to "ok" on a network error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const r = await checkClientVersion({ client: 'sdk', version: '1.0.0', server: 'https://api.test' })
    expect(r.status).toBe('ok')
    expect(r.current).toBe('1.0.0')
  })
})

describe('SDK_VERSION', () => {
  it('stays in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(SDK_VERSION).toBe(pkg.version)
  })
})

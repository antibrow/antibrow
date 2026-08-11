import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkClientVersion, compareVersions, SDK_VERSION } from '../src/version'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockFetch(handler: (url: string) => { ok: boolean; body: unknown }) {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input)
    const { ok, body } = handler(url)
    return {
      ok,
      json: async () => {
        if (typeof body === 'string') throw new SyntaxError('Unexpected token')
        return body
      },
    } as Response
  }) as unknown as typeof fetch
}

function manifest(entry: Record<string, unknown>) {
  return { clients: { sdk: entry, desktop: { latest: '9.9.9', minSupported: '9.9.9' } } }
}

describe('checkClientVersion', () => {
  it('reads the public manifest with a cache buster', async () => {
    let seen = ''
    mockFetch((url) => {
      seen = url
      return { ok: true, body: manifest({ latest: '2.0.0', minSupported: '1.5.0' }) }
    })
    await checkClientVersion({ client: 'sdk', version: '1.0.0' })
    expect(seen).toContain('https://download.antibrow.com/app-versions.json')
    expect(seen).toContain('_cb=')
    const first = seen
    await checkClientVersion({ client: 'sdk', version: '1.0.0' })
    expect(seen).not.toBe(first)
  })

  it('returns "required" below minSupported, with the policy fields', async () => {
    mockFetch(() => ({
      ok: true,
      body: manifest({ latest: '2.0.0', minSupported: '1.5.0', downloadUrl: 'https://dl', notes: 'security fix' }),
    }))
    const r = await checkClientVersion({ client: 'sdk', version: '1.0.0' })
    expect(r).toEqual({
      status: 'required', current: '1.0.0', latest: '2.0.0',
      minSupported: '1.5.0', downloadUrl: 'https://dl', notes: 'security fix',
    })
  })

  it('returns "recommended" between minSupported and latest', async () => {
    mockFetch(() => ({ ok: true, body: manifest({ latest: '2.0.0', minSupported: '1.5.0' }) }))
    const r = await checkClientVersion({ client: 'sdk', version: '1.6.0' })
    expect(r.status).toBe('recommended')
    expect(r.latest).toBe('2.0.0')
    expect(r.downloadUrl).toBeNull()
  })

  it('returns "recommended" at exactly minSupported (inclusive lower bound)', async () => {
    mockFetch(() => ({ ok: true, body: manifest({ latest: '2.0.0', minSupported: '1.5.0' }) }))
    const r = await checkClientVersion({ client: 'sdk', version: '1.5.0' })
    expect(r.status).toBe('recommended')
  })

  it('returns "ok" at or above latest', async () => {
    mockFetch(() => ({ ok: true, body: manifest({ latest: '2.0.0', minSupported: '1.5.0' }) }))
    expect((await checkClientVersion({ client: 'sdk', version: '2.0.0' })).status).toBe('ok')
    expect((await checkClientVersion({ client: 'sdk', version: '2.1.0' })).status).toBe('ok')
  })

  it('reads the entry for the requested client only', async () => {
    mockFetch(() => ({ ok: true, body: manifest({ latest: '2.0.0', minSupported: '1.5.0' }) }))
    const r = await checkClientVersion({ client: 'desktop', version: '1.0.0' })
    expect(r.status).toBe('required')
    expect(r.latest).toBe('9.9.9')
  })

  it('honours an explicit manifestUrl', async () => {
    let seen = ''
    mockFetch((url) => {
      seen = url
      return { ok: true, body: manifest({ latest: '2.0.0', minSupported: '1.5.0' }) }
    })
    await checkClientVersion({ client: 'sdk', version: '1.0.0', manifestUrl: 'https://mirror.test/v.json' })
    expect(seen).toContain('https://mirror.test/v.json?_cb=')
  })

  it('fails open on a non-OK HTTP response', async () => {
    mockFetch(() => ({ ok: false, body: '' }))
    expect(await checkClientVersion({ client: 'sdk', version: '1.0.0' }))
      .toEqual({ status: 'ok', current: '1.0.0' })
  })

  it('fails open on a network error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    expect(await checkClientVersion({ client: 'sdk', version: '1.0.0' }))
      .toEqual({ status: 'ok', current: '1.0.0' })
  })

  it('fails open when the body is not JSON', async () => {
    mockFetch(() => ({ ok: true, body: 'not json' }))
    expect((await checkClientVersion({ client: 'sdk', version: '1.0.0' })).status).toBe('ok')
  })

  it('fails open when the manifest has no clients map', async () => {
    mockFetch(() => ({ ok: true, body: {} }))
    expect((await checkClientVersion({ client: 'sdk', version: '1.0.0' })).status).toBe('ok')
  })

  it('fails open when this client has no entry', async () => {
    mockFetch(() => ({ ok: true, body: { clients: { desktop: { latest: '9.9.9', minSupported: '9.9.9' } } } }))
    expect((await checkClientVersion({ client: 'sdk', version: '1.0.0' })).status).toBe('ok')
  })

  it('fails open when the entry is missing latest or minSupported', async () => {
    mockFetch(() => ({ ok: true, body: { clients: { sdk: { latest: '2.0.0' } } } }))
    expect((await checkClientVersion({ client: 'sdk', version: '1.0.0' })).status).toBe('ok')
  })

  it('fails open when the entry is missing latest (minSupported present)', async () => {
    mockFetch(() => ({ ok: true, body: { clients: { sdk: { minSupported: '1.5.0' } } } }))
    expect((await checkClientVersion({ client: 'sdk', version: '1.0.0' })).status).toBe('ok')
  })
})

describe('compareVersions', () => {
  it('treats missing trailing parts as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('tolerates a leading v', () => {
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0)
  })

  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
  })

  it('ignores a pre-release suffix on a segment', () => {
    expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(0)
  })
})

describe('SDK_VERSION', () => {
  it('stays in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(SDK_VERSION).toBe(pkg.version)
  })
})

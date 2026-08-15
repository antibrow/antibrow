import { describe, it, expect } from 'vitest'
import {
  planBinding, normalizeProxyUrl, proxyUrlToConfig, proxyLibraryClientId,
  type ProxyBinding,
} from '../src/proxy-binding'

const managed: ProxyBinding = { kind: 'managed', managedProxyId: 'px1' }
const libRef: ProxyBinding = { kind: 'local', localProxyId: 'sdk-abc' }

describe('planBinding', () => {
  it('keeps an existing binding when the input is omitted', () => {
    expect(planBinding(managed, undefined, undefined)).toEqual({ action: 'keep' })
    expect(planBinding(undefined, undefined, undefined)).toEqual({ action: 'keep' })
  })

  it('clears only when something is bound', () => {
    expect(planBinding(managed, undefined, null)).toEqual({ action: 'clear' })
    expect(planBinding(undefined, undefined, null)).toEqual({ action: 'keep' })
  })

  it('short-circuits an identical url', () => {
    expect(planBinding(libRef, 'http://u:p@h.io:8080', 'http://u:p@h.io:8080'))
      .toEqual({ action: 'keep' })
    expect(planBinding(libRef, 'http://u:p@h.io:8080', 'http://u:p@H.IO:8080'))
      .toEqual({ action: 'keep' })
  })

  it('binds a different url', () => {
    expect(planBinding(libRef, 'http://u:p@h.io:8080', 'http://u:p@other.io:8080'))
      .toEqual({ action: 'bindUrl', url: 'http://u:p@other.io:8080' })
    expect(planBinding(undefined, undefined, 'socks5://h.io:1080'))
      .toEqual({ action: 'bindUrl', url: 'socks5://h.io:1080' })
  })

  it('reuses a managed binding when no id is given', () => {
    expect(planBinding(managed, undefined, { kind: 'managed' })).toEqual({ action: 'keep' })
  })

  it('claims when managed is asked for and nothing is bound', () => {
    expect(planBinding(undefined, undefined, { kind: 'managed' })).toEqual({ action: 'claim' })
  })

  it('overwrites a url binding when managed is asked for', () => {
    expect(planBinding(libRef, 'http://u:p@h.io:8080', { kind: 'managed' }))
      .toEqual({ action: 'claim' })
  })

  it('honours an explicit managed id', () => {
    expect(planBinding(managed, undefined, { kind: 'managed', managedProxyId: 'px1' }))
      .toEqual({ action: 'keep' })
    expect(planBinding(managed, undefined, { kind: 'managed', managedProxyId: 'px2' }))
      .toEqual({ action: 'bindManaged', managedProxyId: 'px2' })
    expect(planBinding(undefined, undefined, { kind: 'managed', managedProxyId: 'px2' }))
      .toEqual({ action: 'bindManaged', managedProxyId: 'px2' })
  })
})

describe('normalizeProxyUrl', () => {
  it('lowercases the host and keeps credentials and port', () => {
    expect(normalizeProxyUrl('HTTP://User:Pw@Proxy.IO:8080'))
      .toBe('http://User:Pw@proxy.io:8080')
  })

  it('rejects an unparseable url', () => {
    expect(() => normalizeProxyUrl('not a url')).toThrow(/proxy url/i)
  })
})

describe('proxyUrlToConfig', () => {
  it('maps schemes onto the library config type', () => {
    expect(proxyUrlToConfig('socks5://u:p@h.io:1080'))
      .toEqual({ type: 'SOCKS5', host: 'h.io', port: 1080, username: 'u', password: 'p' })
  })

  it('recovers an explicit default port that WHATWG URL drops', () => {
    expect(proxyUrlToConfig('https://h.io:443'))
      .toEqual({ type: 'HTTP', host: 'h.io', port: 443 })
  })

  it('does not mistake a path segment for a port', () => {
    expect(normalizeProxyUrl('https://h.io/x:8080')).toBe('https://h.io')
    expect(() => proxyUrlToConfig('https://h.io/x:8080')).toThrow(/needs a port/i)
  })

  it('rejects an unsupported scheme', () => {
    expect(() => proxyUrlToConfig('ftp://h.io:21')).toThrow(/unsupported proxy scheme/i)
  })

  it('rejects a url with no recoverable port', () => {
    expect(() => proxyUrlToConfig('socks5://h.io')).toThrow(/needs a port/i)
  })
})

describe('credential redaction in thrown error messages', () => {
  // These errors are thrown out of profile() into whatever logs the caller's
  // stack traces - the raw url (and its password) must never land there.
  function messageOf(fn: () => unknown): string {
    try {
      fn()
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('expected fn to throw')
  }

  it('redacts the password when a url is missing its port', () => {
    const message = messageOf(() => proxyUrlToConfig('https://user:pass@h.io/path:8080'))
    expect(message).toContain('***@h.io')
    expect(message).not.toContain('user:pass@')
  })

  it('redacts the password when a url has no recoverable host', () => {
    const message = messageOf(() => proxyUrlToConfig('https://user:pass@'))
    expect(message).toContain('***@')
    expect(message).not.toContain('user:pass@')
  })
})

describe('proxyLibraryClientId', () => {
  it('is stable for the same endpoint and differs across endpoints', () => {
    const a = proxyLibraryClientId({ type: 'HTTP', host: 'h.io', port: 8080, username: 'u', password: 'p' })
    const b = proxyLibraryClientId({ type: 'HTTP', host: 'h.io', port: 8080, username: 'u', password: 'DIFFERENT' })
    const c = proxyLibraryClientId({ type: 'HTTP', host: 'h.io', port: 9090, username: 'u', password: 'p' })
    expect(a).toMatch(/^sdk-[0-9a-f]{16}$/)
    expect(b).toBe(a)
    expect(c).not.toBe(a)
  })
})

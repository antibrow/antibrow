import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { proxyConfigToUrl } from '../src/api'
import { proxyUrlToConfig, normalizeProxyUrl, planBinding } from '../src/proxy-binding'

const KEY = crypto.randomBytes(32).toString('base64url')
const URL_ = `relay://alice:s3cret@relay.example.com:443?key=${KEY}`

// A relay url carries more than host/port/user/pass: the pre-shared key that
// selects the encrypted protocol lives in the query string. A library row that
// rebuilds the url from fields alone would hand back a plaintext-protocol url,
// so the row keeps the url itself and that url is the source of truth.
describe('relay rows in the proxy library', () => {
  it('keeps the whole url on the config', () => {
    expect(proxyUrlToConfig(URL_)).toEqual({
      type: 'RELAY',
      host: 'relay.example.com',
      port: 443,
      username: 'alice',
      password: 's3cret',
      url: URL_,
    })
  })

  it('defaults to 443 when the url omits the port', () => {
    const c = proxyUrlToConfig(`relay://alice:s3cret@relay.example.com?key=${KEY}`)
    expect(c.port).toBe(443)
    expect(c.url).toBe(`relay://alice:s3cret@relay.example.com?key=${KEY}`)
  })

  it('round-trips through the url, key included', () => {
    expect(proxyConfigToUrl(proxyUrlToConfig(URL_))).toBe(URL_)
  })

  it('refuses to rebuild a relay url from fields alone', () => {
    // Dropping the key here would produce a url that still launches - over the
    // relay's plaintext protocol. Failing is the only honest outcome.
    expect(() => proxyConfigToUrl({ type: 'RELAY', host: 'relay.example.com', port: 443 }))
      .toThrow(/relay/i)
  })

  it('leaves the other schemes building their url from fields', () => {
    expect(proxyConfigToUrl({ type: 'SOCKS5', host: 'h', port: 1080, username: 'u', password: 'p' }))
      .toBe('socks5://u:p@h:1080')
  })

  it('treats a different key as a different proxy', () => {
    const other = `relay://alice:s3cret@relay.example.com:443?key=${crypto.randomBytes(32).toString('base64url')}`
    expect(normalizeProxyUrl(URL_)).toBe(normalizeProxyUrl(URL_))
    expect(normalizeProxyUrl(URL_)).not.toBe(normalizeProxyUrl(other))
    // ...and adding a key to a bound keyless relay is a rebind, not a no-op
    expect(planBinding({ kind: 'url', url: 'relay://alice:s3cret@relay.example.com:443' },
      'relay://alice:s3cret@relay.example.com:443', URL_))
      .toEqual({ action: 'bindUrl', url: URL_ })
  })

  it('keeps the key out of the error text, like the password', () => {
    let msg = ''
    try { proxyUrlToConfig(`relay://alice:s3cret@?key=${KEY}`) } catch (e) { msg = (e as Error).message }
    expect(msg).not.toContain(KEY)
    expect(msg).not.toContain('s3cret')
  })
})

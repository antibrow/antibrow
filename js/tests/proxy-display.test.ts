import { describe, expect, it } from 'vitest'
import { managedProxyDisplayName, managedProxyShortId } from '../src/proxy-display'

describe('managed proxy display helpers', () => {
  it('uses the last 6 id characters as the short id', () => {
    expect(managedProxyShortId('cmpweu32v0001wprcsemxhkm2')).toBe('mxhkm2')
  })

  it('formats managed proxies as managed plus short id', () => {
    expect(managedProxyDisplayName('cmpweu32v0001wprcsemxhkm2')).toBe('managed mxhkm2')
  })
})

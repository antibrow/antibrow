import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { mintLicenseToken } from '../../src/core/license'

const SEED = '11'.repeat(32)
const NOW = 1700000000000

function seedBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(SEED, 'hex'))
}

function decode(token: string) {
  const [p, s] = token.split('.')
  return { payload: Buffer.from(p!, 'base64').toString('utf8'), sig: Uint8Array.from(Buffer.from(s!, 'base64')) }
}

describe('mintLicenseToken', () => {
  it('signs a fixed payload that verifies with the matching public key', () => {
    const { token, exp } = mintLicenseToken(SEED, 3, NOW)
    const { payload, sig } = decode(token)
    expect(payload).toBe('{"v":1,"iat":1700000000,"exp":1700086400,"mi":3}')
    expect(exp).toBe(1700086400)
    const { publicKey } = nacl.sign.keyPair.fromSeed(seedBytes())
    expect(nacl.sign.detached.verify(new TextEncoder().encode(payload), sig, publicKey)).toBe(true)
  })

  it('clamps an invalid concurrency to 1', () => {
    expect(JSON.parse(decode(mintLicenseToken(SEED, 0, NOW).token).payload).mi).toBe(1)
    expect(JSON.parse(decode(mintLicenseToken(SEED, Number.NaN, NOW).token).payload).mi).toBe(1)
    expect(JSON.parse(decode(mintLicenseToken(SEED, 2.7, NOW).token).payload).mi).toBe(2)
  })

  it('refuses to sign without a key', () => {
    expect(() => mintLicenseToken('', 1, NOW)).toThrow(/not configured/)
  })
})

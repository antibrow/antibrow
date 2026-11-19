import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/core/config'

const base = { DATABASE_URL: 'postgres://x', FP_LICENSE_PRIVKEY: 'a'.repeat(64), OEM_PUBLIC_URL: 'https://api.acme.com' }

describe('readConfig', () => {
  it('applies defaults', () => {
    const c = readConfig(base)
    expect(c.s3).toBeNull()
    expect(c.brand).toEqual({
      name: 'AntiBrow',
      logoUrl: '',
      accent: '',
      links: { website: '', docs: '', upgrade: '', support: '' },
    })
    expect(c.kernelManifestUrl).toBe('https://download.antibrow.com/fp-browser-versions.json')
    expect(c.appVersionsKey).toBe('app-versions.json')
    expect(c.recipeRegistryUrl).toBe('')
  })

  it('reads a complete S3 block with default region', () => {
    const c = readConfig({ ...base, S3_ENDPOINT: 'http://m:9000', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' })
    expect(c.s3).toEqual({ endpoint: 'http://m:9000', publicEndpoint: 'http://m:9000', region: 'auto', addressing: 'path', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
  })

  it('reads an optional public S3 endpoint', () => {
    const c = readConfig({ ...base, S3_ENDPOINT: 'http://m:9000', S3_PUBLIC_ENDPOINT: 'https://s3.example.com', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' })
    expect(c.s3?.endpoint).toBe('http://m:9000')
    expect(c.s3?.publicEndpoint).toBe('https://s3.example.com')
  })

  it('names the missing S3 variables', () => {
    expect(() => readConfig({ ...base, S3_ENDPOINT: 'http://m:9000', S3_BUCKET: 'b' })).toThrow(/S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/)
  })

  it('requires database url and license key', () => {
    expect(() => readConfig({ FP_LICENSE_PRIVKEY: 'a' })).toThrow(/DATABASE_URL/)
    expect(() => readConfig({ DATABASE_URL: 'x' })).toThrow(/FP_LICENSE_PRIVKEY/)
  })

  it('rejects an all-zero license key', () => {
    expect(() => readConfig({ ...base, FP_LICENSE_PRIVKEY: '0'.repeat(64) })).toThrow(/all-zero/)
  })

  it('reads brand variables', () => {
    const c = readConfig({
      ...base,
      OEM_BRAND_NAME: 'Acme',
      OEM_BRAND_LOGO_URL: 'https://acme.com/l.png',
      OEM_BRAND_ACCENT: '#112233',
      OEM_LINK_WEBSITE: 'https://acme.com',
      OEM_LINK_SUPPORT: 'mailto:help@acme.com',
    })
    expect(c.brand.name).toBe('Acme')
    expect(c.brand.accent).toBe('#112233')
    expect(c.brand.links).toEqual({ website: 'https://acme.com', docs: '', upgrade: '', support: 'mailto:help@acme.com' })
  })

  it('rejects an invalid accent color', () => {
    expect(() => readConfig({ ...base, OEM_BRAND_ACCENT: 'red' })).toThrow(/OEM_BRAND_ACCENT/)
    expect(() => readConfig({ ...base, OEM_BRAND_ACCENT: '#12345' })).toThrow(/OEM_BRAND_ACCENT/)
  })

  it('reads and validates S3_ADDRESSING', () => {
    const e = { ...base, S3_ENDPOINT: 'http://m:9000', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }
    expect(readConfig({ ...e, S3_ADDRESSING: 'virtual' }).s3?.addressing).toBe('virtual')
    expect(() => readConfig({ ...e, S3_ADDRESSING: 'bogus' })).toThrow(/S3_ADDRESSING/)
  })
})

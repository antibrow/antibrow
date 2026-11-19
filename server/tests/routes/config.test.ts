import { describe, expect, it } from 'vitest'
import { protocol } from '../../src/core'
import { call } from './harness'

const env = { DATABASE_URL: 'postgres://unused' }

describe('public routes', () => {
  it('config needs no key and matches the protocol schema', async () => {
    const res = await call('/api/v1/config', {
      env: { ...env, OEM_BRAND_NAME: 'Acme', OEM_BRAND_ACCENT: '#112233', RECIPE_REGISTRY_URL: 'https://r.acme.com/registry.json' },
    })
    expect(res.status).toBe(200)
    const body = protocol.configResponse.parse(await res.json())
    expect(body.features.team).toBe(false)
    expect(body.features.cloudSync).toBe(true)
    expect(body.features.emailLogin).toBe(false)
    expect(body.brand.name).toBe('Acme')
    expect(body.brand.accent).toBe('#112233')
    expect(body.appVersionsUrl).toBe('https://api.acme.com/api/v1/app-versions')
    expect(body.kernelManifestUrl).toBe('https://download.antibrow.com/fp-browser-versions.json')
    expect(body.recipeRegistryUrl).toBe('https://r.acme.com/registry.json')
  })

  it('config falls back to the request origin when OEM_PUBLIC_URL is unset', async () => {
    const res = await call('/api/v1/config', { env: { ...env, OEM_PUBLIC_URL: '' } })
    const body = protocol.configResponse.parse(await res.json())
    expect(body.appVersionsUrl).toBe('http://localhost/api/v1/app-versions')
  })

  it('app-versions is public and empty without storage', async () => {
    const res = await call('/api/v1/app-versions', { env })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('version/check is public, validates params, and is open without a policy', async () => {
    expect((await call('/api/v1/version/check?version=1.0.0', { env })).status).toBe(400)
    const res = await call('/api/v1/version/check?client=desktop&version=1.0.0', { env })
    expect(await res.json()).toEqual({ status: 'ok', current: '1.0.0', latest: null })
  })

  it('geo is public and returns an empty structure off Cloudflare', async () => {
    const res = await call('/api/v1/geo', { env })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ip: null, country: null, countryCode: null, countryName: null, city: null, timezone: null })
  })

  it('keyed routes do not run without a key', async () => {
    expect((await call('/api/v1/account', { env })).status).toBe(401)
  })
})

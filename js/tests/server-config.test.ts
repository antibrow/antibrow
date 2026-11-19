import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_SERVER,
  DEFAULT_KERNEL_MANIFEST_URL,
  FeatureUnavailableError,
  assertServerFeature,
  getServerConfig,
  resolveServer,
  serverConfigCachePath,
  SERVER_CONFIG_FAILURE_TTL_MS,
  type ServerConfig,
} from '../src/server-config'

const OEM: ServerConfig = {
  brand: { name: 'Acme Browser', logoUrl: '', accent: '#4F8CFF', links: { website: 'https://acme.com', docs: '', upgrade: '', support: '' } },
  kernelManifestUrl: DEFAULT_KERNEL_MANIFEST_URL,
  appVersionsUrl: 'https://api.acme.com/api/v1/app-versions',
  recipeRegistryUrl: '',
  features: { cloudSync: true, team: false, share: false, managedProxy: false, liveView: false, realDevices: false, emailLogin: false },
}

let cacheDir: string
const savedEnv = process.env.ANTI_DETECT_BROWSER_SERVER

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-config-'))
  delete process.env.ANTI_DETECT_BROWSER_SERVER
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env.ANTI_DETECT_BROWSER_SERVER
  else process.env.ANTI_DETECT_BROWSER_SERVER = savedEnv
})

function serveConfig(body: unknown = OEM) {
  const mock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', mock)
  return mock
}

function failFetch() {
  const mock = vi.fn(async () => { throw new TypeError('fetch failed') })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('resolveServer', () => {
  it('prefers the explicit value, then the env var, then the default', () => {
    process.env.ANTI_DETECT_BROWSER_SERVER = 'https://env.example.com'
    expect(resolveServer('https://api.acme.com')).toBe('https://api.acme.com')
    expect(resolveServer()).toBe('https://env.example.com')
    delete process.env.ANTI_DETECT_BROWSER_SERVER
    expect(resolveServer()).toBe(DEFAULT_SERVER)
  })

  it('strips trailing slashes', () => {
    expect(resolveServer('https://api.acme.com///')).toBe('https://api.acme.com')
    process.env.ANTI_DETECT_BROWSER_SERVER = 'https://env.example.com/'
    expect(resolveServer()).toBe('https://env.example.com')
  })
})

describe('getServerConfig', () => {
  it('fetches the config route and caches it per server', async () => {
    const mock = serveConfig()
    const config = await getServerConfig('https://api.acme.com/', { cacheDir })
    expect(config.brand.name).toBe('Acme Browser')
    expect(mock.mock.calls[0]![0]).toBe('https://api.acme.com/api/v1/config')
    const file = serverConfigCachePath('https://api.acme.com', cacheDir)
    expect(path.basename(file)).toMatch(/^server-config-[0-9a-f]{12}\.json$/)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('answers from a fresh cache without a request', async () => {
    serveConfig()
    await getServerConfig('https://api.acme.com', { cacheDir })
    const mock = serveConfig({ ...OEM, brand: { ...OEM.brand, name: 'Changed' } })
    const config = await getServerConfig('https://api.acme.com', { cacheDir })
    expect(mock).not.toHaveBeenCalled()
    expect(config.brand.name).toBe('Acme Browser')
  })

  it('force asks again even with a fresh cache', async () => {
    serveConfig()
    await getServerConfig('https://api.acme.com', { cacheDir })
    const mock = serveConfig({ ...OEM, brand: { ...OEM.brand, name: 'Changed' } })
    const config = await getServerConfig('https://api.acme.com', { cacheDir, force: true })
    expect(mock).toHaveBeenCalledTimes(1)
    expect(config.brand.name).toBe('Changed')
  })

  it('asks again once the cache is older than an hour', async () => {
    serveConfig()
    await getServerConfig('https://api.acme.com', { cacheDir })
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    fs.utimesSync(serverConfigCachePath('https://api.acme.com', cacheDir), old, old)
    const mock = serveConfig()
    await getServerConfig('https://api.acme.com', { cacheDir })
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('reads a stale cache when the request fails', async () => {
    serveConfig()
    await getServerConfig('https://api.acme.com', { cacheDir })
    const old = (Date.now() - 5 * 60 * 60 * 1000) / 1000
    fs.utimesSync(serverConfigCachePath('https://api.acme.com', cacheDir), old, old)
    failFetch()
    const config = await getServerConfig('https://api.acme.com', { cacheDir, force: true })
    expect(config.brand.name).toBe('Acme Browser')
  })

  it('does not ask a failing server again for a while', async () => {
    const first = failFetch()
    await getServerConfig('https://api.acme.com', { cacheDir })
    expect(first).toHaveBeenCalledTimes(1)
    const second = failFetch()
    const config = await getServerConfig('https://api.acme.com', { cacheDir })
    expect(second).not.toHaveBeenCalled()
    expect(config.features.managedProxy).toBe(false)
    const forced = serveConfig()
    expect((await getServerConfig('https://api.acme.com', { cacheDir, force: true })).brand.name).toBe('Acme Browser')
    expect(forced).toHaveBeenCalledTimes(1)
  })

  it('asks again once the failure has aged out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      failFetch()
      await getServerConfig('https://api.acme.com', { cacheDir })
      vi.setSystemTime(Date.now() + SERVER_CONFIG_FAILURE_TTL_MS + 1)
      const mock = serveConfig()
      expect((await getServerConfig('https://api.acme.com', { cacheDir })).brand.name).toBe('Acme Browser')
      expect(mock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a malformed body as a failure', async () => {
    serveConfig({ brand: 'nope' })
    const config = await getServerConfig('https://api.acme.com', { cacheDir })
    expect(config.features.managedProxy).toBe(false)
    expect(fs.existsSync(serverConfigCachePath('https://api.acme.com', cacheDir))).toBe(false)
  })

  it('falls back to the built-in AntiBrow config for the default server', async () => {
    failFetch()
    const config = await getServerConfig(DEFAULT_SERVER, { cacheDir })
    expect(config.brand.name).toBe('AntiBrow')
    expect(Object.values(config.features).every(Boolean)).toBe(true)
    expect(config.recipeRegistryUrl).not.toBe('')
  })

  it('config failure never falls back to antibrow business hosts', async () => {
    failFetch()
    const config = await getServerConfig('https://api.acme.com', { cacheDir })
    expect(config.features.managedProxy).toBe(false)
    expect(config.features.liveView).toBe(false)
    expect(config.features.realDevices).toBe(false)
    expect(config.recipeRegistryUrl).toBe('')
    expect(config.kernelManifestUrl).toBe(DEFAULT_KERNEL_MANIFEST_URL)
  })
})

describe('assertServerFeature', () => {
  it('throws FeatureUnavailableError naming the feature', async () => {
    serveConfig()
    const err = await assertServerFeature('https://api.acme.com', 'managedProxy', { cacheDir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FeatureUnavailableError)
    expect((err as FeatureUnavailableError).feature).toBe('managedProxy')
    expect((err as Error).message).toContain('https://api.acme.com')
  })

  it('treats an empty registry url as recipes off', async () => {
    serveConfig()
    await expect(assertServerFeature('https://api.acme.com', 'recipes', { cacheDir }))
      .rejects.toBeInstanceOf(FeatureUnavailableError)
  })

  it('passes a feature the server turns on', async () => {
    serveConfig({ ...OEM, features: { ...OEM.features, liveView: true } })
    await expect(assertServerFeature('https://api.acme.com', 'liveView', { cacheDir })).resolves.toBeTruthy()
  })

  it('does not ask the default server', async () => {
    const mock = failFetch()
    await assertServerFeature(undefined, 'managedProxy', { cacheDir })
    expect(mock).not.toHaveBeenCalled()
  })
})

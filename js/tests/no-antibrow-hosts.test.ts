import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { AntiDetectBrowser } from '../src/browser'
import { getAccount, listServerProfiles, listProxies } from '../src/api'
import { getLicenseToken, refreshKernelVersions } from '../src/engine'
import { fetchRealDevice } from '../src/engine/devices'
import { lookupCurrentGeo } from '../src/geo'
import { registerLiveSession } from '../src/liveview'
import { loadRegistry } from '../src/recipe/registry'
import { FeatureUnavailableError } from '../src/server-config'

const SERVER = 'https://api.acme.com'
const ALLOWED = new Set(['api.acme.com', 'download.antibrow.com', 'ip-api.com'])

const OEM_CONFIG = {
  brand: { name: 'Acme Browser', logoUrl: '', accent: '', links: { website: 'https://acme.com', docs: '', upgrade: '', support: '' } },
  kernelManifestUrl: 'https://download.antibrow.com/fp-browser-versions.json',
  appVersionsUrl: 'https://api.acme.com/api/v1/app-versions',
  recipeRegistryUrl: '',
  features: { cloudSync: true, team: false, share: false, managedProxy: false, liveView: false, realDevices: false, emailLogin: false },
}

let hosts: string[]
let tmp: string
let configStatus: number
const savedHome = process.env.HOME

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function route(url: URL): Response {
  if (url.hostname === 'api.acme.com') {
    switch (url.pathname) {
      case '/api/v1/config': return configStatus === 200 ? json(OEM_CONFIG) : json({ error: { code: 'NOT_FOUND', message: '' } }, configStatus)
      case '/api/v1/account': return json({ email: 'a@acme.com', plan: 'FREE', expiresAt: null, concurrency: 1, syncEnabled: true, profileLimit: 5, profileCount: 0, profileRemaining: 5 })
      case '/api/v1/engine/token': return json({ token: 'e30.sig', exp: Math.floor(Date.now() / 1000) + 86400, mi: 2, sync: true })
      case '/api/v1/profiles': return json({ profiles: [], serverTime: new Date().toISOString() })
      default: return json({ error: { code: 'NOT_FOUND', message: '' } }, 404)
    }
  }
  if (url.hostname === 'download.antibrow.com') return json({ versions: [] })
  if (url.hostname === 'ip-api.com') return json({ status: 'success', countryCode: 'US', timezone: 'America/New_York' })
  return json({}, 200)
}

function hostOf(arg: unknown): string {
  if (typeof arg === 'string') return new URL(arg).hostname
  if (arg instanceof URL) return arg.hostname
  const o = arg as { hostname?: string; host?: string }
  return (o.hostname ?? o.host ?? '').split(':')[0]!
}

beforeEach(() => {
  hosts = []
  configStatus = 200
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-antibrow-'))
  // Anything that falls back to the default cache dir lands here, not in the real home.
  process.env.HOME = tmp
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url)
    hosts.push(url.hostname)
    return route(url)
  }))
  for (const mod of [http, https]) {
    for (const fn of ['request', 'get'] as const) {
      vi.spyOn(mod, fn).mockImplementation(((arg: unknown) => {
        hosts.push(hostOf(arg))
        throw new Error('network disabled in this test')
      }) as never)
    }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  process.env.HOME = savedHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function exerciseSdk(): Promise<void> {
  const key = `adb_${Math.random().toString(36).slice(2)}`
  const cacheDir = path.join(tmp, 'cache')

  await getAccount({ key, server: SERVER })
  await getLicenseToken({ key, server: SERVER })
  await refreshKernelVersions(cacheDir, { force: true, server: SERVER })
  await lookupCurrentGeo(SERVER)
  await listServerProfiles({ key, server: SERVER })

  const ab = new AntiDetectBrowser({ key, server: SERVER, cacheDir, notify: () => {} })
  await expect(ab.launch({ profile: 'p1', proxyId: 'px1', focusWindow: false }))
    .rejects.toBeInstanceOf(FeatureUnavailableError)
  await expect(ab.launch({ profile: 'p1', liveView: true, focusWindow: false }))
    .rejects.toBeInstanceOf(FeatureUnavailableError)
  await expect(registerLiveSession({ key, server: SERVER, sessionKey: 's1', cacheDir }))
    .rejects.toBeInstanceOf(FeatureUnavailableError)
  await expect(listProxies({ key, server: SERVER })).rejects.toBeInstanceOf(FeatureUnavailableError)
  await expect(fetchRealDevice({ os: 'windows', key, server: SERVER, cacheDir }))
    .rejects.toBeInstanceOf(FeatureUnavailableError)
  await expect(loadRegistry({ cacheDir, server: SERVER, env: {} }))
    .rejects.toBeInstanceOf(FeatureUnavailableError)
}

describe('custom server', () => {
  it('never reaches an antibrow host other than the download site', async () => {
    await exerciseSdk()
    expect(hosts).toContain('api.acme.com')
    expect(hosts.filter((h) => !ALLOWED.has(h))).toEqual([])
  })

  it('stays off antibrow business hosts when the config route is missing', async () => {
    configStatus = 404
    await exerciseSdk()
    expect(hosts.filter((h) => !ALLOWED.has(h))).toEqual([])
  })
})

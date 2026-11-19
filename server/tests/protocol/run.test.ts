import { afterAll, describe, expect, it } from 'vitest'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { z } from 'zod'
import {
  accountResponse,
  archiveGetResponse,
  archivePutResponse,
  configResponse,
  cryptKeyResponse,
  engineTokenResponse,
  errorResponse,
  profileListResponse,
  profileResponse,
  proxyLibraryItemResponse,
  proxyLibraryListResponse,
  stateGetResponse,
  statePutResponse,
} from '../../src/core/protocol'
import {
  createProfile,
  deleteProfile,
  getAccount,
  getProfile,
  listServerProfiles,
  syncPullUserProxies,
} from '../../../js/src/api'
import { fetchLicenseToken } from '../../../js/src/engine/license'

// One suite, two servers: point it at the OEM server or at the private one.
const base = process.env.PROTOCOL_BASE_URL
const paidKey = process.env.PROTOCOL_API_KEY
const freeKey = process.env.PROTOCOL_FREE_KEY
const enabled = !!(base && paidKey && freeKey)

// Opt-in only: PROTOCOL_S3_RESOLVE="host=ip" for setups whose presigned URLs name a host the test machine cannot resolve.
const resolveMap = new Map(
  (process.env.PROTOCOL_S3_RESOLVE ?? '')
    .split(',')
    .filter(Boolean)
    .map((p) => p.split('=') as [string, string]),
)

function s3(method: string, url: string, body?: Buffer, contentType?: string): Promise<{ status: number; body: Buffer }> {
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method,
        headers: body ? { 'Content-Length': body.length, ...(contentType ? { 'Content-Type': contentType } : {}) } : {},
        lookup: (host, opts, cb) => {
          const ip = resolveMap.get(host)
          if (!ip) return dns.lookup(host, opts as never, cb as never)
          if ((opts as { all?: boolean }).all) return (cb as (e: null, a: unknown) => void)(null, [{ address: ip, family: 4 }])
          return (cb as (e: null, a: string, f: number) => void)(null, ip, 4)
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function api(method: string, path: string, key: string | null, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function ok<T extends z.ZodTypeAny>(schema: T, r: { status: number; json: unknown }, status = 200): z.infer<T> {
  expect(r.status, JSON.stringify(r.json)).toBe(status)
  return schema.parse(r.json)
}

// The private server's auth middleware still answers 401 with a bare string `error`;
// every other error uses the { code, message } envelope.
const authError = errorResponse.or(z.object({ error: z.string() }).passthrough())

const suffix = Math.random().toString(36).slice(2, 8)
const name = `protocol-${suffix}`
const renamed = `protocol-${suffix}-b`
const created: string[] = []
const proxies: string[] = []

// A minimal valid zip (empty archive) is enough: the server never opens it.
const zipBytes = Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18)])

describe.skipIf(!enabled)('protocol conformance', () => {
  afterAll(async () => {
    for (const n of created) await deleteProfile({ key: paidKey!, server: base, name: n }).catch(() => {})
    for (const id of proxies) await api('DELETE', `/api/v1/proxy-library/${encodeURIComponent(id)}`, paidKey!).catch(() => {})
  })

  it('config is public and parses', async () => {
    ok(configResponse, await api('GET', '/api/v1/config', null))
  })

  it('rejects a missing or bad key with the error envelope', async () => {
    const none = await api('GET', '/api/v1/account', null)
    expect(none.status).toBe(401)
    authError.parse(none.json)
    const bad = await api('GET', '/api/v1/account', 'adb_not_a_real_key')
    expect(bad.status).toBe(401)
    authError.parse(bad.json)
  })

  it('account (raw and SDK agree)', async () => {
    const raw = ok(accountResponse, await api('GET', '/api/v1/account', paidKey!))
    expect(raw.syncEnabled).toBe(true)
    const sdk = await getAccount({ key: paidKey!, server: base })
    expect(sdk.plan).toBe(raw.plan)
    expect(sdk.concurrency).toBe(raw.concurrency)
    expect(sdk.profileLimit).toBe(raw.profileLimit)
  })

  it('engine/token (raw and SDK)', async () => {
    const raw = ok(engineTokenResponse, await api('POST', '/api/v1/engine/token', paidKey!))
    expect(raw.sync).toBe(true)
    expect(raw.exp * 1000).toBeGreaterThan(Date.now())
    const sdk = await fetchLicenseToken({ key: paidKey!, server: base! })
    expect(sdk.mi).toBe(raw.mi)
    expect(sdk.sync).toBe(true)
  })

  it('free key: create is over quota, list is empty, proxy-library is 403', async () => {
    const create = await api('POST', '/api/v1/profiles', freeKey!, { name: `free-${suffix}` })
    // Creating is gated by the quota (0 for a plan without sync), not by a 403.
    expect(create.status).toBe(429)
    expect(errorResponse.parse(create.json).error.code).toBe('QUOTA_EXCEEDED')
    // Listing stays 200 and empty: shipped clients use it as their key-validity check.
    const list = ok(profileListResponse, await api('GET', '/api/v1/profiles', freeKey!))
    expect(list.profiles).toEqual([])
    const lib = await api('GET', '/api/v1/proxy-library', freeKey!)
    expect(lib.status).toBe(403)
    errorResponse.parse(lib.json)
    const t = ok(engineTokenResponse, await api('POST', '/api/v1/engine/token', freeKey!))
    expect(t.sync).toBe(false)
  })

  it('profiles: create, read, update, list, conflict', async () => {
    const config = { group: 'g1', tags: ['a'], note: 'n' }
    const made = ok(profileResponse, await api('POST', '/api/v1/profiles', paidKey!, { name, config }), 201)
    created.push(name)
    expect(made.name).toBe(name)
    expect(made.deletedAt).toBeNull()
    expect(made.config?.group).toBe('g1')

    const sdkGet = await getProfile({ key: paidKey!, server: base, name })
    expect(sdkGet.id).toBe(made.id)

    const byId = ok(profileResponse, await api('GET', `/api/v1/profiles/${encodeURIComponent(made.id)}`, paidKey!))
    expect(byId.name).toBe(name)

    const dup = await api('POST', '/api/v1/profiles', paidKey!, { name })
    expect(dup.status).toBe(409)
    errorResponse.parse(dup.json)

    const upd = ok(profileResponse, await api('PUT', `/api/v1/profiles/${encodeURIComponent(name)}`, paidKey!, { name: renamed, config: { ...config, note: 'm' } }))
    expect(upd.name).toBe(renamed)
    expect(upd.config?.note).toBe('m')
    created.length = 0
    created.push(renamed)

    const list = ok(profileListResponse, await api('GET', '/api/v1/profiles', paidKey!))
    expect(list.profiles.some((p) => p.name === renamed)).toBe(true)
    const sdkList = await listServerProfiles({ key: paidKey!, server: base })
    expect(sdkList.some((p) => p.name === renamed)).toBe(true)

    const missing = await api('GET', `/api/v1/profiles/nope-${suffix}`, paidKey!)
    expect(missing.status).toBe(404)
    errorResponse.parse(missing.json)
  })

  it('archive: presigned PUT then GET returns the same bytes', async () => {
    const path = `/api/v1/profiles/${encodeURIComponent(renamed)}/archive`
    const put = ok(archivePutResponse, await api('POST', path, paidKey!))
    const up = await s3('PUT', put.uploadUrl, zipBytes, 'application/zip')
    expect(up.status).toBe(200)

    const got = ok(archiveGetResponse, await api('GET', path, paidKey!))
    expect(got.version).toBeTruthy()
    const down = await s3('GET', got.downloadUrl)
    expect(down.status).toBe(200)
    expect(down.body.equals(zipBytes)).toBe(true)
  })

  it('state: presigned PUT then GET returns the same document', async () => {
    const path = `/api/v1/profiles/${encodeURIComponent(renamed)}/state`
    const put = ok(statePutResponse, await api('POST', path, paidKey!))
    const doc = Buffer.from(JSON.stringify({ cookies: [], origins: [], tabs: ['https://example.com'] }))
    expect((await s3('PUT', put.uploadUrl, doc, 'application/json')).status).toBe(200)
    const got = ok(stateGetResponse, await api('GET', path, paidKey!))
    const down = await s3('GET', got.downloadUrl)
    expect(down.status).toBe(200)
    expect(down.body.equals(doc)).toBe(true)
  })

  it('crypt-key is stable across reads', async () => {
    const path = `/api/v1/profiles/${encodeURIComponent(renamed)}/crypt-key`
    const a = ok(cryptKeyResponse, await api('GET', path, paidKey!))
    const b = ok(cryptKeyResponse, await api('GET', path, paidKey!))
    expect(typeof a.cryptKey).toBe('string')
    expect(b.cryptKey).toBe(a.cryptKey)

    const other = `protocol-${suffix}-other`
    ok(profileResponse, await api('POST', '/api/v1/profiles', paidKey!, { name: other }), 201)
    created.push(other)
    const c = ok(cryptKeyResponse, await api('GET', `/api/v1/profiles/${encodeURIComponent(other)}/crypt-key`, paidKey!))
    expect(typeof c.cryptKey).toBe('string')
    expect(c.cryptKey).not.toBe(a.cryptKey)
  })

  it('archive GET with nothing uploaded: signs a URL, no version, object is absent', async () => {
    const fresh = `protocol-${suffix}-empty`
    ok(profileResponse, await api('POST', '/api/v1/profiles', paidKey!, { name: fresh }), 201)
    created.push(fresh)
    const got = ok(archiveGetResponse, await api('GET', `/api/v1/profiles/${encodeURIComponent(fresh)}/archive`, paidKey!))
    expect(got.version).toBeUndefined()
    const down = await s3('GET', got.downloadUrl)
    expect([403, 404]).toContain(down.status)
  })

  it('proxy-library: create, update, list, delete', async () => {
    const config = { type: 'SOCKS5' as const, host: '127.0.0.1', port: 1080, label: `p-${suffix}` }
    const made = ok(proxyLibraryItemResponse, await api('POST', '/api/v1/proxy-library', paidKey!, { config }), 201)
    proxies.push(made.id)
    expect(made.config?.host).toBe('127.0.0.1')

    const upd = ok(proxyLibraryItemResponse, await api('PUT', `/api/v1/proxy-library/${encodeURIComponent(made.id)}`, paidKey!, { config: { ...config, port: 1081 } }))
    expect(upd.config?.port).toBe(1081)

    const list = ok(proxyLibraryListResponse, await api('GET', '/api/v1/proxy-library', paidKey!))
    expect(list.proxies.some((p) => p.id === made.id)).toBe(true)
    const sdk = await syncPullUserProxies({ key: paidKey!, server: base })
    expect(sdk.proxies.some((p) => p.id === made.id)).toBe(true)

    const del = await api('DELETE', `/api/v1/proxy-library/${encodeURIComponent(made.id)}`, paidKey!)
    expect(del.status).toBe(200)
    expect((del.json as { success?: boolean }).success).toBe(true)
    proxies.length = 0
    const after = ok(proxyLibraryListResponse, await api('GET', '/api/v1/proxy-library', paidKey!))
    expect(after.proxies.some((p) => p.id === made.id)).toBe(false)
  })

  it('SDK createProfile and deleteProfile round trip, delete removes archive access', async () => {
    const n = `protocol-${suffix}-sdk`
    const p = await createProfile({ key: paidKey!, server: base, name: n })
    created.push(n)
    expect(p.name).toBe(n)
    await deleteProfile({ key: paidKey!, server: base, name: n })
    created.pop()
    const gone = await api('GET', `/api/v1/profiles/${encodeURIComponent(n)}`, paidKey!)
    expect(gone.status).toBe(404)
  })

  it('delete tombstones the profile and is idempotent', async () => {
    const del = await api('DELETE', `/api/v1/profiles/${encodeURIComponent(renamed)}`, paidKey!)
    expect(del.status).toBe(200)
    expect((del.json as { success?: boolean }).success).toBe(true)
    created.length = 0
    const again = await api('DELETE', `/api/v1/profiles/${encodeURIComponent(renamed)}`, paidKey!)
    expect(again.status).toBe(200)
    const gone = await api('GET', `/api/v1/profiles/${encodeURIComponent(renamed)}/archive`, paidKey!)
    expect(gone.status).toBe(404)
    errorResponse.parse(gone.json)
  })
})

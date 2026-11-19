import { execFileSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../../src/lib/db'
import { call } from './harness'
import { testDatabaseUrl } from '../db-url'

const url = testDatabaseUrl()
const d = url ? describe : describe.skip

const ADMIN_ENV = {
  OEM_ADMIN_PASSWORD: 'correct horse',
  OEM_ADMIN_TOKEN: 'tok_admin_secret',
  OEM_SESSION_SECRET: 's'.repeat(32),
}
const bearer = { Authorization: `Bearer ${ADMIN_ENV.OEM_ADMIN_TOKEN}` }

const admin = (path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; env?: Record<string, string | undefined> } = {}) =>
  call(path, { ...opts, headers: opts.headers ?? bearer, env: { ...ADMIN_ENV, ...opts.env } })

async function login(): Promise<string> {
  const res = await admin('/api/admin/login', { method: 'POST', body: { password: ADMIN_ENV.OEM_ADMIN_PASSWORD }, headers: {} })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

d('admin api', () => {
  const db = getDb({ databaseUrl: url ?? '' })

  beforeEach(() => {
    execFileSync('npx', ['prisma', 'migrate', 'reset', '--force'], {
      env: { ...process.env, DATABASE_URL: url, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
      stdio: 'pipe',
    })
  }, 60_000)

  afterAll(() => db.$disconnect())

  it('is invisible when OEM_ADMIN_PASSWORD is unset', async () => {
    const res = await call('/api/admin/users', { headers: bearer, env: { OEM_ADMIN_TOKEN: 'tok_admin_secret' } })
    expect(res.status).toBe(404)
    const login = await call('/api/admin/login', { method: 'POST', body: { password: 'x' } })
    expect(login.status).toBe(404)
  })

  it('login: wrong password 401, right password sets a hardened cookie', async () => {
    const bad = await admin('/api/admin/login', { method: 'POST', body: { password: 'nope' }, headers: {} })
    expect(bad.status).toBe(401)
    const ok = await admin('/api/admin/login', { method: 'POST', body: { password: ADMIN_ENV.OEM_ADMIN_PASSWORD }, headers: {} })
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get('set-cookie')!
    expect(cookie).toMatch(/^oem_admin=/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Path=\//)
    expect(cookie).toMatch(/Max-Age=43200/)
    expect(cookie).not.toMatch(/Secure/)
  })

  it('login fails closed without a session secret', async () => {
    const res = await admin('/api/admin/login', {
      method: 'POST',
      body: { password: ADMIN_ENV.OEM_ADMIN_PASSWORD },
      headers: {},
      env: { OEM_SESSION_SECRET: undefined },
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('SESSION_SECRET_MISSING')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('cookie and bearer token both authenticate; tampered or missing credentials do not', async () => {
    const cookie = await login()
    expect((await admin('/api/admin/users', { headers: { Cookie: cookie } })).status).toBe(200)
    expect((await admin('/api/admin/users', { headers: bearer })).status).toBe(200)
    const [name, value] = cookie.split('=')
    const [exp, sig] = value!.split('.')
    const forged = [`${name}=${Number(exp) + 99999}.${sig}`, `${name}=${exp}.${sig!.replace(/.$/, sig!.endsWith('0') ? '1' : '0')}`, `${name}=garbage`]
    for (const c of forged) expect((await admin('/api/admin/users', { headers: { Cookie: c } })).status).toBe(401)
    expect((await admin('/api/admin/users', { headers: {} })).status).toBe(401)
    expect((await admin('/api/admin/users', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  it('an expired cookie is rejected', async () => {
    const { signSession } = await import('../../src/lib/admin-auth')
    const old = await signSession(ADMIN_ENV.OEM_SESSION_SECRET, ADMIN_ENV.OEM_ADMIN_PASSWORD, Date.now() - 13 * 3600 * 1000)
    expect((await admin('/api/admin/users', { headers: { Cookie: `oem_admin=${old}` } })).status).toBe(401)
  })

  it('changing the admin password invalidates existing sessions', async () => {
    const cookie = await login()
    expect((await admin('/api/admin/users', { headers: { Cookie: cookie } })).status).toBe(200)
    const res = await admin('/api/admin/users', { headers: { Cookie: cookie }, env: { OEM_ADMIN_PASSWORD: 'rotated' } })
    expect(res.status).toBe(401)
  })

  it('cookie-authenticated writes are CSRF checked, bearer is exempt', async () => {
    const cookie = await login()
    const post = (headers: Record<string, string>) =>
      admin('/api/admin/users', { method: 'POST', body: {}, headers: { Cookie: cookie, ...headers } })
    const rejected = await post({ Origin: 'https://evil.example' })
    expect(rejected.status).toBe(403)
    expect((await rejected.json()).error.code).toBe('CSRF_REJECTED')
    expect((await post({})).status).toBe(403)
    expect((await post({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await post({ Origin: 'http://localhost' })).status).toBe(201)
    expect((await post({ 'Sec-Fetch-Site': 'same-origin' })).status).toBe(201)
    expect((await admin('/api/admin/users', { method: 'POST', body: {}, headers: { ...bearer, Origin: 'https://evil.example' } })).status).toBe(201)
    expect((await admin('/api/admin/users', { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(200)
  })

  it('CSRF check accepts an Origin that matches the Host header, port included', async () => {
    const cookie = await login()
    const post = (headers: Record<string, string>) =>
      admin('/api/admin/users', { method: 'POST', body: {}, headers: { Cookie: cookie, ...headers } })
    const host = 'admin.example.com:4321'
    expect((await post({ Host: host, Origin: `http://${host}` })).status).toBe(201)
    const evil = await post({ Host: host, Origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    expect((await evil.json()).error.code).toBe('CSRF_REJECTED')
    const port = await post({ Host: host, Origin: 'http://admin.example.com:9999' })
    expect(port.status).toBe(403)
    expect((await port.json()).error.code).toBe('CSRF_REJECTED')
    expect((await post({ Host: host, Origin: 'not a url' })).status).toBe(403)
  })

  it('releases reject non-https URL fields at any depth', async () => {
    const put = (body: unknown) => admin('/api/admin/releases', { method: 'PUT', body })
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com/a', 'nonsense']) {
      for (const body of [
        { clients: { desktop: { latest: '1', minSupported: '1', downloadUrl: bad } } },
        { notesUrl: bad },
        { list: [{ nested: { mirrorURL: bad } }] },
      ]) {
        const res = await put(body)
        expect(res.status, bad).toBe(400)
        expect((await res.json()).error.code).toBe('BAD_REQUEST')
      }
    }
    // valid input passes validation; with no storage configured it then fails at the storage step, not with 400
    const ok = await put({ clients: { desktop: { downloadUrl: 'https://dl.example.com/app.exe' } }, emptyUrl: '' })
    expect(ok.status).toBe(500)
  })

  it('releases and status require credentials', async () => {
    for (const path of ['/api/admin/releases', '/api/admin/status']) {
      expect((await admin(path, { headers: {} })).status).toBe(401)
    }
  })

  it('malformed JSON bodies are 400', async () => {
    const made = await (await admin('/api/admin/users', { method: 'POST', body: {} })).json()
    const raw = (path: string, method: string) =>
      call(path, { method, headers: bearer, env: ADMIN_ENV, raw: '{nope' })
    expect((await raw(`/api/admin/users/${made.user.id}/keys`, 'POST')).status).toBe(400)
    expect((await raw('/api/admin/releases', 'PUT')).status).toBe(400)
    expect((await raw('/api/admin/plans', 'POST')).status).toBe(400)
  })

  it('bearer token is ignored when none is configured', async () => {
    const res = await admin('/api/admin/users', { env: { OEM_ADMIN_TOKEN: undefined }, headers: { Authorization: 'Bearer ' } })
    expect(res.status).toBe(401)
  })

  it('secure cookie over https', async () => {
    const res = await admin('/api/admin/login', {
      method: 'POST',
      body: { password: ADMIN_ENV.OEM_ADMIN_PASSWORD },
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(res.headers.get('set-cookie')).toMatch(/; Secure/)
  })

  it('plan -> user -> engine/token reflects plan, expiry, disable, and PLAN_IN_USE', async () => {
    const created = await admin('/api/admin/plans', { method: 'POST', body: { code: 'PRO', name: 'Pro', mi: 7, maxSyncedProfiles: 10 } })
    expect(created.status).toBe(201)
    const plan = (await created.json()).plan
    const mk = await admin('/api/admin/users', { method: 'POST', body: { label: 'bob', planId: plan.id } })
    expect(mk.status).toBe(201)
    const made = await mk.json()
    const userId = made.user.id
    const key: string = made.key.key
    const mi = async () => (await (await call('/api/v1/engine/token', { method: 'POST', key })).json()).mi
    expect(await mi()).toBe(7)

    expect((await admin(`/api/admin/plans/${plan.id}`, { method: 'PATCH', body: { mi: 9 } })).status).toBe(200)
    expect(await mi()).toBe(9)

    const del = await admin(`/api/admin/plans/${plan.id}`, { method: 'DELETE' })
    expect(del.status).toBe(409)
    expect((await del.json()).error.code).toBe('PLAN_IN_USE')

    const past = new Date(Date.now() - 1000).toISOString()
    expect((await admin(`/api/admin/users/${userId}`, { method: 'PATCH', body: { planExpiresAt: past } })).status).toBe(200)
    expect(await mi()).toBe(1)
    expect((await admin(`/api/admin/users/${userId}`, { method: 'PATCH', body: { planExpiresAt: null } })).status).toBe(200)
    expect(await mi()).toBe(9)

    expect((await admin(`/api/admin/users/${userId}`, { method: 'PATCH', body: { disabled: true } })).status).toBe(200)
    expect((await call('/api/v1/engine/token', { method: 'POST', key })).status).toBe(401)
    await admin(`/api/admin/users/${userId}`, { method: 'PATCH', body: { disabled: false } })

    const free = (await (await admin('/api/admin/plans')).json()).plans.find((p: { code: string }) => p.code === 'FREE')
    await admin(`/api/admin/users/${userId}`, { method: 'PATCH', body: { planId: free.id } })
    expect(await mi()).toBe(1)
    expect((await admin(`/api/admin/plans/${plan.id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('default plan switch works and new users get it', async () => {
    const plan = (await (await admin('/api/admin/plans', { method: 'POST', body: { code: 'TEAM', name: 'Team', mi: 3, maxSyncedProfiles: 2 } })).json()).plan
    expect((await admin(`/api/admin/plans/${plan.id}/default`, { method: 'POST' })).status).toBe(200)
    const made = await (await admin('/api/admin/users', { method: 'POST', body: {} })).json()
    expect(made.user.plan.code).toBe('TEAM')
  })

  it('keys: full value only on creation, last 4 in listing, revoked key gets 401', async () => {
    const made = await (await admin('/api/admin/users', { method: 'POST', body: { label: 'k' } })).json()
    const userId = made.user.id
    const second = await (await admin(`/api/admin/users/${userId}/keys`, { method: 'POST', body: { name: 'laptop' } })).json()
    expect(second.key.key).toMatch(/^adb_/)
    const listing = await (await admin(`/api/admin/users/${userId}/keys`)).json()
    expect(listing.keys).toHaveLength(2)
    expect(JSON.stringify(listing)).not.toContain(second.key.key)
    expect(listing.keys.map((k: { last4: string }) => k.last4)).toContain(second.key.key.slice(-4))

    expect((await call('/api/v1/account', { key: second.key.key })).status).toBe(200)
    expect((await admin(`/api/admin/users/${userId}/keys/${second.key.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call('/api/v1/account', { key: second.key.key })).status).toBe(401)
    expect((await call('/api/v1/account', { key: made.key.key })).status).toBe(200)
    expect((await admin(`/api/admin/users/${userId}/keys/nope`, { method: 'DELETE' })).status).toBe(404)
  })

  it('user list: pagination, search, plan filter, limit clamp', async () => {
    for (const label of ['ann', 'bea', 'cat']) await admin('/api/admin/users', { method: 'POST', body: { label } })
    const p1 = await (await admin('/api/admin/users?limit=2')).json()
    expect(p1.users).toHaveLength(2)
    expect(p1.nextCursor).toBeTruthy()
    expect(p1.users[0].keyCount).toBe(1)
    const p2 = await (await admin(`/api/admin/users?limit=2&cursor=${p1.nextCursor}`)).json()
    expect(p2.users).toHaveLength(1)
    expect(p2.nextCursor).toBeNull()
    const found = await (await admin('/api/admin/users?query=BEA')).json()
    expect(found.users.map((u: { label: string }) => u.label)).toEqual(['bea'])
    const none = await (await admin('/api/admin/users?planId=missing')).json()
    expect(none.users).toHaveLength(0)
    expect((await admin('/api/admin/users?limit=0')).status).toBe(400)
    expect((await admin('/api/admin/users?limit=9999')).status).toBe(200)
  })

  it('deleting a user cascades profiles', async () => {
    const made = await (await admin('/api/admin/users', { method: 'POST', body: {} })).json()
    await db.profile.create({ data: { userId: made.user.id, name: 'p', tags: '' } })
    expect((await admin(`/api/admin/users/${made.user.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await db.profile.count({ where: { userId: made.user.id } })).toBe(0)
    expect((await admin(`/api/admin/users/${made.user.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('status reports db, unconfigured s3, and license key validity', async () => {
    const res = await admin('/api/admin/status')
    expect(await res.json()).toEqual({ db: 'ok', s3: 'unconfigured', licenseKey: 'ok' })
    const bad = await admin('/api/admin/status', { env: { FP_LICENSE_PRIVKEY: 'zz' } })
    expect((await bad.json()).licenseKey).toBe('invalid')
  })

  it('releases need storage', async () => {
    const res = await admin('/api/admin/releases')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('STORAGE_UNAVAILABLE')
  })

  it('/api/v1 behaviour is unchanged by admin config', async () => {
    expect((await call('/api/v1/account', { env: ADMIN_ENV })).status).toBe(401)
    expect((await call('/api/v1/config', { env: ADMIN_ENV })).status).toBe(200)
  })
})

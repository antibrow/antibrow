import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { APIRoute } from 'astro'
import { signSession } from '../src/lib/admin-auth'
import { call } from './routes/harness'

const PAGES = join(__dirname, '../src/pages/admin')
const ENV = { DATABASE_URL: 'postgresql://x@localhost:1/x', OEM_ADMIN_PASSWORD: 'pw', OEM_SESSION_SECRET: 's'.repeat(32) }
const page: APIRoute = () => new Response('page', { status: 200 })

describe('admin pages', () => {
  it('never import server logic, only the admin API', () => {
    const files = readdirSync(PAGES).filter((f) => f.endsWith('.astro'))
    expect(files.sort()).toEqual(['index.astro', 'plans.astro', 'releases.astro', 'settings.astro', 'users.astro'])
    for (const f of files) {
      const src = readFileSync(join(PAGES, f), 'utf8')
      expect(src, f).not.toMatch(/lib\//)
      expect(src, f).not.toMatch(/prisma/i)
    }
  })

  it('returns 404 when OEM_ADMIN_PASSWORD is unset', async () => {
    for (const path of ['/admin', '/admin/users']) {
      expect((await call(path, { handler: page, env: { DATABASE_URL: ENV.DATABASE_URL } })).status).toBe(404)
    }
  })

  it('serves the login page without a session', async () => {
    expect((await call('/admin', { handler: page, env: ENV })).status).toBe(200)
  })

  it('redirects unauthenticated page loads to /admin', async () => {
    for (const path of ['/admin/users', '/admin/plans', '/admin/releases', '/admin/settings']) {
      const res = await call(path, { handler: page, env: ENV })
      expect(res.status, path).toBe(302)
      expect(res.headers.get('location')).toBe('/admin')
    }
    const bad = await call('/admin/users', { handler: page, env: ENV, headers: { Cookie: 'oem_admin=1.deadbeef' } })
    expect(bad.status).toBe(302)
  })

  it('serves pages with a valid session cookie', async () => {
    const cookie = `oem_admin=${await signSession(ENV.OEM_SESSION_SECRET, ENV.OEM_ADMIN_PASSWORD)}`
    const res = await call('/admin/users', { handler: page, env: ENV, headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
  })
})

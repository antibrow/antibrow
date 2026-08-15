import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readProfileMeta, writeProfileMeta, resolveProfileDir, profilesRoot } from '../src/engine/profile-dir'
import type { ProxyBinding } from '../src/proxy-binding'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adb-meta-'))

describe('ProfileMeta.proxy', () => {
  it('round-trips a managed binding', () => {
    const dir = tmp()
    writeProfileMeta(dir, {
      id: 'p1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'managed', managedProxyId: 'px1' },
    })
    expect(readProfileMeta(dir)?.proxy).toEqual({ kind: 'managed', managedProxyId: 'px1' })
  })

  it('round-trips a url binding', () => {
    const dir = tmp()
    writeProfileMeta(dir, {
      id: 'p1', name: 'shop-01', origin: 'local',
      proxy: { kind: 'url', url: 'http://u:p@h.io:8080' },
    })
    expect(readProfileMeta(dir)?.proxy).toEqual({ kind: 'url', url: 'http://u:p@h.io:8080' })
  })

  it('reads an older file that has no proxy field', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'profile.json'),
      JSON.stringify({ id: 'p1', name: 'shop-01', origin: 'local' }), 'utf8')
    const meta = readProfileMeta(dir)
    expect(meta?.name).toBe('shop-01')
    expect(meta?.proxy).toBeUndefined()
  })

  it('drops a malformed proxy field instead of failing the whole read', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'profile.json'),
      JSON.stringify({ id: 'p1', name: 'shop-01', origin: 'local', proxy: { kind: 'nope' } }), 'utf8')
    const meta = readProfileMeta(dir)
    expect(meta?.name).toBe('shop-01')
    expect(meta?.proxy).toBeUndefined()
  })
})

// Reduction of a real-kernel e2e failure: launch a profile with a proxy, close it,
// re-open with no proxy argument, and the second launch went out on the bare
// machine IP. Root cause was resolveProfileDir's internal writes (the stamp,
// adopt, claim) each replacing profile.json wholesale instead of merging, so
// any field they didn't name - proxy, group, tags, encrypted - was erased on
// the very next launch.
describe('resolveProfileDir writes merge instead of replacing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const BOUND_FIELDS = {
    proxy: { kind: 'managed', managedProxyId: 'px1' } as ProxyBinding,
    group: 'g1',
    tags: ['t1', 't2'],
    encrypted: true as const,
  }

  function stubFetchOnce(status: number, ok: boolean, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok, json: async () => body })))
  }

  it('the negative-cache stamp keeps proxy/group/tags/encrypted (the e2e regression, reduced)', async () => {
    const cacheDir = tmp()
    const dir = path.join(profilesRoot(cacheDir), 'local-1')
    writeProfileMeta(dir, { id: 'local-1', name: 'shop-01', origin: 'local', ...BOUND_FIELDS })

    // 404 = "server answered, no profile there yet" - this is the only path that
    // fires on nearly every launch, since it just re-stamps serverCheckedAt.
    stubFetchOnce(404, false, {})

    const resolved = await resolveProfileDir({
      cacheDir, profileName: 'shop-01', key: 'k', server: 'https://example.test',
    })
    expect(resolved.dir).toBe(dir)

    const meta = readProfileMeta(dir)
    expect(meta?.proxy).toEqual(BOUND_FIELDS.proxy)
    expect(meta?.group).toBe('g1')
    expect(meta?.tags).toEqual(['t1', 't2'])
    expect(meta?.encrypted).toBe(true)
    // The opposite failure: a merge that preserves everything but forgets to
    // apply the intended change must not pass either.
    expect(meta?.serverCheckedAt).toBeTruthy()
  })

  it('adopting a locally-bound profile under a new server id keeps the binding', async () => {
    const cacheDir = tmp()
    const dir = path.join(profilesRoot(cacheDir), 'local-2')
    writeProfileMeta(dir, { id: 'local-2', name: 'shop-02', origin: 'local', ...BOUND_FIELDS })

    stubFetchOnce(200, true, { id: 'server-2' })

    const resolved = await resolveProfileDir({
      cacheDir, profileName: 'shop-02', key: 'k', server: 'https://example.test',
    })
    expect(resolved.id).toBe('server-2')

    const meta = readProfileMeta(resolved.dir)
    expect(meta?.origin).toBe('server')
    expect(meta?.id).toBe('server-2')
    expect(meta?.proxy).toEqual(BOUND_FIELDS.proxy)
    expect(meta?.group).toBe('g1')
    expect(meta?.tags).toEqual(['t1', 't2'])
    expect(meta?.encrypted).toBe(true)
  })

  it('claiming a directory that already owns a server id keeps its binding', async () => {
    const cacheDir = tmp()
    const id = 'server-3'
    const dir = path.join(profilesRoot(cacheDir), id)
    // Directory already carries this server id under a stale name - e.g. renamed
    // on the server since this machine last saw it.
    writeProfileMeta(dir, { id, name: 'old-name', origin: 'server', ...BOUND_FIELDS })

    stubFetchOnce(200, true, { id })

    const resolved = await resolveProfileDir({
      cacheDir, profileName: 'new-name', key: 'k', server: 'https://example.test',
    })
    expect(resolved.dir).toBe(dir)
    expect(resolved.id).toBe(id)

    const meta = readProfileMeta(dir)
    expect(meta?.name).toBe('new-name')
    expect(meta?.proxy).toEqual(BOUND_FIELDS.proxy)
    expect(meta?.group).toBe('g1')
    expect(meta?.tags).toEqual(['t1', 't2'])
    expect(meta?.encrypted).toBe(true)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProfileEntries, readProfileMeta, writeProfileMeta, sanitizeProfileName, resolveProfileDir, resolveProfileDirSync, SERVER_RECHECK_MS } from '../../src/engine/profile-dir'

let cacheDir: string

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-profile-dir-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

function mkProfile(dirName: string, meta?: Record<string, unknown>): string {
  const dir = path.join(cacheDir, 'profiles', dirName)
  fs.mkdirSync(dir, { recursive: true })
  if (meta) fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(meta), 'utf8')
  return dir
}

describe('profile identity record', () => {
  it('round-trips a meta record', () => {
    const dir = path.join(cacheDir, 'profiles', 'uuid-1')
    writeProfileMeta(dir, { id: 'uuid-1', name: 'gmail', origin: 'server' })
    expect(readProfileMeta(dir)).toEqual({ id: 'uuid-1', name: 'gmail', origin: 'server', serverCheckedAt: undefined })
  })

  it('treats a corrupt or incomplete record as absent', () => {
    const dir = mkProfile('uuid-2')
    fs.writeFileSync(path.join(dir, 'profile.json'), '{ not json', 'utf8')
    expect(readProfileMeta(dir)).toBeUndefined()
    const dir2 = mkProfile('uuid-3', { name: 'no-id' })
    expect(readProfileMeta(dir2)).toBeUndefined()
  })

  it('lists recorded profiles and marks bare directories legacy', () => {
    mkProfile('5f7e-uuid', { id: '5f7e-uuid', name: 'gmail', origin: 'server' })
    mkProfile('old-name')
    const entries = listProfileEntries(cacheDir).sort((a, b) => a.name.localeCompare(b.name))
    expect(entries).toEqual([
      { id: '5f7e-uuid', name: 'gmail', origin: 'server', serverCheckedAt: undefined, dir: path.join(cacheDir, 'profiles', '5f7e-uuid') },
      { id: 'old-name', name: 'old-name', origin: 'legacy', dir: path.join(cacheDir, 'profiles', 'old-name') },
    ])
  })

  it('ignores non-directories', () => {
    mkProfile('kept', { id: 'kept', name: 'kept', origin: 'local' })
    fs.writeFileSync(path.join(cacheDir, 'profiles', 'stray.txt'), 'x', 'utf8')
    expect(listProfileEntries(cacheDir).map((e) => e.id)).toEqual(['kept'])
  })

  it('returns an empty list when the profiles root is missing', () => {
    expect(listProfileEntries(path.join(cacheDir, 'nope'))).toEqual([])
  })

  it('sanitizes names that cannot be directory names', () => {
    expect(sanitizeProfileName('a/b:c')).toBe('a_b_c')
    // Parity with the Python SDK: only an empty result is rejected, so a name
    // made entirely of replaced characters still resolves to a directory.
    expect(sanitizeProfileName('///')).toBe('___')
    expect(() => sanitizeProfileName('   ')).toThrow()
    expect(() => sanitizeProfileName('')).toThrow()
  })
})

describe('resolveProfileDirSync', () => {
  it('reuses the directory whose record matches the name', () => {
    mkProfile('uuid-a', { id: 'uuid-a', name: 'gmail', origin: 'server' })
    const r = resolveProfileDirSync(cacheDir, 'gmail')
    expect(r).toEqual({ dir: path.join(cacheDir, 'profiles', 'uuid-a'), id: 'uuid-a', name: 'gmail' })
  })

  it('adopts a legacy name-shaped directory and renames it to the id', () => {
    mkProfile('gmail')
    fs.writeFileSync(path.join(cacheDir, 'profiles', 'gmail', 'persona.json'), '{"kernelVersion":"150.0.0.1"}', 'utf8')
    const r = resolveProfileDirSync(cacheDir, 'gmail')
    expect(path.basename(r.dir)).toBe(r.id)
    expect(r.name).toBe('gmail')
    // the adopted state must travel with the directory
    expect(fs.existsSync(path.join(r.dir, 'persona.json'))).toBe(true)
    expect(readProfileMeta(r.dir)?.origin).toBe('local')
  })

  it('keeps the legacy directory when the rename cannot be done', () => {
    mkProfile('gmail')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EBUSY') })
    const r = resolveProfileDirSync(cacheDir, 'gmail')
    expect(path.basename(r.dir)).toBe('gmail')
    // id stays authoritative even though the directory name lags
    expect(readProfileMeta(r.dir)?.id).toBe(r.id)
    expect(r.id).not.toBe('gmail')
  })

  it('creates a new id-named directory for an unknown name', () => {
    const r = resolveProfileDirSync(cacheDir, 'fresh')
    expect(path.basename(r.dir)).toBe(r.id)
    expect(readProfileMeta(r.dir)).toEqual({ id: r.id, name: 'fresh', origin: 'local', serverCheckedAt: undefined })
  })

  it('matches names exactly, including case and unsafe characters', () => {
    const a = resolveProfileDirSync(cacheDir, 'Gmail')
    const b = resolveProfileDirSync(cacheDir, 'gmail')
    expect(a.dir).not.toBe(b.dir)
    const c = resolveProfileDirSync(cacheDir, 'a@b.com')
    expect(resolveProfileDirSync(cacheDir, 'a@b.com').dir).toBe(c.dir)
  })
})

describe('resolveProfileDir (server-aware)', () => {
  function mockFetch(status: number, body?: unknown) {
    return vi.fn(async () => new Response(body === undefined ? '' : JSON.stringify(body), { status }))
  }

  it('adopts the server id for a name it has never seen', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockFetch(200, { id: 'server-uuid', name: 'gmail' }) as unknown as typeof fetch,
    )
    const r = await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    expect(r.id).toBe('server-uuid')
    expect(path.basename(r.dir)).toBe('server-uuid')
    expect(readProfileMeta(r.dir)?.origin).toBe('server')
  })

  it('reuses a directory the desktop already created for that server id', async () => {
    mkProfile('server-uuid', { id: 'server-uuid', name: 'gmail', origin: 'server' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    expect(fetchSpy).not.toHaveBeenCalled()   // hot path never touches the network
    expect(r.dir).toBe(path.join(cacheDir, 'profiles', 'server-uuid'))
  })

  it('does not touch the network without a key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await resolveProfileDir({ cacheDir, profileName: 'offline' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readProfileMeta(r.dir)?.origin).toBe('local')
  })

  it('falls back to a local id when the lookup fails, and retries next time', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch,
    )
    const r = await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    expect(readProfileMeta(r.dir)?.origin).toBe('local')
    expect(readProfileMeta(r.dir)?.serverCheckedAt).toBeUndefined()   // unreachable != absent
  })

  it('records a 404 so a free-plan profile is not re-checked every launch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch(404) as unknown as typeof fetch)
    const first = await resolveProfileDir({ cacheDir, profileName: 'local-only', key: 'adb_k', server: 'https://x.test' })
    expect(readProfileMeta(first.dir)?.serverCheckedAt).toBeTruthy()
    fetchSpy.mockClear()
    const second = await resolveProfileDir({ cacheDir, profileName: 'local-only', key: 'adb_k', server: 'https://x.test' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(second.dir).toBe(first.dir)
  })

  it('re-checks a local profile once the negative result is stale, and adopts the server id onto it', async () => {
    const dir = mkProfile('local-uuid', {
      id: 'local-uuid',
      name: 'gmail',
      origin: 'local',
      serverCheckedAt: new Date(Date.now() - SERVER_RECHECK_MS - 1000).toISOString(),
    })
    fs.writeFileSync(path.join(dir, 'persona.json'), '{"kernelVersion":"150.0.0.1"}', 'utf8')
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockFetch(200, { id: 'server-uuid', name: 'gmail' }) as unknown as typeof fetch,
    )
    const r = await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    // The id was only ever local, so the server naming this profile is an
    // alignment, not a stranger: same directory, same persona, server id.
    expect(r.id).toBe('server-uuid')
    expect(path.basename(r.dir)).toBe('server-uuid')
    expect(fs.readFileSync(path.join(r.dir, 'persona.json'), 'utf8')).toContain('150.0.0.1')
    expect(readProfileMeta(r.dir)).toEqual({ id: 'server-uuid', name: 'gmail', origin: 'server', serverCheckedAt: undefined })
    expect(listProfileEntries(cacheDir).map((e) => e.name)).toEqual(['gmail'])
  })

  it('keeps a local directory and its state when the server first names that profile', async () => {
    // The ordinary upgrade path: weeks of local launches, then a paid plan
    // creates the server row and the very next launch sees a "different" id.
    const dir = mkProfile('local-uuid', { id: 'local-uuid', name: 'gmail', origin: 'local' })
    fs.writeFileSync(path.join(dir, 'persona.json'), '{"seed":"keep-me"}', 'utf8')
    fs.mkdirSync(path.join(dir, 'user-data', 'Default'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'user-data', 'Default', 'Cookies'), 'sqlite', 'utf8')
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockFetch(200, { id: 'server-uuid', name: 'gmail' }) as unknown as typeof fetch,
    )
    const r = await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    expect(fs.readFileSync(path.join(r.dir, 'persona.json'), 'utf8')).toBe('{"seed":"keep-me"}')
    expect(fs.existsSync(path.join(r.dir, 'user-data', 'Default', 'Cookies'))).toBe(true)
    expect(listProfileEntries(cacheDir)).toHaveLength(1)
  })

  it('records a 403 - a free plan answers "absent", it is not an outage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch(403, { error: 'paid plan' }) as unknown as typeof fetch)
    const first = await resolveProfileDir({ cacheDir, profileName: 'free-plan', key: 'adb_k', server: 'https://x.test' })
    expect(readProfileMeta(first.dir)?.serverCheckedAt).toBeTruthy()
    fetchSpy.mockClear()
    const second = await resolveProfileDir({ cacheDir, profileName: 'free-plan', key: 'adb_k', server: 'https://x.test' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(second.dir).toBe(first.dir)
  })

  // Two resolves that both exhaust the retry policy; the default 5s timeout is
  // not enough now that a 500 is retried rather than accepted at face value.
  it('does not cache a server-side failure', { timeout: 30_000 }, async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch(500) as unknown as typeof fetch)
    const first = await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    expect(readProfileMeta(first.dir)?.serverCheckedAt).toBeUndefined()
    fetchSpy.mockClear()
    await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    // Asks again rather than standing on the failure; the count is whatever the
    // retry policy spends, not one.
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('never claims an id a sibling directory already holds', async () => {
    // The desktop app already owns <server-uuid>; a legacy directory must not
    // stamp that same id onto itself - lookups by id would then be a coin flip.
    const owned = mkProfile('server-uuid', { id: 'server-uuid', name: 'work', origin: 'server' })
    const legacy = mkProfile('gmail')
    fs.writeFileSync(path.join(legacy, 'persona.json'), '{"seed":"legacy"}', 'utf8')
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockFetch(200, { id: 'server-uuid', name: 'gmail' }) as unknown as typeof fetch,
    )
    const r = await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    expect(r.dir).toBe(owned)
    expect(fs.existsSync(path.join(legacy, 'persona.json'))).toBe(true)   // data untouched
    const entries = listProfileEntries(cacheDir)
    expect(entries.filter((e) => e.id === 'server-uuid')).toHaveLength(1)
    expect(entries.map((e) => e.name).sort()).toEqual(['gmail', 'gmail (local)'])
  })

  it('never claims an id a sibling holds by record, not just by directory name', async () => {
    // What a failed rename leaves behind: the directory name and the id in its
    // record disagree, so an id can be taken without <root>/<id> existing.
    const holder = mkProfile('work', { id: 'server-uuid', name: 'work', origin: 'server' })
    const legacy = mkProfile('gmail')
    fs.writeFileSync(path.join(legacy, 'persona.json'), '{"seed":"legacy"}', 'utf8')
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockFetch(200, { id: 'server-uuid', name: 'gmail' }) as unknown as typeof fetch,
    )
    const r = await resolveProfileDir({ cacheDir, profileName: 'gmail', key: 'adb_k', server: 'https://x.test' })
    expect(r.dir).toBe(holder)
    expect(fs.existsSync(path.join(legacy, 'persona.json'))).toBe(true)   // data untouched
    expect(listProfileEntries(cacheDir).filter((e) => e.id === 'server-uuid')).toHaveLength(1)
  })

  it('adopts a legacy directory whose pre-upgrade name was sanitized', async () => {
    const legacy = mkProfile('acct_1')
    fs.writeFileSync(path.join(legacy, 'persona.json'), '{"seed":"sanitized"}', 'utf8')
    const r = await resolveProfileDir({ cacheDir, profileName: 'acct:1' })
    expect(fs.readFileSync(path.join(r.dir, 'persona.json'), 'utf8')).toBe('{"seed":"sanitized"}')
    expect(readProfileMeta(r.dir)?.name).toBe('acct:1')
    expect(listProfileEntries(cacheDir)).toHaveLength(1)
  })
})

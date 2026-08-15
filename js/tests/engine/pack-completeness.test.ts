import { describe, it, expect, afterEach, vi } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  packProfileCache,
  packProfileCacheWithReport,
  lastProfilePackReport,
  uploadProfileCache,
} from '../../src/engine/profile-cache'

function profile(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(dir, 'user-data', 'Default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'user-data', 'Default', 'Cookies'), 'cookie-data')
  fs.writeFileSync(path.join(dir, 'user-data', 'Local State'), 'local-state')
  fs.writeFileSync(path.join(dir, 'persona.json'), '{"ua":"UA"}')
  return dir
}

/** A file a live browser holds open: the read throws, the pack goes on. */
function lockRead(...names: string[]): void {
  const real = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof p === 'string' && names.some((n) => p.endsWith(n))) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: 'EBUSY' })
    }
    return (real as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readFileSync)
}

afterEach(() => { vi.restoreAllMocks() })

describe('pack completeness', () => {
  it('reports the entries a locked read left out, and still packs the rest', () => {
    const dir = profile('pack-locked-')
    lockRead('persona.json')

    const { archive, skipped } = packProfileCacheWithReport(dir)

    expect(skipped).toEqual(['persona.json'])
    // Tolerant packing is deliberate: a partial archive still beats no archive.
    const names = new AdmZip(archive).getEntries().map((e) => e.entryName)
    expect(names).toContain('user-data/Default/Cookies')
    expect(names).not.toContain('persona.json')
  })

  it('reports nothing skipped when every item was readable', () => {
    const dir = profile('pack-clean-')

    const { archive, skipped } = packProfileCacheWithReport(dir)

    expect(skipped).toEqual([])
    expect(new AdmZip(archive).getEntries().length).toBeGreaterThan(0)
  })

  it('names the individual user-data file it could not read', () => {
    const dir = profile('pack-locked-ud-')
    lockRead(path.join('Default', 'Cookies'), 'Local State')

    const { skipped } = packProfileCacheWithReport(dir)

    expect(skipped).toEqual(['user-data/Default/Cookies', 'user-data/Local State'])
  })

  it('counts a directory it could not even list', () => {
    const dir = profile('pack-locked-dir-')
    const real = fs.readdirSync
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.endsWith('Default')) throw new Error('EACCES')
      return (real as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.readdirSync)

    const { skipped } = packProfileCacheWithReport(dir)

    expect(skipped).toEqual(['user-data/Default'])
  })

  it('keeps packProfileCache returning the archive buffer, report on the side', () => {
    const dir = profile('pack-compat-')
    lockRead('persona.json')

    const buf = packProfileCache(dir)

    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(lastProfilePackReport(dir)?.skipped).toEqual(['persona.json'])
  })

  it('records the report of the pack an upload sent, so the uploader can check it', async () => {
    const dir = profile('pack-upload-')
    lockRead('persona.json')
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => '"etag-1"' } }))
    vi.stubGlobal('fetch', fetchSpy)

    await uploadProfileCache(dir, 'https://r2/put.zip')

    expect(fetchSpy).toHaveBeenCalled()
    expect(lastProfilePackReport(dir)?.skipped).toEqual(['persona.json'])
  })

  it('has no report for a directory this process never packed', () => {
    expect(lastProfilePackReport(path.join(os.tmpdir(), 'pack-never-packed'))).toBeUndefined()
  })
})

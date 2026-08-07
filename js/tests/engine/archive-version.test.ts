import { describe, it, expect } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ARCHIVE_VERSION_FILE,
  readArchiveVersion,
  writeArchiveVersion,
  clearArchiveVersion,
  normalizeArchiveVersion,
  packProfileCache,
  importProfileArchive,
} from '../../src/engine/profile-cache'

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('archive version marker', () => {
  it('roundtrips and reports absence as undefined', () => {
    const dir = tmp('av-')
    expect(readArchiveVersion(dir)).toBeUndefined()
    writeArchiveVersion(dir, 'abc123')
    expect(readArchiveVersion(dir)).toBe('abc123')
    clearArchiveVersion(dir)
    expect(readArchiveVersion(dir)).toBeUndefined()
  })

  it('strips the quotes R2 wraps an ETag in', () => {
    expect(normalizeArchiveVersion('"abc123"')).toBe('abc123')
    expect(normalizeArchiveVersion(null)).toBeUndefined()
    expect(normalizeArchiveVersion('""')).toBeUndefined()
  })

  // It records what THIS machine holds, so it must not travel with the profile.
  it('is never packed into a cloud archive', () => {
    const dir = tmp('av-pack-')
    fs.mkdirSync(path.join(dir, 'user-data', 'Default'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'user-data', 'Default', 'Cookies'), 'ck')
    fs.writeFileSync(path.join(dir, 'persona.json'), '{}')
    writeArchiveVersion(dir, 'abc123')

    const names = new AdmZip(packProfileCache(dir)).getEntries().map((e) => e.entryName)
    expect(names).toContain('user-data/Default/Cookies')
    expect(names).not.toContain(ARCHIVE_VERSION_FILE)
  })

  // The generation an imported profile belongs to is unknowable; a stale marker
  // here would make the next launch skip a restore it needs.
  it('is dropped when a portable archive is imported', () => {
    const zip = new AdmZip()
    zip.addFile('profile.json', Buffer.from(JSON.stringify({ name: 'Imported' })))
    zip.addFile('user-data/Local State', Buffer.from('ls'))
    const dir = tmp('av-import-')
    writeArchiveVersion(dir, 'stale')

    importProfileArchive(zip.toBuffer(), dir)

    expect(readArchiveVersion(dir)).toBeUndefined()
  })
})

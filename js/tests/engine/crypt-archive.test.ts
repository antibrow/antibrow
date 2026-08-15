import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { exportProfileArchive, importProfileArchive, packProfileCache, unpackProfileCache } from '../../src/engine/profile-cache'
import {
  CRYPT_STATE_FILE,
  isProfileEncrypted,
  markProfileEncrypted,
  readCryptState,
  writeCryptState,
  writeProfileMeta,
} from '../../src/engine/profile-dir'

// Encryption is a property of the profile's DATA, so it travels with the data.
// Left behind, the machine that restores the archive launches without the key
// the cookies in it were written under.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crypt-arch-'))

function seedProfile(dir: string): void {
  fs.mkdirSync(path.join(dir, 'user-data', 'Default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'user-data', 'Default', 'Cookies'), 'cookie-bytes')
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ kernelVersion: '151' }))
}

describe('the crypt state travels in the archive', () => {
  it('packs and restores the marker', () => {
    const src = tmp()
    seedProfile(src)
    markProfileEncrypted(src)

    const dst = tmp()
    unpackProfileCache(packProfileCache(src), dst)

    expect(readCryptState(dst)).toBe(true)
    expect(isProfileEncrypted(dst)).toBe(true)
  })

  it('leaves an unencrypted profile saying nothing at all', () => {
    const src = tmp()
    seedProfile(src)

    const names = new AdmZip(packProfileCache(src)).getEntries().map((e) => e.entryName)

    expect(names).not.toContain(CRYPT_STATE_FILE)
  })

  it('never carries profile.json, so a guest marker cannot travel', () => {
    const src = tmp()
    seedProfile(src)
    writeProfileMeta(src, { id: 'id-1', name: 'shared', origin: 'server' })
    fs.writeFileSync(
      path.join(src, 'profile.json'),
      JSON.stringify({ id: 'id-1', name: 'shared', origin: 'server', shareRole: 'guest' }),
    )
    markProfileEncrypted(src)

    const names = new AdmZip(packProfileCache(src)).getEntries().map((e) => e.entryName)

    expect(names).not.toContain('profile.json')
    expect(names).toContain(CRYPT_STATE_FILE)
  })

  it('lets the restored state file overrule a local record that disagrees', () => {
    const dir = tmp()
    // Local record says encrypted (this machine created it that way), the state
    // file restored beside the data says otherwise. The data wins.
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id: 'x', name: 'x', encrypted: true }))
    writeCryptState(dir, false)

    expect(isProfileEncrypted(dir)).toBe(false)
  })

  it('falls back to the local record for archives predating the state file', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id: 'x', name: 'x', encrypted: true }))

    expect(readCryptState(dir)).toBeUndefined()
    expect(isProfileEncrypted(dir)).toBe(true)
  })
})

// A restore cannot go stale (a profile's encryption never changes and its own
// archive always answers), but an import replaces the data wholesale.
describe('importing into a directory that held an encrypted profile', () => {
  it('drops the previous occupant\'s marker', () => {
    const src = tmp()
    seedProfile(src)
    const archive = exportProfileArchive(src, { name: 'imported', kernelVersion: '151' })

    const dst = tmp()
    markProfileEncrypted(dst)
    importProfileArchive(archive, dst)

    expect(isProfileEncrypted(dst)).toBe(false)
  })

  it('keeps a marker the imported archive brought itself', () => {
    const src = tmp()
    seedProfile(src)
    markProfileEncrypted(src)
    // A raw cloud archive, imported through the legacy path.
    const dst = tmp()
    importProfileArchive(packProfileCache(src), dst)

    expect(isProfileEncrypted(dst)).toBe(true)
  })
})

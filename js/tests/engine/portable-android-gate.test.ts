import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { exportProfileArchive, importProfileArchive } from '../../src/engine/profile-cache'
import { generatePersona } from '../../src/engine/persona'
import { DEFAULT_KERNEL_VERSION, ANDROID_MIN_KERNEL_VERSION } from '../../src/engine/downloader'

/**
 * Deliberately in its own file: it asserts what happens with the Android kernel
 * ABSENT from the catalogue, which is the state a fresh process is in. Any test
 * that registers it would make this one vacuous, and registration is global.
 */
describe('importing an android profile with no android kernel known', () => {
  const android = generatePersona(151, ANDROID_MIN_KERNEL_VERSION, { deviceType: 'android' })

  function androidArchive(): Buffer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-gate-'))
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(android, null, 2))
    return exportProfileArchive(dir, { name: 'a', kernelVersion: ANDROID_MIN_KERNEL_VERSION })
  }

  it('refuses rather than rewriting the pin to the default kernel', () => {
    expect(ANDROID_MIN_KERNEL_VERSION).not.toBe(DEFAULT_KERNEL_VERSION.version)
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-gate-dst-'))
    expect(() => importProfileArchive(androidArchive(), restoreDir)).toThrow(/not in the catalogue/)
  })

  it('leaves the target directory untouched when it refuses', () => {
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-gate-dst-'))
    expect(() => importProfileArchive(androidArchive(), restoreDir)).toThrow()
    expect(fs.readdirSync(restoreDir)).toEqual([])
  })

  it('still rewrites a desktop pin, which has no such constraint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-gate-desk-'))
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(generatePersona(160, '160.0.0.0')), 'utf8')
    const bytes = exportProfileArchive(dir, { name: 'd', kernelVersion: '160.0.0.0' })
    expect(new AdmZip(bytes).getEntry('manifest.json')).toBeTruthy()
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-gate-desk-dst-'))
    expect(importProfileArchive(bytes, restoreDir).kernelVersion).toBe(DEFAULT_KERNEL_VERSION.version)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { readPersona, loadOrGeneratePersona, generatePersona } from '../../src/engine/persona'
import { exportProfileArchive } from '../../src/engine/profile-cache'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-persona-norm-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('persona kernel version', () => {
  it('normalizes a legacy full version on read without rewriting the file', () => {
    const persona = { ...generatePersona(150, '150'), kernelVersion: '150.0.0.0' }
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(persona), 'utf8')

    expect(readPersona(dir)?.kernelVersion).toBe('150')
    expect(loadOrGeneratePersona(dir, '150').kernelVersion).toBe('150')

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8'))
    expect(onDisk.kernelVersion).toBe('150.0.0.0')
  })

  it('writes a major-only version for a brand new profile', () => {
    const persona = loadOrGeneratePersona(dir, '151.0.0.0')
    expect(persona.kernelVersion).toBe('151')
    expect(persona.chromeMajor).toBe(151)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8'))
    expect(onDisk.kernelVersion).toBe('151')
  })

  it('exports a major-only kernel_version', () => {
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(generatePersona(150, '150')), 'utf8')
    const zip = new AdmZip(exportProfileArchive(dir, { id: 'a', name: 'gmail', kernelVersion: '150.0.0.0' }))
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))
    expect(manifest.profile.kernel_version).toBe('150')
  })
})

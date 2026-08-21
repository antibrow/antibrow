import { describe, it, expect } from 'vitest'
import { generatePersona, personaToFpConfig, type Persona } from '../../src/engine/persona'

// A Windows persona on a Windows host needs no aliases; on any other host the
// Windows-only families are missing, and a missing family measures exactly like
// one that was never installed - the single signal that told a signup flow the
// persona was lying. The stand-ins must never join `allow`: a real Windows
// machine has no Selawik to enumerate.

function windowsPersona(): Persona {
  return generatePersona(150, '150')
}

function fontsFor(persona: Persona, hostPlatform: NodeJS.Platform): Record<string, unknown> {
  return personaToFpConfig(persona, { label: 'x', timezone: 'UTC', hostPlatform }).fonts as Record<string, unknown>
}

describe('windows font aliases follow the host', () => {
  it('ships the stand-ins on a non-Windows host', () => {
    for (const host of ['darwin', 'linux'] as NodeJS.Platform[]) {
      expect(fontsFor(windowsPersona(), host).alias).toEqual({
        'segoe ui': 'Selawia',
        'segoe ui semibold': 'Selawia',
        'segoe ui symbol': 'Selawia',
        calibri: 'Carlina',
        cambria: 'Caladria',
        'cambria math': 'Caladria',
        consolas: 'Consolita',
        sylfaen: 'Sylfano',
        'franklin gothic medium': 'Franklito',
        ebrima: 'Ebrisa',
        'times new roman': 'Liberation Serif',
        arial: 'Liberation Sans',
        'courier new': 'Courina',
        georgia: 'Georgina',
      })
    }
  })

  it('omits them on a Windows host, where those families are real', () => {
    expect('alias' in fontsFor(windowsPersona(), 'win32')).toBe(false)
  })

  it('keys are lowercase and trimmed, which is how the kernel looks them up', () => {
    const alias = fontsFor(windowsPersona(), 'darwin').alias as Record<string, string>
    for (const key of Object.keys(alias)) expect(key).toBe(key.trim().toLowerCase())
  })

  it('never lets a stand-in into the enumerable set', () => {
    const fonts = fontsFor(windowsPersona(), 'darwin')
    const allow = (fonts.allow as string[]).map((f) => f.toLowerCase())
    for (const substitute of Object.values(fonts.alias as Record<string, string>)) {
      expect(allow).not.toContain(substitute.toLowerCase())
    }
  })

  it('covers the Windows-only families the allowlist offers', () => {
    // An alias only bites for a family `allow` lets through, so these two lists
    // have to stay in step. The extra 'segoe ui semibold' entry is inert until
    // the allowlist names that weight, which is why it is not asserted here.
    const fonts = fontsFor(windowsPersona(), 'darwin')
    const allow = (fonts.allow as string[]).map((f) => f.toLowerCase())
    const alias = fonts.alias as Record<string, string>
    for (const family of [
      'segoe ui', 'segoe ui symbol', 'calibri', 'cambria', 'cambria math',
      'times new roman', 'arial', 'courier new',
      'consolas', 'sylfaen', 'franklin gothic medium', 'ebrima', 'georgia',
    ]) {
      expect(allow).toContain(family)
      expect(alias[family]).toBeTruthy()
    }
  })

  it('leaves an Android persona alone - its families ship with the kernel', () => {
    const android = generatePersona(150, '150', { deviceType: 'android' })
    expect('alias' in fontsFor(android, 'darwin')).toBe(false)
  })
})

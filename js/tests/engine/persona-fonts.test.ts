import { describe, it, expect } from 'vitest'
import { generatePersona, personaToFpConfig } from '../../src/engine/persona'

// fp-config.json is the contract with the kernel - its `fonts` shape must not
// drift. `allow` is a whitelist over the kernel's probeable font set; empty it
// and nothing is hidden, which is precisely how macOS/Linux system fonts
// leaked through a Windows persona on a non-Windows host. `generic` maps the
// CSS generic families to Windows fonts; drop a key and that family falls
// through to the host's own generic-family settings - a second leak path.

const EXPECTED_FONT_ALLOWLIST = [
  'Arial',
  'Arial Black',
  'Bahnschrift',
  'Calibri',
  'Cambria',
  'Cambria Math',
  'Candara',
  'Comic Sans MS',
  'Consolas',
  'Constantia',
  'Corbel',
  'Courier New',
  'Ebrima',
  'Franklin Gothic Medium',
  'Gabriola',
  'Gadugi',
  'Georgia',
  'Impact',
  'Ink Free',
  'Javanese Text',
  'Leelawadee UI',
  'Lucida Console',
  'Lucida Sans Unicode',
  'MV Boli',
  'Marlett',
  'Microsoft Sans Serif',
  'Palatino Linotype',
  'Segoe Print',
  'Segoe Script',
  'Segoe UI',
  'Segoe UI Emoji',
  'Segoe UI Symbol',
  'Sitka',
  'Sylfaen',
  'Symbol',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'Webdings',
  'Wingdings',
]

// Every entry names a second, more widely installed family. A generic that
// resolves to nothing measures like a family nobody has, which is the same
// contradiction the allowlist exists to avoid.
const EXPECTED_FONT_GENERIC = {
  standard: 'Times New Roman,Georgia',
  serif: 'Times New Roman,Georgia',
  sansSerif: 'Arial,Verdana',
  cursive: 'Comic Sans MS,Trebuchet MS',
  fantasy: 'Impact,Arial Black',
  monospace: 'Consolas,Courier New',
  math: 'Cambria Math,Times New Roman,Georgia',
}

// Windows-exclusive and with no stand-in: unrenderable on any other host.
const NEVER_ON_A_FOREIGN_HOST = [
  'Bahnschrift', 'Candara', 'Constantia', 'Corbel', 'Gabriola', 'Gadugi',
  'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console',
  'Lucida Sans Unicode', 'MV Boli', 'Marlett', 'Palatino Linotype',
  'Segoe Print', 'Segoe Script', 'Segoe UI Emoji', 'Sitka', 'Symbol',
]

// The families a detector expects a Windows machine to measure. Each has a
// stand-in, so each must produce its own width rather than the one a family
// nobody installed produces.
const SIGNATURE_FAMILIES_WITH_A_STAND_IN = [
  'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Sylfaen',
  'Franklin Gothic Medium', 'Ebrima',
]

// Pinned rather than left to process.platform: `allow` now depends on the host,
// so an unpinned call says something different on each CI runner.
function configFor(hostPlatform: NodeJS.Platform = 'win32'): Record<string, unknown> {
  const persona = generatePersona(150, '150.0.0.0')
  return personaToFpConfig(persona, { label: 'profile-1', timezone: 'America/Los_Angeles', hostPlatform })
}

describe('fp-config fonts block', () => {
  it('keeps the windows ui font and no cjk', () => {
    const config = configFor()
    const fonts = config.fonts as Record<string, unknown>
    expect(fonts.uiFont).toBe('Segoe UI')
    expect(fonts.keepCjk).toBe(0)
    expect(fonts.block).toEqual([])
  })

  it('allow is the full windows font whitelist', () => {
    // Must fail if `allow` ever goes back to empty - an empty allowlist hides
    // nothing and is exactly the bug that let macOS system fonts enumerate.
    const config = configFor()
    const fonts = config.fonts as Record<string, unknown>
    expect(fonts.allow).toEqual(EXPECTED_FONT_ALLOWLIST)
  })

  it('drops the families a non-Windows host can never render', () => {
    // Keeping them would have the enumerable set claim a font the measured set
    // reports as absent - one browser contradicting itself.
    const allow = (configFor('darwin').fonts as Record<string, unknown>).allow as string[]
    for (const family of NEVER_ON_A_FOREIGN_HOST) expect(allow).not.toContain(family)
    // The aliased families stay: a stand-in renders them with Windows metrics.
    for (const family of [...SIGNATURE_FAMILIES_WITH_A_STAND_IN, 'Segoe UI Symbol', 'Cambria Math']) {
      expect(allow).toContain(family)
    }
    // So do the ones another desktop OS plausibly ships.
    for (const family of ['Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma']) {
      expect(allow).toContain(family)
    }
  })

  it('keeps the whole list on a Windows host, where every family is real', () => {
    expect((configFor('win32').fonts as Record<string, unknown>).allow).toEqual(EXPECTED_FONT_ALLOWLIST)
  })

  it('generic maps every css generic family', () => {
    // Must fail if any of the seven keys disappears - a missing key falls
    // through to the host's generic-family fonts.
    const config = configFor()
    const fonts = config.fonts as Record<string, unknown>
    expect(fonts.generic).toEqual(EXPECTED_FONT_GENERIC)
    expect(Object.keys(fonts.generic as Record<string, unknown>).sort()).toEqual(
      ['cursive', 'fantasy', 'math', 'monospace', 'sansSerif', 'serif', 'standard'].sort(),
    )
  })
})

// A replayed real device brings an open-ended font list - whatever that machine
// happened to have installed. The filter must hold for names nobody enumerated
// in advance, or the profile claims families the host has no glyphs for and
// every one of them measures as the same fallback width.
const CAPTURED_WINDOWS_FONTS = [
  'Arial', 'Segoe UI', 'Georgia', 'Verdana', 'Tahoma',
  'Consolas', 'Sylfaen', 'Ebrima', 'Franklin Gothic Medium',
  'MS Gothic', 'SimSun', 'Microsoft YaHei', 'Malgun Gothic', 'Yu Gothic',
  'Segoe MDL2 Assets', 'HoloLens MDL2 Assets', 'Montserrat',
]

function capturedConfigFor(hostPlatform: NodeJS.Platform): Record<string, unknown> {
  const persona = generatePersona(150, '150.0.0.0')
  persona.captured = { fonts: CAPTURED_WINDOWS_FONTS }
  return personaToFpConfig(persona, { label: 'profile-1', hostPlatform })
}

describe('captured font lists', () => {
  it('drops captured families a foreign host cannot render', () => {
    const allow = (capturedConfigFor('darwin').fonts as Record<string, unknown>).allow as string[]
    // Stand-in fonts ship with the kernel, so these render with Windows metrics.
    for (const family of ['Arial', 'Segoe UI']) expect(allow).toContain(family)
    // macOS ships these under the same family name.
    for (const family of ['Georgia', 'Verdana', 'Tahoma']) expect(allow).toContain(family)
    // A stand-in keeps these enumerable and measurable.
    for (const family of ['Consolas', 'Sylfaen', 'Ebrima', 'Franklin Gothic Medium']) {
      expect(allow).toContain(family)
    }
    // No stand-in and no host glyphs. The CJK and icon families are the ones the
    // hand-written Windows-only list never covered.
    for (const family of [
      'MS Gothic', 'SimSun', 'Microsoft YaHei', 'Malgun Gothic', 'Yu Gothic',
      'Segoe MDL2 Assets', 'HoloLens MDL2 Assets', 'Montserrat',
    ]) expect(allow).not.toContain(family)
  })

  it('replays the capture verbatim on a Windows host', () => {
    const allow = (capturedConfigFor('win32').fonts as Record<string, unknown>).allow as string[]
    expect(allow).toEqual(CAPTURED_WINDOWS_FONTS)
  })

  it('never empties allow, which would switch the kernel back to hiding nothing', () => {
    const persona = generatePersona(150, '150.0.0.0')
    persona.captured = { fonts: ['Sylfaen', 'Ebrima', 'MS Gothic'] }
    const allow = (personaToFpConfig(persona, { label: 'p', hostPlatform: 'darwin' })
      .fonts as Record<string, unknown>).allow as string[]
    expect(allow.length).toBeGreaterThan(0)
  })
})

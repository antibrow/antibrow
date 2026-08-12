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

const EXPECTED_FONT_GENERIC = {
  standard: 'Times New Roman',
  serif: 'Times New Roman',
  sansSerif: 'Arial',
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
  monospace: 'Consolas,Courier New',
  math: 'Cambria Math,Times New Roman',
}

function configFor(): Record<string, unknown> {
  const persona = generatePersona(150, '150.0.0.0')
  return personaToFpConfig(persona, { label: 'profile-1', timezone: 'America/Los_Angeles' })
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

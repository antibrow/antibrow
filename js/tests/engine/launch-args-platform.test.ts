import { describe, it, expect } from 'vitest'
import { buildLaunchArgs, isStrayLocaleTabUrl, resolveDisplayLabel, type BuildLaunchArgsOptions } from '../../src/engine/launcher'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The container-only switches must be gated on linux, never on "not windows" -
// a prior version of this test asserted that by grepping the source text for
// the isLinux token on the one line containing '--no-sandbox', which missed
// the other six switches sitting on continuation lines. Asserting on the real
// argv from the extracted, platform-parametrized builder closes that hole.

const CONTAINER_SWITCHES = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-crash-reporter',
  '--no-zygote',
]

const WINDOWS_HEADLESS_SWITCHES = ['--window-position=-10000,-10000']

const ALWAYS_PRESENT_PREFIXES = [
  '--fp-config',
  '--fp-license',
  '--user-data-dir',
  '--fp-address-label',
  '--remote-debugging-port',
  '--remote-allow-origins',
  '--no-first-run',
  '--no-default-browser-check',
  '--lang',
]

function baseOptions(platform: NodeJS.Platform, headless = false): BuildLaunchArgsOptions {
  return {
    fpConfigPath: '/profiles/p1/fp-config.json',
    licenseToken: 'token-abc',
    userDataDir: '/profiles/p1/user-data',
    displayLabel: 'p1',
    cdpPort: 9222,
    language: 'en-US',
    headless,
    profileDir: '/profiles/p1',
    platform,
  }
}

function hasSwitch(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`))
}

describe('buildLaunchArgs', () => {
  it('includes all seven container-only switches on linux', () => {
    const args = buildLaunchArgs(baseOptions('linux'))
    for (const flag of CONTAINER_SWITCHES) {
      expect(args).toContain(flag)
    }
  })

  it('gates exactly the seven container-only switches on linux, nothing more', () => {
    // Derive the gated set from the argv delta (linux minus darwin) rather than
    // from CONTAINER_SWITCHES itself: filtering args down to members of a known
    // list before comparing to that same list can never catch an addition, only
    // a member going missing (which the previous test already covers). Diffing
    // against darwin means an eighth switch newly added inside the isLinux
    // block shows up in the delta and fails the comparison.
    const linuxArgs = buildLaunchArgs(baseOptions('linux'))
    const darwinArgs = buildLaunchArgs(baseOptions('darwin'))
    const linuxOnly = linuxArgs.filter((a) => !darwinArgs.includes(a))
    expect(linuxOnly.sort()).toEqual([...CONTAINER_SWITCHES].sort())
  })

  it('omits every container-only switch on darwin', () => {
    const args = buildLaunchArgs(baseOptions('darwin'))
    for (const flag of CONTAINER_SWITCHES) {
      expect(args).not.toContain(flag)
    }
  })

  it('omits every container-only switch on win32', () => {
    const args = buildLaunchArgs(baseOptions('win32'))
    for (const flag of CONTAINER_SWITCHES) {
      expect(args).not.toContain(flag)
    }
  })

  it('includes the windows-only headless switches on win32 when headless', () => {
    const args = buildLaunchArgs(baseOptions('win32', true))
    for (const flag of WINDOWS_HEADLESS_SWITCHES) {
      expect(args).toContain(flag)
    }
  })

  it('omits the windows-only headless switches on linux when headless', () => {
    const args = buildLaunchArgs(baseOptions('linux', true))
    for (const flag of WINDOWS_HEADLESS_SWITCHES) {
      expect(args).not.toContain(flag)
    }
  })

  it('omits the windows-only headless switches on darwin when headless', () => {
    const args = buildLaunchArgs(baseOptions('darwin', true))
    for (const flag of WINDOWS_HEADLESS_SWITCHES) {
      expect(args).not.toContain(flag)
    }
  })

  it.each<NodeJS.Platform>(['win32', 'linux', 'darwin'])(
    'always includes the core switches on %s',
    (platform) => {
      const args = buildLaunchArgs(baseOptions(platform))
      for (const flag of ALWAYS_PRESENT_PREFIXES) {
        expect(hasSwitch(args, flag)).toBe(true)
      }
    },
  )

  it.each<NodeJS.Platform>(['win32', 'linux', 'darwin'])(
    'always includes the webauthn store switch on %s',
    (platform) => {
      const args = buildLaunchArgs(baseOptions(platform))
      expect(hasSwitch(args, '--fp-webauthn-store')).toBe(true)
    },
  )

  it('adds --fp-webauthn-create=choose only when webauthnCapture is false', () => {
    const withCapture = buildLaunchArgs({ ...baseOptions('win32'), webauthnCapture: true })
    const withoutCapture = buildLaunchArgs({ ...baseOptions('win32'), webauthnCapture: false })
    expect(withCapture).not.toContain('--fp-webauthn-create=choose')
    expect(withoutCapture).toContain('--fp-webauthn-create=choose')
  })

  it('adds -AppleLanguages (en-US) as adjacent argv entries on darwin, derived from the persona language', () => {
    const args = buildLaunchArgs({ ...baseOptions('darwin'), language: 'en-US' })
    const idx = args.indexOf('-AppleLanguages')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('(en-US)')

    const de = buildLaunchArgs({ ...baseOptions('darwin'), language: 'de-DE' })
    expect(de[de.indexOf('-AppleLanguages') + 1]).toBe('(de-DE)')
  })

  it('omits -AppleLanguages on win32 and linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const args = buildLaunchArgs(baseOptions(platform))
      expect(args).not.toContain('-AppleLanguages')
    }
  })

  // --no-startup-window WOULD stop the positional `(en-US)` from ever being
  // loaded, but it also defers session restore: Chromium then restores the
  // profile's previous tabs into a window of its own, next to the one the SDK
  // creates over CDP, so opening an existing profile ends up with two windows.
  // Verified on a real profile. The stray tab is closed after connecting instead.
  it('never suppresses the startup window, on any platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(buildLaunchArgs(baseOptions(platform))).not.toContain('--no-startup-window')
    }
  })

  // A device-bound session's private key lives in the OS keystore and cannot be
  // exported, so a profile that registers one is refused on the next machine -
  // observed as Gmail signed out while GitHub, which does not use DBSC, stayed
  // signed in.
  it.each<NodeJS.Platform>(['win32', 'linux', 'darwin'])(
    'keeps device-bound sessions off on %s',
    (platform) => {
      expect(buildLaunchArgs(baseOptions(platform))).toContain('--disable-features=DeviceBoundSessions')
    },
  )

  // Chromium's default startup is the new tab page; only a crashed exit offers
  // restore. Left to the default, whether a profile reopens its tabs depends on
  // how the previous session died.
  it.each<NodeJS.Platform>(['win32', 'linux', 'darwin'])(
    'restores the previous tabs by default on %s',
    (platform) => {
      const args = buildLaunchArgs(baseOptions(platform))
      expect(args).toContain('--restore-last-session')
      expect(args).toContain('--hide-crash-restore-bubble')
    },
  )

  it('drops the restore switches when restoreTabs is false', () => {
    const args = buildLaunchArgs({ ...baseOptions('darwin'), restoreTabs: false })
    expect(args).not.toContain('--restore-last-session')
    expect(args).not.toContain('--hide-crash-restore-bubble')
  })
})

// The `(en-US)` half of the pair has no leading dash, so Chromium's own parser
// takes it for a positional arg and opens it as a URL. Confirmed against a real
// Chromium build: the tab lands on `http://(en-us)/` - lowercased by URL fixup.
describe('isStrayLocaleTabUrl', () => {
  it('matches the tab Chromium opens for the AppleLanguages value', () => {
    expect(isStrayLocaleTabUrl('http://(en-us)/', 'en-US')).toBe(true)
    expect(isStrayLocaleTabUrl('http://(de-de)/', 'de-DE')).toBe(true)
    expect(isStrayLocaleTabUrl('(en-US)', 'en-US')).toBe(true)
    expect(isStrayLocaleTabUrl('http%3A%2F%2F(en-us)%2F', 'en-US')).toBe(true)
  })

  it('leaves real pages alone', () => {
    for (const url of [
      'about:blank',
      'https://whoer.net/',
      'https://example.com/?q=(en-us)',
      'http://en-us/',
      'chrome://newtab/',
    ]) {
      expect(isStrayLocaleTabUrl(url, 'en-US')).toBe(false)
    }
  })
})

describe('resolveDisplayLabel', () => {
  const withMeta = (name: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'))
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id: 'uuid-a', name, origin: 'local' }), 'utf8')
    return dir
  }

  it('prefers an explicit label', () => {
    expect(resolveDisplayLabel(withMeta('gmail'), 'Work')).toBe('Work')
  })

  it('falls back to the recorded profile name, never the id-shaped directory name', () => {
    const dir = withMeta('gmail')
    expect(resolveDisplayLabel(dir)).toBe('gmail')
    // An empty label is not a usable label, and openProfile's `??` lets one through.
    expect(resolveDisplayLabel(dir, '')).toBe('gmail')
  })

  it('falls back to the directory name only when there is no record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-none-'))
    expect(resolveDisplayLabel(dir)).toBe(path.basename(dir))
  })
})

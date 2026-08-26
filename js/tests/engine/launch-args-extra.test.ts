import { describe, expect, it } from 'vitest'

import { buildLaunchArgs, mergeFeatureSwitches } from '../../src/engine/launcher'

const base = {
  fpConfigPath: '/p/fp-config.json',
  licenseToken: 'T.S',
  userDataDir: '/p/user-data',
  profileDir: '/p',
  displayLabel: 'demo',
  cdpPort: 1234,
  language: 'en-US',
  platform: 'darwin' as NodeJS.Platform,
}

describe('extra Chromium switches', () => {
  it('reach the kernel', () => {
    const args = buildLaunchArgs({ ...base, extraArgs: ['--mute-audio'] })

    expect(args).toContain('--mute-audio')
  })

  it('come last, so a caller can override an earlier switch of ours', () => {
    const args = buildLaunchArgs({ ...base, extraArgs: ['--fp-cdp-attach-iframes'] })

    expect(args.at(-1)).toBe('--fp-cdp-attach-iframes')
  })

  it('change nothing when none are given', () => {
    expect(buildLaunchArgs({ ...base, extraArgs: [] })).toEqual(buildLaunchArgs(base))
    expect(buildLaunchArgs({ ...base, extraArgs: undefined })).toEqual(buildLaunchArgs(base))
  })

  it('cannot shadow the switch that keeps sign-ins portable', () => {
    // Chromium keeps only the LAST --disable-features, so an unmerged caller
    // switch would silently drop DeviceBoundSessions and re-arm the
    // cross-machine sign-out.
    const args = buildLaunchArgs({ ...base, extraArgs: ['--disable-features=Translate'] })

    const disable = args.filter((a) => a.startsWith('--disable-features='))
    expect(disable).toHaveLength(1)
    expect(disable[0]).toContain('DeviceBoundSessions')
    expect(disable[0]).toContain('Translate')
  })
})

describe('mergeFeatureSwitches', () => {
  it('collapses repeats of both feature switches into one each', () => {
    const merged = mergeFeatureSwitches([
      '--disable-features=A',
      '--enable-features=X',
      '--disable-features=B',
      '--enable-features=Y',
    ])

    expect(merged).toEqual(['--disable-features=A,B', '--enable-features=X,Y'])
  })

  it('keeps the position of the first occurrence', () => {
    const merged = mergeFeatureSwitches(['--mute-audio', '--disable-features=A', '--foo', '--disable-features=B'])

    expect(merged).toEqual(['--mute-audio', '--disable-features=A,B', '--foo'])
  })

  it('does not repeat a value both sides asked for', () => {
    expect(mergeFeatureSwitches(['--disable-features=A', '--disable-features=A'])).toEqual([
      '--disable-features=A',
    ])
  })

  it('ignores empty entries and surrounding whitespace', () => {
    expect(mergeFeatureSwitches(['--disable-features=A, ,B '])).toEqual(['--disable-features=A,B'])
  })

  it('leaves a command line with no feature switches untouched', () => {
    expect(mergeFeatureSwitches(['--mute-audio', '--foo=1'])).toEqual(['--mute-audio', '--foo=1'])
  })
})

describe('finalizeLaunchArgs', () => {
  it('puts the caller last, so their switch wins over ours', async () => {
    // In this SDK the window icon and the proxy are pushed after buildLaunchArgs
    // returns, so the caller's switches have to be appended here to keep the
    // same precedence the Python SDK gives them.
    const { finalizeLaunchArgs } = await import('../../src/engine/launcher')

    const args = finalizeLaunchArgs(['--proxy-server=ours'], ['--proxy-server=theirs'])

    expect(args.at(-1)).toBe('--proxy-server=theirs')
  })

  it('still merges feature switches across the join', async () => {
    const { finalizeLaunchArgs } = await import('../../src/engine/launcher')

    const args = finalizeLaunchArgs(['--disable-features=DeviceBoundSessions'], [
      '--disable-features=Translate',
    ])

    expect(args).toEqual(['--disable-features=DeviceBoundSessions,Translate'])
  })

  it('is a no-op when the caller passed nothing', async () => {
    const { finalizeLaunchArgs } = await import('../../src/engine/launcher')

    expect(finalizeLaunchArgs(['--mute-audio'], undefined)).toEqual(['--mute-audio'])
  })
})

import { describe, it, expect } from 'vitest'
import {
  kernelReadsAppLocaleFromConfig,
  kernelSupportsAndroid,
  findKernelVersion,
  findKernelVersionStrict,
  ANDROID_MIN_KERNEL_VERSION,
  DEFAULT_KERNEL_VERSION,
} from '../../src/engine/downloader'
import { buildLaunchArgs } from '../../src/engine/launcher'

const MIN = ANDROID_MIN_KERNEL_VERSION

describe('kernelSupportsAndroid', () => {
  it('accepts the floor and everything above it', () => {
    expect(kernelSupportsAndroid(MIN)).toBe(true)
    expect(kernelSupportsAndroid('152')).toBe(true)
    expect(kernelSupportsAndroid('200')).toBe(true)
  })

  it('rejects anything below the floor', () => {
    expect(kernelSupportsAndroid('150')).toBe(false)
    expect(kernelSupportsAndroid('149')).toBe(false)
    expect(kernelSupportsAndroid(undefined)).toBe(false)
    expect(kernelSupportsAndroid('')).toBe(false)
  })

  it('normalizes a legacy full version', () => {
    // An Android profile created before kernels went major-only pins one of these.
    expect(kernelSupportsAndroid('151.7.7.7')).toBe(true)
    expect(kernelSupportsAndroid('150.7.7.7')).toBe(false)
  })

  it('ignores the build stamp, however it is shaped', () => {
    // A missing or stale stamp used to reject a perfectly capable kernel: the
    // compiled-in baseline carries no build at all, and a manifest row may omit
    // it. The second argument is kept only so older callers still compile.
    expect(kernelSupportsAndroid(MIN, undefined)).toBe(true)
    expect(kernelSupportsAndroid(MIN, '')).toBe(true)
    expect(kernelSupportsAndroid(MIN, '2026-08-02')).toBe(true)
    expect(kernelSupportsAndroid('152', undefined)).toBe(true)
    expect(kernelSupportsAndroid(MIN, 'proxyauth-fix+utf8label 2026-07-28')).toBe(true)
    // ...but it never rescues a version below the floor.
    expect(kernelSupportsAndroid('150', '2026-09-01 00:00')).toBe(false)
  })

  it('pins the minimum version', () => {
    expect(ANDROID_MIN_KERNEL_VERSION).toBe('151')
  })
})

describe('findKernelVersionStrict', () => {
  it('throws instead of substituting the default for an unknown version', () => {
    // The Android kernel is not in the compiled-in baseline; with no manifest
    // refresh, the lenient lookup silently answers with Chrome 150.
    expect(findKernelVersion(ANDROID_MIN_KERNEL_VERSION).version).toBe(DEFAULT_KERNEL_VERSION.version)
    expect(() => findKernelVersionStrict(ANDROID_MIN_KERNEL_VERSION)).toThrow(/not in the catalogue/)
  })

  it('returns a version the catalogue does know', () => {
    expect(findKernelVersionStrict(DEFAULT_KERNEL_VERSION.version).version).toBe(DEFAULT_KERNEL_VERSION.version)
  })
})

describe('android launch args', () => {
  const base = {
    fpConfigPath: '/p/fp-config.json',
    licenseToken: 'tok',
    userDataDir: '/p/user-data',
    displayLabel: 'demo',
    cdpPort: 9222,
    language: 'en-US',
    profileDir: '/p',
    platform: 'win32' as const,
  }

  it('sizes the window to the persona screen', () => {
    const args = buildLaunchArgs({ ...base, androidScreen: { width: 412, height: 917 } })
    expect(args).toContain('--window-size=412,917')
  })

  it('adds nothing for a desktop profile', () => {
    const args = buildLaunchArgs(base)
    expect(args.some((a) => a.startsWith('--window-size='))).toBe(false)
  })

  it('keeps the persona screen size when headless moves the window off-screen', () => {
    const args = buildLaunchArgs({ ...base, headless: true, androidScreen: { width: 412, height: 917 } })
    expect(args).toContain('--window-size=412,917')
    expect(args).toContain('--window-position=-10000,-10000')
  })
})

describe('kernelReadsAppLocaleFromConfig', () => {
  it('needs both the version and a build from the day the patch shipped', () => {
    // 150 was rebuilt the same day without the patch, so the date alone is not
    // enough; 151's earlier builds predate it, so the version alone is not either.
    expect(kernelReadsAppLocaleFromConfig('151.0.0.0', '2026-08-10c')).toBe(true)
    expect(kernelReadsAppLocaleFromConfig('151.0.0.0', '2026-08-08 16:23')).toBe(false)
    expect(kernelReadsAppLocaleFromConfig('150.0.0.0', '2026-08-10')).toBe(false)
    expect(kernelReadsAppLocaleFromConfig('151.0.0.0', undefined)).toBe(false)
  })
})

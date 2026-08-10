import { describe, it, expect } from 'vitest'
import {
  kernelSupportsAndroid,
  findKernelVersion,
  findKernelVersionStrict,
  ANDROID_MIN_KERNEL_VERSION,
  DEFAULT_KERNEL_VERSION,
} from '../../src/engine/downloader'
import { buildLaunchArgs } from '../../src/engine/launcher'

const MIN = ANDROID_MIN_KERNEL_VERSION

describe('kernelSupportsAndroid', () => {
  it('rejects an unmarked install', () => {
    expect(kernelSupportsAndroid(MIN, undefined)).toBe(false)
    expect(kernelSupportsAndroid(MIN, '')).toBe(false)
  })

  it('rejects an older build of the same version', () => {
    // 151 shipped twice: this one predates the mobile patches and would produce
    // an Android UA beside desktop client hints.
    expect(kernelSupportsAndroid(MIN, '2026-08-02')).toBe(false)
    expect(kernelSupportsAndroid(MIN, '2026-08-04 19:04')).toBe(false)
  })

  it('accepts the build that carries the mobile patches and anything later', () => {
    expect(kernelSupportsAndroid(MIN, '2026-08-07 05:17')).toBe(true)
    expect(kernelSupportsAndroid(MIN, '2026-08-07 14:59')).toBe(true)
    expect(kernelSupportsAndroid(MIN, '2026-09-01 00:00')).toBe(true)
  })

  it('rejects a label that is not a date', () => {
    expect(kernelSupportsAndroid(MIN, 'proxyauth-fix+utf8label 2026-07-28')).toBe(false)
  })

  it('rejects an older version no matter how new its build is', () => {
    // The whole kernel set gets republished on one day, so 149 and 150 carry
    // build stamps at or after the Android minimum while having none of the
    // mobile patches. These are the exact stamps live in the manifest.
    expect(kernelSupportsAndroid('150.0.7871.182', '2026-08-08 16:22')).toBe(false)
    expect(kernelSupportsAndroid('149.0.7827.201', '2026-08-08 16:23')).toBe(false)
    expect(kernelSupportsAndroid(undefined, '2026-08-08 16:23')).toBe(false)
    // The same date on the pinned version is fine - the date was never the problem.
    expect(kernelSupportsAndroid(MIN, '2026-08-08 16:23')).toBe(true)
  })

  it('accepts a version above the minimum', () => {
    expect(kernelSupportsAndroid('152.0.0.0', '2026-09-01 00:00')).toBe(true)
    expect(kernelSupportsAndroid('151.0.7922.73', '2026-09-01 00:00')).toBe(true)
    expect(kernelSupportsAndroid('151.0.7922.71', '2026-09-01 00:00')).toBe(false)
  })

  it('pins the minimum version', () => {
    expect(ANDROID_MIN_KERNEL_VERSION).toBe('151.0.7922.72')
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

  it('lets headless keep its own window size on Windows', () => {
    const args = buildLaunchArgs({ ...base, headless: true })
    expect(args).toContain('--window-size=1,1')
  })
})

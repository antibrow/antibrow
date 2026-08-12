import { describe, it, expect } from 'vitest'
import {
  KERNEL_VERSIONS,
  kernelAsset,
  kernelAvailableOnPlatform,
  kernelsForPlatform,
  kernelExePath,
  registerKernelVersions,
} from '../../src/engine/downloader'

// arm64 is its own `linux-arm64` asset key; the manifest spells it `linuxarm64`.
describe('linux arm64 kernel catalogue', () => {
  it('ships an arm64 build for every baseline version', () => {
    for (const kv of KERNEL_VERSIONS) {
      expect(kernelAvailableOnPlatform(kv, 'linux-arm64'), kv.version).toBe(true)
    }
  })

  it('keeps the arm64 asset distinct from the x86_64 one', () => {
    const v150 = KERNEL_VERSIONS.find((kv) => kv.version === '150')!
    expect(kernelAsset(v150, 'linux-arm64').downloadUrl).toBe(
      'https://download.antibrow.com/fp-chromium-150-linuxarm64.zip',
    )
    expect(kernelAsset(v150, 'linux').downloadUrl).toBe(
      'https://download.antibrow.com/fp-chromium-150-linux64.zip',
    )
    // Same bare binary name as x86_64: the kernel dir layout does not change.
    expect(kernelAsset(v150, 'linux-arm64').exeRelPath).toBe('chrome')
    // Normalised: kernelExePath joins with the host separator, and this suite
    // also runs on Windows.
    expect(kernelExePath('/cache', v150, 'linux-arm64').replace(/\\/g, '/'))
      .toBe('/cache/kernels/150/chrome')
  })

  it('lists arm64-capable versions for linux-arm64', () => {
    const versions = kernelsForPlatform('linux-arm64').map((kv) => kv.version)
    expect(versions).toContain('150')
  })

  it('maps the linuxarm64 manifest token onto linux-arm64', () => {
    // registerKernelVersions is the same path fetchRemoteKernelVersions feeds.
    registerKernelVersions([
      {
        version: '151',
        label: 'Chrome 151',
        platforms: {
          'linux-arm64': {
            downloadUrl: 'https://download.antibrow.com/fp-chromium-151-linuxarm64.zip',
            exeRelPath: 'chrome',
            build: 'test',
          },
        },
      },
    ])
    const discovered = kernelsForPlatform('linux-arm64').find((kv) => kv.version === '151')
    expect(discovered).toBeDefined()
    expect(kernelAsset(discovered!, 'linux-arm64').build).toBe('test')
    // arm64-only kernel: it must not offer itself to x86_64 linux.
    expect(kernelAvailableOnPlatform(discovered!, 'linux')).toBe(false)
  })
})

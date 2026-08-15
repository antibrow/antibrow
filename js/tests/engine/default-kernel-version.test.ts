import { describe, it, expect } from 'vitest'
import {
  defaultKernelVersion,
  findKernelVersion,
  registerKernelVersions,
  currentPlatform,
  KERNEL_VERSIONS,
  type SupportedPlatform,
} from '../../src/engine/downloader'

// Registering mutates module state with no reset hook, so this file owns its own
// module instance and the cases run in order: baseline-only first, then the
// manifest ones.
const plat = currentPlatform()
const otherPlat: SupportedPlatform = plat === 'win32' ? 'darwin' : 'win32'

function asset(version: string, p: SupportedPlatform) {
  return {
    version,
    label: `Chrome ${version}`,
    platforms: { [p]: { downloadUrl: `https://x/${version}.zip`, exeRelPath: 'chrome' } },
  }
}

describe('defaultKernelVersion', () => {
  it('falls back to the compiled-in baseline when the manifest brought nothing', () => {
    expect(defaultKernelVersion().version).toBe(KERNEL_VERSIONS[0].version)
  })

  it('ignores a newer version that has no asset for this platform', () => {
    registerKernelVersions([asset('900', otherPlat)])
    expect(defaultKernelVersion().version).toBe(KERNEL_VERSIONS[0].version)
  })

  it('follows a manifest version newer than the baseline', () => {
    registerKernelVersions([asset('901', plat)])
    expect(defaultKernelVersion().version).toBe('901')
  })

  it('stays on the newest even when an older version is registered afterwards', () => {
    registerKernelVersions([asset('148', plat)])
    expect(defaultKernelVersion().version).toBe('901')
  })

  it('is what an unknown version falls back to', () => {
    expect(findKernelVersion('nope').version).toBe('901')
    expect(findKernelVersion(undefined).version).toBe('901')
  })

  it('answers with the baseline instead of throwing on an unsupported platform', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true })
    try {
      expect(defaultKernelVersion().version).toBe(KERNEL_VERSIONS[0].version)
    } finally {
      Object.defineProperty(process, 'platform', real)
    }
  })
})

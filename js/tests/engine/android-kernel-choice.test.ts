import { describe, it, expect } from 'vitest'
import {
  androidCapableKernels,
  resolveAndroidKernel,
  registerKernelVersions,
  currentPlatform,
  ANDROID_MIN_KERNEL_VERSION,
  DEFAULT_KERNEL_VERSION,
} from '../../src/engine/downloader'

const PLAT = currentPlatform()

function publish(version: string, build: string): void {
  registerKernelVersions([{
    version,
    label: `Chrome ${version.split('.')[0]}`,
    platforms: { [PLAT]: { downloadUrl: `https://example.test/${version}.zip`, exeRelPath: 'chrome', build } },
  }])
}

// Order matters: the first block runs against the compiled-in baseline only.
describe('android kernel choice', () => {
  it('offers nothing, and refuses to guess, before the manifest is read', () => {
    // The baseline carries a desktop kernel with no build stamp, so a lenient
    // lookup would answer with it - an Android profile frozen onto a kernel with
    // no mobile patches. Failing loudly is the point.
    expect(androidCapableKernels()).toEqual([])
    expect(() => resolveAndroidKernel()).toThrow(/not in the catalogue/)
    expect(() => resolveAndroidKernel(DEFAULT_KERNEL_VERSION.version)).toThrow(/not in the catalogue/)
  })

  it('lists every qualifying kernel the manifest publishes, newest first', () => {
    publish(ANDROID_MIN_KERNEL_VERSION, '2026-08-07 05:17')
    publish('152', '2026-09-20 10:00')
    // Same-day rebuild of an older major: fresh stamp, none of the mobile patches.
    publish('150', '2026-09-20 10:00')

    expect(androidCapableKernels().map((kv) => kv.version)).toEqual(['152', ANDROID_MIN_KERNEL_VERSION])
  })

  it('honours a qualifying request and defaults to the newest one otherwise', () => {
    // The whole point: the floor is not a pin. A profile can be created against
    // 151 while 152 is out, and a new one gets 152 without a code change.
    expect(resolveAndroidKernel(ANDROID_MIN_KERNEL_VERSION).version).toBe(ANDROID_MIN_KERNEL_VERSION)
    expect(resolveAndroidKernel().version).toBe('152')
    // An Android profile created before kernels went major-only pins a full
    // version string. It must still resolve to its own kernel rather than being
    // silently upgraded to the newest qualifying one.
    expect(resolveAndroidKernel('151.7.7.7').version).toBe(ANDROID_MIN_KERNEL_VERSION)
    // A version that cannot run Android never wins, however explicitly it is asked for.
    expect(resolveAndroidKernel('150.7.7.7').version).toBe('152')
    expect(resolveAndroidKernel('999.0.0.0').version).toBe('152')
  })

  it('ignores a version built for another platform', () => {
    const other = PLAT === 'win32' ? 'linux' : 'win32'
    registerKernelVersions([{
      version: '153',
      label: 'Chrome 153',
      platforms: { [other]: { downloadUrl: 'https://example.test/153.zip', exeRelPath: 'chrome', build: '2026-10-01 00:00' } },
    }])
    expect(androidCapableKernels().map((kv) => kv.version)).not.toContain('153')
    expect(resolveAndroidKernel().version).toBe('152')
  })
})

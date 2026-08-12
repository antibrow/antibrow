import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Exercise openProfile's kernel-catalogue wiring in isolation: mock the kernel
// downloader + launcher + persona so we can assert exactly when the manifest is
// refreshed and when a force-update runs, without touching the network, a real
// kernel, or a real browser.

const ensureKernelSpy = vi.fn(async () => 'C:/kernels/chrome.exe')
const refreshSpy = vi.fn(async () => undefined)
const kernelUpdateStatusSpy = vi.fn((): Record<string, unknown> | null => null)

vi.mock('../../src/engine/downloader', () => ({
  DEFAULT_KERNEL_VERSION: { version: '150.0.0.0', label: 'Chrome 150', platforms: {} },
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: (...a: unknown[]) => ensureKernelSpy(...(a as [])),
  refreshKernelVersions: (...a: unknown[]) => refreshSpy(...(a as [])),
  kernelUpdateStatus: (...a: unknown[]) => kernelUpdateStatusSpy(...(a as [])),
  installedKernelBuild: () => undefined,
  kernelReadsAppLocaleFromConfig: () => false,
}))

vi.mock('../../src/engine/persona', () => ({
  loadOrGeneratePersona: () => ({ kernelVersion: '150.0.0.0', chromeMajor: 150, timezone: 'UTC', languages: ['en-US'] }),
}))

const launchKernelSpy = vi.fn(async () => ({
  context: { pages: () => [], newPage: vi.fn() },
  profileDir: '',
  onExit: vi.fn(),
  close: vi.fn(async () => undefined),
}))
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: (...a: unknown[]) => launchKernelSpy(...(a as [])),
}))

import { openProfile } from '../../src/engine/index'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opu-'))
}

beforeEach(() => {
  ensureKernelSpy.mockClear()
  refreshSpy.mockClear()
  refreshSpy.mockResolvedValue(undefined)
  kernelUpdateStatusSpy.mockReset()
  kernelUpdateStatusSpy.mockReturnValue(null)
  launchKernelSpy.mockClear()
})

describe('openProfile kernel catalogue', () => {
  const base = () => ({ cacheDir: tmp(), profileName: 'p', licenseToken: 'tok' })

  it('refreshes the catalogue on every launch, cache-permitting, without force-updating', async () => {
    const opts = base()
    await openProfile({ ...opts })
    // Kernels published after this SDK was built are only resolvable via the
    // manifest, so the default path refreshes too (TTL-cached inside refresh).
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(refreshSpy.mock.calls[0]).toEqual([opts.cacheDir, { force: undefined }])
    expect(kernelUpdateStatusSpy).not.toHaveBeenCalled()
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1)
    expect(ensureKernelSpy.mock.calls[0][3]).toBeUndefined() // no { force }
    expect(launchKernelSpy).toHaveBeenCalledTimes(1)
  })

  it('force-updates before launching when the flag is on and an update exists', async () => {
    kernelUpdateStatusSpy.mockReturnValue({ version: '150.0.0.0', updateAvailable: true })
    const opts = base()
    await openProfile({ ...opts, updateKernelBeforeLaunch: true })
    // Acting on the published build must not read a stale cached manifest.
    expect(refreshSpy.mock.calls[0]).toEqual([opts.cacheDir, { force: true }])
    // two ensureKernel calls: the forced update first, then the normal ensure
    expect(ensureKernelSpy).toHaveBeenCalledTimes(2)
    expect(ensureKernelSpy.mock.calls[0][3]).toEqual({ force: true })
    expect(ensureKernelSpy.mock.calls[1][3]).toBeUndefined()
    expect(launchKernelSpy).toHaveBeenCalledTimes(1)
  })

  it('checks but does not force-update when the flag is on and no update exists', async () => {
    kernelUpdateStatusSpy.mockReturnValue({ version: '150.0.0.0', updateAvailable: false })
    await openProfile({ ...base(), updateKernelBeforeLaunch: true })
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1) // only the normal ensure
    expect(ensureKernelSpy.mock.calls[0][3]).toBeUndefined()
  })

  it('still launches with the installed kernel when the refresh reports nothing new (offline)', async () => {
    // refreshKernelVersions swallows network failure by contract; a launch must
    // proceed on the compiled-in baseline + whatever was cached on disk.
    const session = await openProfile({ ...base(), updateKernelBeforeLaunch: true })
    expect(launchKernelSpy).toHaveBeenCalledTimes(1)
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1) // no force update, launch proceeds
    expect(session).toBeTruthy()
  })
})

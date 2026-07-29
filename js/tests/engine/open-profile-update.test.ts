import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Exercise openProfile's updateKernelBeforeLaunch wiring in isolation: mock the
// kernel downloader + launcher + persona so we can assert exactly when the
// manifest is fetched and when a force-update runs, without touching the network,
// a real kernel, or a real browser.

const ensureKernelSpy = vi.fn(async () => 'C:/kernels/chrome.exe')
const fetchRemoteSpy = vi.fn(async () => [] as unknown[])
const registerSpy = vi.fn()
const kernelUpdateStatusSpy = vi.fn((): Record<string, unknown> | null => null)

vi.mock('../../src/engine/downloader', () => ({
  DEFAULT_KERNEL_VERSION: { version: '150.0.7871.182', label: 'Chrome 150', platforms: {} },
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: (...a: unknown[]) => ensureKernelSpy(...(a as [])),
  fetchRemoteKernelVersions: (...a: unknown[]) => fetchRemoteSpy(...(a as [])),
  registerKernelVersions: (...a: unknown[]) => registerSpy(...(a as [])),
  kernelUpdateStatus: (...a: unknown[]) => kernelUpdateStatusSpy(...(a as [])),
}))

vi.mock('../../src/engine/persona', () => ({
  loadOrGeneratePersona: () => ({ kernelVersion: '150.0.7871.182', chromeMajor: 150, timezone: 'UTC', languages: ['en-US'] }),
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
  fetchRemoteSpy.mockClear()
  fetchRemoteSpy.mockResolvedValue([])
  registerSpy.mockClear()
  kernelUpdateStatusSpy.mockReset()
  kernelUpdateStatusSpy.mockReturnValue(null)
  launchKernelSpy.mockClear()
})

describe('openProfile updateKernelBeforeLaunch', () => {
  const base = () => ({ cacheDir: tmp(), profileName: 'p', licenseToken: 'tok' })

  it('does not touch the manifest or force-update when the flag is off (default)', async () => {
    await openProfile({ ...base() })
    expect(fetchRemoteSpy).not.toHaveBeenCalled()
    expect(kernelUpdateStatusSpy).not.toHaveBeenCalled()
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1)
    expect(ensureKernelSpy.mock.calls[0][3]).toBeUndefined() // no { force }
    expect(launchKernelSpy).toHaveBeenCalledTimes(1)
  })

  it('force-updates before launching when the flag is on and an update exists', async () => {
    kernelUpdateStatusSpy.mockReturnValue({ version: '150.0.7871.182', updateAvailable: true })
    await openProfile({ ...base(), updateKernelBeforeLaunch: true })
    expect(fetchRemoteSpy).toHaveBeenCalledTimes(1)
    expect(registerSpy).toHaveBeenCalledTimes(1)
    // two ensureKernel calls: the forced update first, then the normal ensure
    expect(ensureKernelSpy).toHaveBeenCalledTimes(2)
    expect(ensureKernelSpy.mock.calls[0][3]).toEqual({ force: true })
    expect(ensureKernelSpy.mock.calls[1][3]).toBeUndefined()
    expect(launchKernelSpy).toHaveBeenCalledTimes(1)
  })

  it('checks but does not force-update when the flag is on and no update exists', async () => {
    kernelUpdateStatusSpy.mockReturnValue({ version: '150.0.7871.182', updateAvailable: false })
    await openProfile({ ...base(), updateKernelBeforeLaunch: true })
    expect(fetchRemoteSpy).toHaveBeenCalledTimes(1)
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1) // only the normal ensure
    expect(ensureKernelSpy.mock.calls[0][3]).toBeUndefined()
  })

  it('still launches with the installed kernel when the manifest fetch fails (offline)', async () => {
    fetchRemoteSpy.mockRejectedValue(new Error('offline'))
    const session = await openProfile({ ...base(), updateKernelBeforeLaunch: true })
    expect(launchKernelSpy).toHaveBeenCalledTimes(1)
    expect(ensureKernelSpy).toHaveBeenCalledTimes(1) // no force update, launch proceeds
    expect(session).toBeTruthy()
  })
})

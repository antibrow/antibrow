import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `timeoutMs` has to cover preparation, not just the kernel spawn: everything
// that can wedge a launch - license, archive probe, proxy geo - runs before it.

vi.mock('../../src/engine/geoip', () => ({
  lookupProxyGeo: async () => null,
  lookupDirectGeo: async () => null,
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))

const ensureSpy = vi.fn(async () => '/kernels/chrome')
const refreshSpy = vi.fn(async () => undefined)
vi.mock('../../src/engine/downloader', () => ({
  defaultKernelVersion: () => ({ version: '152.0.0.0', label: 'Chrome 152', platforms: {} }),
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: () => ensureSpy(),
  refreshKernelVersions: () => refreshSpy(),
  kernelUpdateStatus: () => null,
  installedKernelBuild: () => undefined,
  kernelReadsAppLocaleFromConfig: () => false,
}))

vi.mock('../../src/engine/persona', () => ({
  readPersona: () => undefined,
  loadOrGeneratePersona: () => ({
    kernelVersion: '152.0.0.0',
    chromeMajor: 152,
    timezone: 'UTC',
    languages: ['en-US'],
  }),
}))

const licenseSpy = vi.fn(async () => ({ token: 'T.S', mi: 5, sync: false }))
vi.mock('../../src/engine/license', () => ({ getLicenseToken: () => licenseSpy() }))

const launchArgs: Array<Record<string, unknown>> = []
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: async (o: Record<string, unknown>) => (launchArgs.push(o), {
    context: { pages: () => [], newPage: vi.fn() },
    profileDir: '',
    pid: 4242,
    onExit: () => {},
    close: vi.fn(async () => undefined),
  }),
}))

const { openProfile } = await import('../../src/engine/index')
const { LaunchTimeoutError } = await import('../../src/engine/deadline')

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-'))
}

describe('the launch budget covers preparation', () => {
  it('stops once preparation has spent it, before starting a kernel', async () => {
    // Time burnt inside preparation used to be free: `timeout` covered only the
    // spawn, so a launch could sit here indefinitely and still "not time out".
    refreshSpy.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 80))
    })
    licenseSpy.mockClear()

    await expect(
      openProfile({ profileName: 'demo', cacheDir: tmp(), timeoutMs: 40 }),
    ).rejects.toBeInstanceOf(LaunchTimeoutError)
    expect(licenseSpy).not.toHaveBeenCalled()
  })

  it('names the step it ran out on', async () => {
    refreshSpy.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 80))
    })

    await expect(
      openProfile({ profileName: 'demo', cacheDir: tmp(), timeoutMs: 40 }),
    ).rejects.toThrow(/installing the browser kernel/)
  })

  it('treats a non-positive budget as no limit, the way the Python SDK does', async () => {
    const session = await openProfile({ profileName: 'demo', cacheDir: tmp(), timeoutMs: 0 })

    expect(session.pid).toBe(4242)
  })

  it('does not charge the kernel install to the budget', async () => {
    // A first install is ~1GB; a launch must not fail just because it happened.
    ensureSpy.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 120))
      return '/kernels/chrome'
    })

    const session = await openProfile({ profileName: 'demo', cacheDir: tmp(), timeoutMs: 100 })

    expect(session.pid).toBe(4242)
  })
})


describe('what is left of the budget bounds the CDP wait', () => {
  it('never waits longer for CDP than the launch has left', async () => {
    launchArgs.length = 0
    refreshSpy.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })

    await openProfile({ profileName: 'demo', cacheDir: tmp(), timeoutMs: 5_000 })

    const waited = launchArgs.at(-1)?.cdpTimeoutMs as number
    expect(waited).toBeGreaterThan(0)
    expect(waited).toBeLessThan(5_000)
  })
})

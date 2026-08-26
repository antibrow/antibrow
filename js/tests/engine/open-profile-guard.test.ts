import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A launched kernel has to be reachable two ways: by this process's exit hooks,
// and by the NEXT process's reaper. Everything below the wiring is mocked.

vi.mock('../../src/engine/geoip', () => ({
  lookupProxyGeo: async () => null,
  lookupDirectGeo: async () => null,
  probeProxyExit: async () => ({ ok: false, latencyMs: 0 }),
}))

vi.mock('../../src/engine/downloader', () => ({
  defaultKernelVersion: () => ({ version: '152.0.0.0', label: 'Chrome 152', platforms: {} }),
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: async () => '/kernels/chrome',
  refreshKernelVersions: async () => undefined,
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

vi.mock('../../src/engine/license', () => ({
  getLicenseToken: async () => ({ token: 'T.S', mi: 5, sync: false }),
}))

const exits: Array<() => void> = []
const closeSpy = vi.fn(async () => undefined)
const kernelOpts: Array<Record<string, unknown>> = []
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: async (o: Record<string, unknown>) => (kernelOpts.push(o), {
    context: { pages: () => [], newPage: vi.fn() },
    profileDir: '',
    pid: 4242,
    onExit: (cb: () => void) => { exits.push(cb) },
    close: closeSpy,
  }),
}))

const { openProfile } = await import('../../src/engine/index')
const { registryPath } = await import('../../src/engine/reaper')

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'))
}

function rows(dir: string): Array<{ kernelPid: number; profileDir: string }> {
  try {
    return JSON.parse(fs.readFileSync(registryPath(dir), 'utf8'))
  } catch {
    return []
  }
}

beforeEach(() => {
  exits.length = 0
  closeSpy.mockClear()
})

describe('openProfile registers the kernel it started', () => {
  it('writes a row the next run can reap', async () => {
    const cacheDir = tmp()
    const session = await openProfile({ profileName: 'demo', cacheDir })

    expect(rows(cacheDir).map((r) => r.kernelPid)).toEqual([4242])
    expect(rows(cacheDir)[0].profileDir).toBe(session.profileDir || rows(cacheDir)[0].profileDir)
  })

  it('takes the row back out when the browser exits', async () => {
    const cacheDir = tmp()
    await openProfile({ profileName: 'demo', cacheDir })

    for (const cb of exits) cb()

    expect(rows(cacheDir)).toEqual([])
  })

  it('leaves a detached session for its owner to manage', async () => {
    // The MCP server keeps kernels alive across calls on purpose.
    const cacheDir = tmp()
    await openProfile({ profileName: 'demo', cacheDir, detached: true })

    expect(rows(cacheDir)).toEqual([])
  })

  it('sweeps up what the last run leaked before starting another kernel', async () => {
    const cacheDir = tmp()
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(
      registryPath(cacheDir),
      JSON.stringify([{ kernelPid: 999999, ownerPid: 999998, profileDir: '/gone' }]),
    )

    await openProfile({ profileName: 'demo', cacheDir })

    expect(rows(cacheDir).map((r) => r.kernelPid)).toEqual([4242])
  })
})

describe('openProfile forwards extra switches to the kernel', () => {
  it('passes them through as extraArgs', async () => {
    kernelOpts.length = 0
    await openProfile({ profileName: 'demo', cacheDir: tmp(), args: ['--mute-audio'] })

    expect(kernelOpts.at(-1)?.extraArgs).toEqual(['--mute-audio'])
  })
})

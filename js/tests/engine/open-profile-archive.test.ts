import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The post-exit archive save, in isolation: mock the kernel + persona + the
// profile-cache I/O so we can assert WHEN the presigned upload URL is resolved.
// A presign lives 15 minutes server-side, so one captured at launch is dead by
// the time a real session ends.

const uploadSpy = vi.fn(async (_dir: string, _url: string) => undefined)

vi.mock('../../src/engine/downloader', () => ({
  DEFAULT_KERNEL_VERSION: { version: '150.0.7871.182', label: 'Chrome 150', platforms: {} },
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: async () => 'C:/kernels/chrome.exe',
  refreshKernelVersions: async () => undefined,
  kernelUpdateStatus: () => null,
}))

vi.mock('../../src/engine/persona', () => ({
  loadOrGeneratePersona: () => ({ kernelVersion: '150.0.7871.182', chromeMajor: 150, timezone: 'UTC', languages: ['en-US'] }),
}))

vi.mock('../../src/engine/profile-cache', () => ({
  downloadProfileCache: async () => undefined,
  uploadProfileCache: (...a: [string, string]) => uploadSpy(...a),
  packProfileCache: () => Buffer.alloc(0),
  unpackProfileCache: () => {},
  exportProfileArchive: () => Buffer.alloc(0),
  importProfileArchive: () => ({}),
  PROFILE_ARCHIVE_EXT: 'fpprofile',
}))

/** Kernel session stand-in that lets the test fire the browser-exit event. */
const exits: Array<() => void> = []
vi.mock('../../src/engine/launcher', () => ({
  launchKernel: async () => ({
    context: { pages: () => [], newPage: vi.fn() },
    profileDir: '',
    onExit: (cb: () => void) => { exits.push(cb) },
    close: vi.fn(async () => undefined),
  }),
}))

import { openProfile } from '../../src/engine/index'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opa-'))
const base = () => ({ cacheDir: tmp(), profileName: 'p', licenseToken: 'tok' })
/** Fire the browser-exit event and let the upload promise settle. */
const exit = async () => {
  for (const cb of exits.splice(0)) cb()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  uploadSpy.mockClear()
  uploadSpy.mockResolvedValue(undefined)
  exits.length = 0
})

describe('openProfile archive upload', () => {
  it('signs the upload URL after the browser exits, not at launch', async () => {
    const getArchivePutUrl = vi.fn(async () => 'https://r2/put-fresh.zip')

    const session = await openProfile({ ...base(), getArchivePutUrl })

    expect(getArchivePutUrl).not.toHaveBeenCalled()   // nothing signed yet
    await exit()
    await session.archiveUpload

    expect(getArchivePutUrl).toHaveBeenCalledTimes(1)
    expect(uploadSpy).toHaveBeenCalledWith(expect.any(String), 'https://r2/put-fresh.zip')
  })

  it('re-signs and retries once when the upload is rejected as expired', async () => {
    const urls = ['https://r2/put-1.zip', 'https://r2/put-2.zip']
    const getArchivePutUrl = vi.fn(async () => urls.shift())
    uploadSpy.mockRejectedValueOnce(new Error('Failed to upload profile cache: HTTP 403'))
    const events: string[] = []

    const session = await openProfile({
      ...base(),
      getArchivePutUrl,
      onArchiveSync: (e) => events.push(`${e.phase}:${e.state}`),
    })
    await exit()
    await session.archiveUpload

    expect(uploadSpy.mock.calls.map((c) => c[1])).toEqual(['https://r2/put-1.zip', 'https://r2/put-2.zip'])
    expect(events).toEqual(['upload:start', 'upload:done'])
  })

  it('reports the failure when the retry fails too', async () => {
    uploadSpy.mockRejectedValue(new Error('Failed to upload profile cache: HTTP 403'))
    const events: Array<{ phase: string; state: string; error?: string }> = []

    const session = await openProfile({
      ...base(),
      getArchivePutUrl: async () => 'https://r2/put.zip',
      onArchiveSync: (e) => events.push({ phase: e.phase, state: e.state, error: e.error }),
    })
    await exit()
    await session.archiveUpload

    expect(events.at(-1)).toEqual({ phase: 'upload', state: 'error', error: 'Failed to upload profile cache: HTTP 403' })
  })

  it('falls back to a launch-time URL when no resolver is given', async () => {
    const session = await openProfile({ ...base(), archivePutUrl: 'https://r2/legacy.zip' })
    await exit()
    await session.archiveUpload

    expect(uploadSpy).toHaveBeenCalledWith(expect.any(String), 'https://r2/legacy.zip')
  })

  it('registers no exit hook for a profile with no cloud archive', async () => {
    const session = await openProfile({ ...base() })
    await exit()

    expect(session.archiveUpload).toBeUndefined()
    expect(uploadSpy).not.toHaveBeenCalled()
  })
})

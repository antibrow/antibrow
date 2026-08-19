import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The post-exit archive save, in isolation: mock the kernel + persona + the
// profile-cache I/O so we can assert WHEN the presigned upload URL is resolved.
// A presign lives 15 minutes server-side, so one captured at launch is dead by
// the time a real session ends.

const uploadSpy = vi.fn(async (_dir: string, _url: string) => undefined as string | undefined)
const downloadSpy = vi.fn(async (_url: string, _dir: string) => true)

vi.mock('../../src/engine/downloader', () => ({
  defaultKernelVersion: () => ({ version: '150.0.0.0', label: 'Chrome 150', platforms: {} }),
  KERNEL_VERSIONS: [],
  findKernelVersion: (v: string) => ({ version: v, label: `Chrome ${v}`, platforms: {} }),
  ensureKernel: async () => 'C:/kernels/chrome.exe',
  refreshKernelVersions: async () => undefined,
  kernelUpdateStatus: () => null,
  installedKernelBuild: () => undefined,
  kernelReadsAppLocaleFromConfig: () => false,
}))

vi.mock('../../src/engine/persona', () => ({
  // No persona on disk: these tests are about the archive/directory paths, not
  // about moving an existing profile to another kernel.
  readPersona: () => undefined,
  loadOrGeneratePersona: () => ({ kernelVersion: '150.0.0.0', chromeMajor: 150, timezone: 'UTC', languages: ['en-US'] }),
}))

// Only the network-shaped functions are stubbed; readArchiveVersion / writeArchiveVersion /
// clearArchiveVersion come from the real module so the marker tests exercise real disk state.
vi.mock('../../src/engine/profile-cache', async () => {
  const actual = await vi.importActual<typeof import('../../src/engine/profile-cache')>('../../src/engine/profile-cache')
  return {
    ...actual,
    downloadProfileCache: (...a: [string, string]) => downloadSpy(...a),
    uploadProfileCache: (...a: [string, string]) => uploadSpy(...a),
  }
})

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
import { readArchiveVersion, writeArchiveVersion } from '../../src/engine/profile-cache'

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
  downloadSpy.mockClear()
  downloadSpy.mockResolvedValue(true)
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

describe('openProfile archive generation gate', () => {
  it('downloads when this machine has no marker yet', async () => {
    const profileDir = tmp()

    await openProfile({ ...base(), profileDir, archiveGetUrl: 'https://r2/get.zip', archiveVersion: 'etag-1' })

    expect(downloadSpy).toHaveBeenCalledTimes(1)
    expect(readArchiveVersion(profileDir)).toBe('etag-1')
  })

  it('skips the download entirely when the marker already matches the cloud version', async () => {
    // The scenario that matters: the last upload failed, so the cloud still holds
    // the generation this machine already has. Downloading it would erase newer
    // local work that never made it up.
    const profileDir = tmp()
    writeArchiveVersion(profileDir, 'etag-1')
    const events: string[] = []

    await openProfile({
      ...base(),
      profileDir,
      archiveGetUrl: 'https://r2/get.zip',
      archiveVersion: 'etag-1',
      onArchiveSync: (e) => events.push(`${e.phase}:${e.state}`),
    })

    expect(downloadSpy).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(readArchiveVersion(profileDir)).toBe('etag-1')
  })

  it('downloads when the marker names a different generation', async () => {
    const profileDir = tmp()
    writeArchiveVersion(profileDir, 'etag-old')

    await openProfile({ ...base(), profileDir, archiveGetUrl: 'https://r2/get.zip', archiveVersion: 'etag-new' })

    expect(downloadSpy).toHaveBeenCalledTimes(1)
    expect(readArchiveVersion(profileDir)).toBe('etag-new')
  })

  it('downloads when the server reported no version at all', async () => {
    // An older server predates archive generations; the client must keep
    // restoring unconditionally rather than treating the missing field as an error.
    const profileDir = tmp()
    writeArchiveVersion(profileDir, 'etag-old')

    await openProfile({ ...base(), profileDir, archiveGetUrl: 'https://r2/get.zip' })

    expect(downloadSpy).toHaveBeenCalledTimes(1)
    // No reported version means nothing to record; the stale marker is left as-is.
    expect(readArchiveVersion(profileDir)).toBe('etag-old')
  })

  it('records the generation it just uploaded', async () => {
    const profileDir = tmp()
    uploadSpy.mockResolvedValueOnce('etag-9')

    const session = await openProfile({ ...base(), profileDir, getArchivePutUrl: async () => 'https://r2/put.zip' })
    await exit()
    await session.archiveUpload

    expect(readArchiveVersion(profileDir)).toBe('etag-9')
  })

  it('drops the marker when the upload response named no generation', async () => {
    const profileDir = tmp()
    writeArchiveVersion(profileDir, 'etag-old')
    uploadSpy.mockResolvedValueOnce(undefined)

    const session = await openProfile({ ...base(), profileDir, getArchivePutUrl: async () => 'https://r2/put.zip' })
    await exit()
    await session.archiveUpload

    expect(readArchiveVersion(profileDir)).toBeUndefined()
  })
})

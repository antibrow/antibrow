import { describe, it, expect, vi, beforeEach } from 'vitest'

const uploadSpy = vi.fn(async () => undefined)
const downloadSpy = vi.fn(async () => null as unknown)

vi.mock('../src/api', () => ({
  uploadProfileState: (...a: unknown[]) => uploadSpy(...a),
  downloadProfileState: (...a: unknown[]) => downloadSpy(...a),
}))

import { captureState, captureAndUploadState, restoreState, restoreSavedState } from '../src/profile-state'

function fakeContext(over: Record<string, unknown> = {}) {
  return {
    storageState: vi.fn(async () => ({
      cookies: [{ name: 'sid', value: '1', domain: 'x.com', path: '/' }],
      origins: [{ origin: 'https://x.com', localStorage: [{ name: 'k', value: 'v' }] }],
    })),
    pages: () => [
      { url: () => 'https://x.com/a' },
      { url: () => 'about:blank' },
      { url: () => 'chrome://newtab' },
    ],
    addCookies: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    newPage: vi.fn(async () => ({ goto: vi.fn(async () => undefined) })),
    ...over,
  }
}

beforeEach(() => {
  uploadSpy.mockClear()
  downloadSpy.mockClear()
})

describe('captureState', () => {
  it('returns cookies + origins and filters non-real tab URLs', async () => {
    const ctx = fakeContext()
    const snap = await captureState(ctx as never)
    expect(snap.cookies).toHaveLength(1)
    expect(snap.origins).toHaveLength(1)
    expect(snap.tabs).toEqual(['https://x.com/a']) // about:blank + chrome:// dropped
  })
})

describe('captureAndUploadState', () => {
  it('uploads the captured snapshot with key/server/name', async () => {
    const ctx = fakeContext()
    await captureAndUploadState(ctx as never, { key: 'k', server: 's', name: 'p' })
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const arg = uploadSpy.mock.calls[0][0] as Record<string, unknown>
    expect(arg.key).toBe('k')
    expect(arg.name).toBe('p')
    expect((arg.cookies as unknown[])).toHaveLength(1)
    expect((arg.tabs as unknown[])).toEqual(['https://x.com/a'])
  })
})

describe('restoreState', () => {
  it('adds cookies and injects localStorage, opens tabs only when asked', async () => {
    const ctx = fakeContext()
    const page = { goto: vi.fn(async () => undefined) }
    const saved = {
      cookies: [{ name: 'sid', value: '1' }],
      origins: [{ origin: 'https://x.com', localStorage: [{ name: 'k', value: 'v' }] }],
      tabs: ['https://x.com/a', 'https://x.com/b'],
      permissions: null,
      serviceWorkers: null,
    }
    await restoreState(ctx as never, page as never, saved as never, { openTabs: true })
    expect(ctx.addCookies).toHaveBeenCalled()
    expect(ctx.addInitScript).toHaveBeenCalled()
    expect(page.goto).toHaveBeenCalledWith('https://x.com/a')
    expect(ctx.newPage).toHaveBeenCalledTimes(1) // second tab
  })

  it('does not open tabs when openTabs is false', async () => {
    const ctx = fakeContext()
    const page = { goto: vi.fn(async () => undefined) }
    const saved = { cookies: [], origins: [], tabs: ['https://x.com/a'], permissions: null, serviceWorkers: null }
    await restoreState(ctx as never, page as never, saved as never, { openTabs: false })
    expect(page.goto).not.toHaveBeenCalled()
  })
})

describe('restoreSavedState', () => {
  it('does nothing when no saved state exists', async () => {
    downloadSpy.mockResolvedValueOnce(null)
    const ctx = fakeContext()
    const page = { goto: vi.fn(async () => undefined) }
    await restoreSavedState(ctx as never, page as never, { key: 'k', name: 'p' })
    expect(ctx.addCookies).not.toHaveBeenCalled()
  })

  it('restores when a snapshot is returned', async () => {
    downloadSpy.mockResolvedValueOnce({ cookies: [{ name: 'a', value: 'b' }], origins: [], tabs: [], permissions: null, serviceWorkers: null })
    const ctx = fakeContext()
    const page = { goto: vi.fn(async () => undefined) }
    await restoreSavedState(ctx as never, page as never, { key: 'k', name: 'p' })
    expect(ctx.addCookies).toHaveBeenCalled()
  })
})

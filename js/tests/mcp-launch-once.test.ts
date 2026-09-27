import { describe, it, expect, vi } from 'vitest'
import { launchOnce, launchProgress } from '../src/mcp'
import type { McpSession } from '../src/types'

function fakeSession(id: string, launchKey: string, connected = true): McpSession {
  return {
    id,
    browser: { close: vi.fn(async () => {}) },
    context: { browser: () => ({ isConnected: () => connected }) },
    page: {},
    profileDir: `/tmp/${id}`,
    profileName: id,
    launchKey,
    createdAt: new Date(0),
  } as unknown as McpSession
}

describe('launchOnce', () => {
  // The client gives up on a slow first launch (kernel download) and retries
  // while the first call is still running. A second browser on the same profile
  // would fight the first for its directory and the only concurrency slot.
  it('joins a launch of the same profile that is still in flight', async () => {
    const sessions = new Map<string, McpSession>()
    const inFlight = new Map<string, Promise<McpSession>>()
    let release!: (s: McpSession) => void
    const start = vi.fn(() => new Promise<McpSession>((r) => { release = r }))

    const first = launchOnce(sessions, inFlight, 'managed:a', start)
    const retry = launchOnce(sessions, inFlight, 'managed:a', start)
    release(fakeSession('session_1', 'managed:a'))

    expect((await first).reused).toBe(false)
    const joined = await retry
    expect(joined.reused).toBe(true)
    expect(joined.session.id).toBe('session_1')
    expect(start).toHaveBeenCalledOnce()
    expect(sessions.size).toBe(1)
    expect(inFlight.size).toBe(0)
  })

  it('returns the running session instead of launching the profile again', async () => {
    const sessions = new Map([['session_1', fakeSession('session_1', 'managed:a')]])
    const start = vi.fn()
    const got = await launchOnce(sessions, new Map(), 'managed:a', start)
    expect(got).toMatchObject({ reused: true, session: { id: 'session_1' } })
    expect(start).not.toHaveBeenCalled()
  })

  it('launches afresh when the previous browser was closed by hand', async () => {
    const sessions = new Map([['session_1', fakeSession('session_1', 'managed:a', false)]])
    const got = await launchOnce(sessions, new Map(), 'managed:a', async () => fakeSession('session_2', 'managed:a'))
    expect(got.reused).toBe(false)
    expect([...sessions.keys()]).toEqual(['session_2'])
  })

  it('keeps the temporary and managed trees apart', async () => {
    const sessions = new Map([['session_1', fakeSession('session_1', 'managed:a')]])
    const got = await launchOnce(sessions, new Map(), 'temporary:a', async () => fakeSession('session_2', 'temporary:a'))
    expect(got.reused).toBe(false)
  })

  it('lets a retry launch again after a failed launch', async () => {
    const sessions = new Map<string, McpSession>()
    const inFlight = new Map<string, Promise<McpSession>>()
    await expect(launchOnce(sessions, inFlight, 'managed:a', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(inFlight.size).toBe(0)
    const got = await launchOnce(sessions, inFlight, 'managed:a', async () => fakeSession('session_2', 'managed:a'))
    expect(got.reused).toBe(false)
  })
})

describe('launchProgress', () => {
  it('sends progress notifications when the client supplied a token', () => {
    const sendNotification = vi.fn(async () => {})
    const log = vi.fn()
    const report = launchProgress({ _meta: { progressToken: 't1' }, sendNotification }, log)
    report('Downloading kernel 150 (win64)')
    report('Extracting kernel')
    expect(sendNotification).toHaveBeenCalledTimes(2)
    expect(sendNotification.mock.calls[1]).toEqual([{
      method: 'notifications/progress',
      params: { progressToken: 't1', progress: 2, message: 'Extracting kernel' },
    }])
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('only logs when the client asked for no progress', () => {
    const sendNotification = vi.fn(async () => {})
    const log = vi.fn()
    launchProgress({ sendNotification }, log)('Loading persona')
    expect(sendNotification).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('Loading persona')
  })

  it('throttles download percentages to one a second', () => {
    let t = 0
    const log = vi.fn()
    const report = launchProgress(undefined, log, () => t)
    report('Downloading 1%')
    t = 200; report('Downloading 2%')
    t = 1100; report('Downloading 3%')
    t = 1150; report('Extracting kernel')
    expect(log.mock.calls.map((c) => c[0])).toEqual(['Downloading 1%', 'Downloading 3%', 'Extracting kernel'])
  })
})

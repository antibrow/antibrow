import { describe, it, expect, vi } from 'vitest'
import { closeMcpSession, closeAllMcpSessions } from '../src/mcp'
import type { McpSession } from '../src/types'

function fakeSession(id: string, overrides: Partial<McpSession> = {}): McpSession {
  return {
    id,
    browser: { close: vi.fn(async () => {}) },
    context: { close: vi.fn(async () => {}) },
    page: {},
    profileDir: `/tmp/${id}`,
    profileName: id,
    createdAt: new Date(0),
    ...overrides,
  } as unknown as McpSession
}

describe('closeMcpSession', () => {
  // Dropping the CDP connection leaves the kernel running: it keeps the
  // profile's singleton lock, so the next launch of that profile exits with
  // "Opening in existing browser session" before CDP is ready, and it holds a
  // machine-wide concurrency slot that a mi=1 license never gets back.
  it('ends the kernel process, not just the CDP connection', async () => {
    const session = fakeSession('a')
    await closeMcpSession(session, async () => {})
    expect(session.browser.close).toHaveBeenCalledOnce()
    expect(session.context.close).not.toHaveBeenCalled()
  })

  it('stops a live view and unregisters it before closing the kernel', async () => {
    const order: string[] = []
    const stream = { stop: vi.fn(async () => { order.push('stop') }) }
    const session = fakeSession('a', {
      liveViewStream: stream as unknown as McpSession['liveViewStream'],
      browser: { close: vi.fn(async () => { order.push('close') }) },
    })
    await closeMcpSession(session, async () => { order.push('unregister') })
    expect(order).toEqual(['stop', 'unregister', 'close'])
  })

  it('still closes the kernel when live view teardown fails', async () => {
    const session = fakeSession('a', {
      liveViewStream: { stop: async () => { throw new Error('relay gone') } } as unknown as McpSession['liveViewStream'],
    })
    await closeMcpSession(session, async () => { throw new Error('offline') })
    expect(session.browser.close).toHaveBeenCalledOnce()
  })
})

describe('closeAllMcpSessions', () => {
  it('closes every session and empties the map', async () => {
    const sessions = new Map<string, McpSession>([
      ['session_1', fakeSession('session_1')],
      ['session_2', fakeSession('session_2')],
    ])
    const handles = [...sessions.values()]
    await closeAllMcpSessions(sessions, async () => {})
    for (const s of handles) expect(s.browser.close).toHaveBeenCalledOnce()
    expect(sessions.size).toBe(0)
  })

  // Shutdown runs on SIGTERM: one wedged kernel must not keep the others alive.
  it('does not let one failing session block the rest', async () => {
    const good = fakeSession('session_2')
    const sessions = new Map<string, McpSession>([
      ['session_1', fakeSession('session_1', { browser: { close: async () => { throw new Error('wedged') } } })],
      ['session_2', good],
    ])
    await closeAllMcpSessions(sessions, async () => {})
    expect(good.browser.close).toHaveBeenCalledOnce()
    expect(sessions.size).toBe(0)
  })
})

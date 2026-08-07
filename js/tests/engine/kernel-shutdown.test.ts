import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { exitLatch, shutdownKernel } from '../../src/engine/launcher'

describe('exitLatch', () => {
  it('replays an exit that happened before the subscriber arrived', async () => {
    const child = new EventEmitter()
    const latch = exitLatch(child)

    child.emit('exit', 0, null)
    expect(latch.hasExited()).toBe(true)

    const late = vi.fn()
    latch.onExit(late)
    // The whole point: a bare child.once('exit') here would never fire, leaving
    // the session marked running and its archive never uploaded.
    await Promise.resolve()
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers registered before the exit', async () => {
    const child = new EventEmitter()
    const latch = exitLatch(child)

    const early = vi.fn()
    latch.onExit(early)
    expect(latch.hasExited()).toBe(false)
    expect(early).not.toHaveBeenCalled()

    child.emit('exit', 0, null)
    expect(early).toHaveBeenCalledTimes(1)
    expect(latch.hasExited()).toBe(true)
  })

  it('notifies every subscriber exactly once', async () => {
    const child = new EventEmitter()
    const latch = exitLatch(child)
    const a = vi.fn()
    const b = vi.fn()
    latch.onExit(a)
    latch.onExit(b)

    child.emit('exit', 0, null)
    child.emit('exit', 0, null)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})

describe('shutdownKernel', () => {
  it('lets the browser exit on its own and never kills it', async () => {
    let exited = false
    const kill = vi.fn()
    const outcome = await shutdownKernel({
      requestClose: async () => { setTimeout(() => { exited = true }, 20) },
      hasExited: () => exited,
      kill,
      graceMs: 2000,
      pollMs: 5,
    })
    expect(outcome).toBe('graceful')
    expect(kill).not.toHaveBeenCalled()
  })

  it('kills once the grace period runs out', async () => {
    const kill = vi.fn()
    const outcome = await shutdownKernel({
      requestClose: async () => {},
      hasExited: () => false,
      kill,
      graceMs: 30,
      pollMs: 5,
    })
    expect(outcome).toBe('killed')
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('still waits when the close request itself fails', async () => {
    let exited = false
    const kill = vi.fn()
    const outcome = await shutdownKernel({
      // Browser.close routinely rejects: the connection drops as the browser goes.
      requestClose: async () => { setTimeout(() => { exited = true }, 20); throw new Error('disconnected') },
      hasExited: () => exited,
      kill,
      graceMs: 2000,
      pollMs: 5,
    })
    expect(outcome).toBe('graceful')
    expect(kill).not.toHaveBeenCalled()
  })

  it('still returns and kills within the grace period when requestClose never settles', async () => {
    const kill = vi.fn()
    const start = Date.now()
    // A browser wedged mid-shutdown can leave its CDP websocket open, so
    // Browser.close never acks. The old code awaited requestClose before
    // starting the deadline, so this would hang forever.
    const outcome = await shutdownKernel({
      requestClose: () => new Promise<void>(() => {}),
      hasExited: () => false,
      kill,
      graceMs: 30,
      pollMs: 5,
    })
    expect(outcome).toBe('killed')
    expect(kill).toHaveBeenCalledTimes(1)
    expect(Date.now() - start).toBeLessThan(500)
  })
})

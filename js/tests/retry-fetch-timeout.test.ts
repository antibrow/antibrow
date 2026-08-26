import { afterEach, describe, expect, it, vi } from 'vitest'

import { Deadline, withDeadline } from '../src/engine/deadline'
import { DEFAULT_REQUEST_TIMEOUT_MS, retryFetch } from '../src/retry-fetch'

/** Capture the signal each attempt was given, without touching the network. */
function record() {
  const seen: Array<AbortSignal | null | undefined> = []
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    seen.push(init?.signal)
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', spy)
  return { seen, spy }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('every API call is bounded', () => {
  it('carries an abort signal even with no launch in progress', async () => {
    const { seen } = record()

    await retryFetch('https://example.com/x')

    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })

  it('has a default timeout at all - a hung server used to hang forever', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('leaves a caller-provided signal alone', async () => {
    const { seen } = record()
    const mine = new AbortController().signal

    await retryFetch('https://example.com/x', { signal: mine })

    expect(seen[0]).toBe(mine)
  })

  it('gives up when the launch budget is already spent', async () => {
    const { spy } = record()
    const clock = (() => {
      const ticks = [0, 200_000, 200_000, 200_000]
      let i = 0
      return () => ticks[Math.min(i++, ticks.length - 1)]
    })()

    await expect(
      withDeadline(new Deadline(120_000, clock), () => retryFetch('https://example.com/x')),
    ).rejects.toThrow()

    expect(spy).not.toHaveBeenCalled()
  })
})

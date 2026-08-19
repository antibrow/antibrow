import { describe, it, expect, vi, afterEach } from 'vitest'
import { retryDelayMs, retryFetch, RETRY_MAX_ATTEMPTS } from '../src/retry-fetch'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers })
}

/** Runs `fn` with timers faked so the backoff sleeps resolve instantly. */
async function withoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  const promise = fn()
  // Each retry sleeps once; drain far past the longest possible backoff.
  for (let i = 0; i < RETRY_MAX_ATTEMPTS + 1; i++) await vi.advanceTimersByTimeAsync(200_000)
  return promise
}

describe('retryDelayMs', () => {
  it('waits out the window the server named', () => {
    const d = retryDelayMs(1, '17')
    expect(d).toBeGreaterThanOrEqual(17_000)
    expect(d).toBeLessThan(17_000 + 5_000)
  })

  it('never retries before Retry-After elapses', () => {
    // Jitter is added, never subtracted: coming back early just burns an attempt.
    for (let i = 0; i < 50; i++) expect(retryDelayMs(1, '60')).toBeGreaterThanOrEqual(60_000)
  })

  it('backs off exponentially when the server names no delay', () => {
    expect(retryDelayMs(1, null)).toBeLessThan(retryDelayMs(3, null))
  })

  it('spreads concurrent callers apart', () => {
    // Every lane on one account key gets the same Retry-After, so identical
    // delays would rebuild the same burst that caused the 429.
    const seen = new Set(Array.from({ length: 40 }, () => retryDelayMs(1, '5')))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('retryFetch', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(res(429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(res(200))
    vi.stubGlobal('fetch', fn)
    const r = await withoutWaiting(() => retryFetch('https://s/x', {}))
    expect(r.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries 5xx and transport failures', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200))
    vi.stubGlobal('fetch', fn)
    expect((await withoutWaiting(() => retryFetch('https://s/x', {}))).status).toBe(200)
  })

  it('does not retry a 4xx that will never change', async () => {
    const fn = vi.fn().mockResolvedValue(res(404))
    vi.stubGlobal('fetch', fn)
    expect((await retryFetch('https://s/x', {})).status).toBe(404)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up bounded and hands back the last 429', async () => {
    const fn = vi.fn().mockResolvedValue(res(429, { 'Retry-After': '1' }))
    vi.stubGlobal('fetch', fn)
    const r = await withoutWaiting(() => retryFetch('https://s/x', {}))
    expect(r.status).toBe(429)
    expect(fn).toHaveBeenCalledTimes(RETRY_MAX_ATTEMPTS)
  })

  it('stops early rather than sleeping past its budget', async () => {
    // A 429 naming a long window must not turn a launch into a ten-minute stall:
    // it gives up with fewer attempts instead of waiting the window out.
    const fn = vi.fn().mockResolvedValue(res(429, { 'Retry-After': '600' }))
    vi.stubGlobal('fetch', fn)
    const r = await withoutWaiting(() => retryFetch('https://s/x', {}))
    expect(r.status).toBe(429)
    expect(fn.mock.calls.length).toBeLessThan(RETRY_MAX_ATTEMPTS)
  })
})

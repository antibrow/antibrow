import { describe, expect, it, vi } from 'vitest'

import { StallTimeoutError, readAllWithStall } from '../../src/engine/stall'

/** Yields chunks with a real (tiny) gap between them. */
async function* dribble(chunks: string[], gapMs: number) {
  for (const chunk of chunks) {
    await new Promise((r) => setTimeout(r, gapMs))
    yield Buffer.from(chunk)
  }
}

async function* stalls(): AsyncGenerator<Buffer> {
  await new Promise(() => {}) // never yields, never ends
  yield Buffer.alloc(0)
}

describe('reading a transfer with a stall timeout', () => {
  it('returns the whole body when the bytes keep coming', async () => {
    const body = await readAllWithStall(dribble(['ab', 'cd', 'ef'], 5), 200)

    expect(body.toString()).toBe('abcdef')
  })

  it('survives a slow transfer as long as it keeps moving', async () => {
    // 6 gaps of 20ms is 120ms total - well past the 50ms stall window, which is
    // the point: the cap is on silence, not on how long a download may take.
    const body = await readAllWithStall(dribble(['a', 'b', 'c', 'd', 'e', 'f'], 20), 50)

    expect(body.toString()).toBe('abcdef')
  })

  it('gives up when nothing arrives at all', async () => {
    await expect(readAllWithStall(stalls(), 30)).rejects.toBeInstanceOf(StallTimeoutError)
  })

  it('gives up on a gap in the middle of a transfer', async () => {
    async function* half() {
      yield Buffer.from('ab')
      await new Promise((r) => setTimeout(r, 200))
      yield Buffer.from('cd')
    }

    await expect(readAllWithStall(half(), 30)).rejects.toBeInstanceOf(StallTimeoutError)
  })

  it('names how long the silence was allowed to last', () => {
    // Built directly: asserting the wording must not cost the test a real wait.
    expect(new StallTimeoutError(60_000).message).toMatch(/no data for 60s/)
  })

  it('reports progress as bytes land', async () => {
    const seen: number[] = []
    await readAllWithStall(dribble(['ab', 'cd'], 5), 200, (n) => seen.push(n))

    expect(seen).toEqual([2, 4])
  })
})

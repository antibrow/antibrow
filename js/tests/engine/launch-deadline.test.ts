import { describe, expect, it } from 'vitest'

import { Deadline, LaunchTimeoutError, remainingBudget, withDeadline } from '../../src/engine/deadline'

/** A clock the test drives, so no test ever waits on real time. */
function clock(...ticks: number[]) {
  let i = 0
  return () => ticks[Math.min(i++, ticks.length - 1)]
}

describe('the launch budget', () => {
  it('is unlimited when no total is given', () => {
    const d = new Deadline(undefined)

    expect(d.remaining()).toBe(Infinity)
    expect(d.budget(20_000)).toBe(20_000)
    expect(() => d.check('license')).not.toThrow()
  })

  it('caps a step by what is left', () => {
    const d = new Deadline(8_000, clock(0, 5_000))

    expect(d.budget(20_000)).toBe(3_000)
  })

  it('leaves a step alone when the budget is roomy', () => {
    const d = new Deadline(120_000, clock(0, 1_000))

    expect(d.budget(20_000)).toBe(20_000)
  })

  it('names the step it ran out on', () => {
    const d = new Deadline(120_000, clock(0, 130_000))

    let caught: unknown
    try {
      d.check('restoring the cloud archive')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LaunchTimeoutError)
    expect((caught as LaunchTimeoutError).step).toBe('restoring the cloud archive')
    expect(String(caught)).toContain('restoring the cloud archive')
  })

  it('remembers the current step for whoever times out next', () => {
    const d = new Deadline(120_000, clock(0, 0, 130_000))
    d.check('connecting to the proxy')

    expect(() => d.check()).toThrow(/connecting to the proxy/)
  })

  it('never hands out a zero timeout', () => {
    const d = new Deadline(120_000, clock(0, 130_000))

    expect(() => d.budget(20_000)).toThrow(LaunchTimeoutError)
  })
})

describe('a paused stretch', () => {
  it('does not spend the budget', async () => {
    // A first kernel install is legitimately gigabytes.
    const d = new Deadline(120_000, clock(0, 1_000, 601_000, 601_000, 602_000))

    await d.paused(async () => {})

    expect(() => d.check('connecting to CDP')).not.toThrow()
    expect(d.remaining()).toBe(118_000)
  })

  it('still counts what was spent before it', async () => {
    const d = new Deadline(120_000, clock(0, 100_000, 700_000, 700_000))

    await d.paused(async () => {})

    expect(d.remaining()).toBe(20_000)
  })

  it('resumes even when the step inside it throws', async () => {
    const d = new Deadline(120_000, clock(0, 1_000, 601_000, 601_000))

    await expect(d.paused(async () => { throw new Error('download failed') })).rejects.toThrow()

    expect(d.remaining()).toBe(119_000)
  })
})

describe('the ambient budget every HTTP call reads', () => {
  it('is absent outside a launch', () => {
    expect(remainingBudget(20_000)).toBe(20_000)
  })

  it('shortens a call inside a launch', async () => {
    const d = new Deadline(120_000, clock(0, 117_500))

    const seen = await withDeadline(d, async () => remainingBudget(20_000))

    expect(seen).toBe(2_500)
  })

  it('is dropped again on the way out', async () => {
    const d = new Deadline(120_000, clock(0, 119_000))
    await withDeadline(d, async () => undefined)

    expect(remainingBudget(20_000)).toBe(20_000)
  })

  it('reports an exhausted budget rather than a zero timeout', async () => {
    const d = new Deadline(120_000, clock(0, 200_000))

    const seen = await withDeadline(d, async () => remainingBudget(20_000))

    expect(seen).toBeUndefined()
  })
})

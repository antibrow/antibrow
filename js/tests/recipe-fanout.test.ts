import { describe, it, expect, vi, beforeEach } from 'vitest'

const runRecipe = vi.fn()
const getLicenseToken = vi.fn()

vi.mock('../src/recipe/runtime', () => ({ runRecipe }))
vi.mock('../src/engine', () => ({ getLicenseToken }))

const { fanoutRecipe } = await import('../src/recipe/fanout')

beforeEach(() => {
  runRecipe.mockReset()
  getLicenseToken.mockReset()
  getLicenseToken.mockResolvedValue({ token: 't', exp: 0, mi: 4, sync: true })
  runRecipe.mockImplementation(async ({ profile }: { profile: string }) => ({
    id: 'example/list', profile, value: { profile }, blockedHosts: [], logs: [], durationMs: 1,
  }))
})

describe('fanoutRecipe', () => {
  it('runs the same recipe on every profile', async () => {
    const result = await fanoutRecipe({ id: 'example/list', key: 'k', profiles: ['a', 'b', 'c'] })
    expect(result.results.map((r) => r.profile)).toEqual(['a', 'b', 'c'])
    expect(result.results.every((r) => r.ok)).toBe(true)
  })

  // The limit is machine-wide and enforced by the browser, so a fanout that
  // walks into it looks like a broken recipe rather than a plan limit.
  it('never queues more browsers than the license allows', async () => {
    getLicenseToken.mockResolvedValue({ token: 't', exp: 0, mi: 2, sync: true })
    let live = 0
    let peak = 0
    runRecipe.mockImplementation(async ({ profile }: { profile: string }) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 5))
      live--
      return { id: 'example/list', profile, value: null, blockedHosts: [], logs: [], durationMs: 1 }
    })
    const notices: string[] = []
    const result = await fanoutRecipe({
      id: 'example/list', key: 'k', profiles: ['a', 'b', 'c', 'd'], concurrency: 8,
      notify: (m) => notices.push(m),
    })
    expect(peak).toBe(2)
    expect(result.concurrency).toBe(2)
    expect(notices.join(' ')).toContain('lowered to 2')
  })

  it('keeps one failure from taking the rest down', async () => {
    runRecipe.mockImplementation(async ({ profile }: { profile: string }) => {
      if (profile === 'b') throw new Error('site said no')
      return { id: 'example/list', profile, value: { profile }, blockedHosts: [], logs: [], durationMs: 1 }
    })
    const result = await fanoutRecipe({ id: 'example/list', key: 'k', profiles: ['a', 'b', 'c'] })
    expect(result.results.map((r) => r.ok)).toEqual([true, false, true])
    expect(result.results[1]).toMatchObject({ profile: 'b', error: 'site said no' })
  })

  it('reports in the order asked for, not the order they finished', async () => {
    runRecipe.mockImplementation(async ({ profile }: { profile: string }) => {
      await new Promise((resolve) => setTimeout(resolve, profile === 'a' ? 20 : 1))
      return { id: 'example/list', profile, value: null, blockedHosts: [], logs: [], durationMs: 1 }
    })
    const result = await fanoutRecipe({ id: 'example/list', key: 'k', profiles: ['a', 'b'] })
    expect(result.results.map((r) => r.profile)).toEqual(['a', 'b'])
  })

  it('deduplicates the profile list', async () => {
    const result = await fanoutRecipe({ id: 'example/list', key: 'k', profiles: ['a', 'a', 'b'] })
    expect(result.results).toHaveLength(2)
    expect(runRecipe).toHaveBeenCalledTimes(2)
  })

  it('refuses an empty profile list', async () => {
    await expect(fanoutRecipe({ id: 'example/list', key: 'k', profiles: [] })).rejects.toThrow(/at least one profile/)
  })
})

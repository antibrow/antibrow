import { describe, it, expect, afterEach, vi } from 'vitest'
import { runRecipeOnPage } from '../src/recipe/runtime'
import { readMeta } from '../src/recipe/source'

const SOURCE = `export const meta = {
  id: 'example/list',
  summary: 'Lists the things.',
  domains: ['example.com', 'cdn.example.com'],
  entry: 'https://example.com/',
  identity: 'any',
  args: [{ name: 'limit', type: 'number', default: 10, max: 50 }],
}

export async function run(ctx, args) {
  ctx.log('starting')
  return { limit: args.limit, profile: ctx.profileName }
}
`

interface FakeRoute {
  request(): { url(): string }
  abort(reason?: string): Promise<void>
  continue(): Promise<void>
}

/**
 * The expression the SDK hands the browser is evaluated here instead, so the
 * wrapper, the ctx surface and the enforcement can be exercised without a
 * kernel. The route guard is the part that has to hold.
 */
function fakeBrowser(options: {
  throws?: boolean
  hang?: boolean
  delayMs?: number
  /** Fail this many leading evaluations the way a navigating entry page does. */
  loseContextTimes?: number
} = {}) {
  let guard: ((route: FakeRoute) => Promise<void>) | undefined
  let logSink: ((message: string) => void) | undefined
  const gotos: string[] = []
  let armed: () => void = () => {}
  const ready = new Promise<void>((resolve) => { armed = resolve })

  let evaluations = 0
  const loadStates: string[] = []
  const page = {
    exposeFunction: async (_name: string, fn: (message: string) => void) => { logSink = fn },
    goto: async (url: string) => { gotos.push(url) },
    waitForLoadState: async (state: string) => { loadStates.push(state) },
    evaluate: async (expression: string) => {
      evaluations++
      if (evaluations <= (options.loseContextTimes ?? 0)) {
        throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')
      }
      if (options.hang) return new Promise(() => {})
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (options.throws) throw new Error('site said no')
      const previous = (globalThis as Record<string, unknown>).window
      ;(globalThis as Record<string, unknown>).window = { __antibrowRecipeLog: (m: string) => logSink?.(m) }
      try {
        return await (eval(expression) as Promise<unknown>)
      } finally {
        ;(globalThis as Record<string, unknown>).window = previous
      }
    },
  }
  const context = {
    route: async (_pattern: string, handler: (route: FakeRoute) => Promise<void>) => {
      guard = handler
      armed()
    },
    unroute: async () => { guard = undefined },
  }
  const visit = async (url: string) => {
    const calls = { aborted: undefined as string | undefined, continued: false }
    await guard?.({
      request: () => ({ url: () => url }),
      abort: async (reason) => { calls.aborted = reason ?? 'aborted' },
      continue: async () => { calls.continued = true },
    })
    return calls
  }
  return {
    page, context, gotos, visit, ready, loadStates,
    evaluations: () => evaluations,
    hasGuard: () => !!guard,
  }
}

afterEach(() => { vi.useRealTimers() })

describe('runRecipeOnPage', () => {
  it('opens the entry, runs the recipe and returns its value', async () => {
    const fake = fakeBrowser()
    const result = await runRecipeOnPage({
      meta: readMeta(SOURCE),
      source: SOURCE,
      page: fake.page as never,
      context: fake.context as never,
      profileName: 'shopper-01',
    })
    expect(fake.gotos).toEqual(['https://example.com/'])
    expect(result.value).toEqual({ limit: 10, profile: 'shopper-01' })
    expect(result.logs).toEqual(['starting'])
    expect(result.blockedHosts).toEqual([])
  })

  it('opens the entry with declared arguments interpolated', async () => {
    const templated = SOURCE.replace(
      "entry: 'https://example.com/',",
      "entry: 'https://example.com/search?n={limit}',",
    )
    const fake = fakeBrowser()
    await runRecipeOnPage({
      meta: readMeta(templated), source: templated, args: { limit: 7 },
      page: fake.page as never, context: fake.context as never, profileName: 'p',
    })
    expect(fake.gotos).toEqual(['https://example.com/search?n=7'])
  })

  it('coerces the arguments the recipe declared', async () => {
    const fake = fakeBrowser()
    const result = await runRecipeOnPage({
      meta: readMeta(SOURCE),
      source: SOURCE,
      args: { limit: '7' },
      page: fake.page as never,
      context: fake.context as never,
      profileName: 'p',
    })
    expect(result.value).toMatchObject({ limit: 7 })
  })

  // The declaration is only worth anything if it is enforced where the request
  // actually leaves: run() executes in the page and can always call fetch itself.
  it('blocks every host the recipe did not declare', async () => {
    const fake = fakeBrowser()
    const running = runRecipeOnPage({
      meta: readMeta(SOURCE),
      source: SOURCE,
      page: fake.page as never,
      context: fake.context as never,
      profileName: 'p',
    })
    // The guard is installed before the entry is opened, so nothing loads unchecked.
    await fake.ready
    expect(fake.gotos).toEqual([])
    expect(await fake.visit('https://example.com/list.json')).toMatchObject({ continued: true })
    expect(await fake.visit('https://cdn.example.com/app.js')).toMatchObject({ continued: true })
    expect(await fake.visit('https://mail.google.com/inbox')).toMatchObject({ aborted: 'blockedbyclient' })
    const result = await running
    expect(result.blockedHosts).toEqual(['mail.google.com'])
  })

  it('removes the guard when the run ends', async () => {
    const fake = fakeBrowser()
    await runRecipeOnPage({
      meta: readMeta(SOURCE), source: SOURCE,
      page: fake.page as never, context: fake.context as never, profileName: 'p',
    })
    expect(fake.hasGuard()).toBe(false)
  })

  // A recipe cannot see its own blocked request, so the failure it reports is
  // usually misleading on its own.
  it('names the blocked hosts when the recipe fails', async () => {
    const fake = fakeBrowser({ throws: true, delayMs: 20 })
    const running = runRecipeOnPage({
      meta: readMeta(SOURCE), source: SOURCE,
      page: fake.page as never, context: fake.context as never, profileName: 'p',
    })
    await fake.ready
    await fake.visit('https://tracker.example.net/pixel')
    await expect(running).rejects.toThrow(/site said no \(blocked, not in meta.domains: tracker.example.net\)/)
  })

  // reddit's entry page bounces once after domcontentloaded, which destroys the
  // context the recipe is executing in. That is the page's doing, not the
  // recipe's.
  it('retries once when the entry page navigates out from under the recipe', async () => {
    const fake = fakeBrowser({ loseContextTimes: 1 })
    const result = await runRecipeOnPage({
      meta: readMeta(SOURCE), source: SOURCE,
      page: fake.page as never, context: fake.context as never, profileName: 'p',
    })
    expect(result.value).toEqual({ limit: 10, profile: 'p' })
    expect(fake.evaluations()).toBe(2)
    expect(fake.loadStates).toEqual(['domcontentloaded'])
  })

  // An anti-bot interstitial redirects to itself and then to the real page, so
  // the context can be lost twice in a row.
  it('tolerates the entry page navigating twice, and gives up after that', async () => {
    const twice = fakeBrowser({ loseContextTimes: 2 })
    await expect(runRecipeOnPage({
      meta: readMeta(SOURCE), source: SOURCE,
      page: twice.page as never, context: twice.context as never, profileName: 'p',
    })).resolves.toMatchObject({ profile: 'p' })
    expect(twice.evaluations()).toBe(3)

    const forever = fakeBrowser({ loseContextTimes: 9 })
    await expect(runRecipeOnPage({
      meta: readMeta(SOURCE), source: SOURCE,
      page: forever.page as never, context: forever.context as never, profileName: 'p',
    })).rejects.toThrow(/Execution context was destroyed/)
    expect(forever.evaluations()).toBe(3)
  })

  it('does not retry an error the recipe itself raised', async () => {
    const fake = fakeBrowser({ throws: true })
    await expect(runRecipeOnPage({
      meta: readMeta(SOURCE), source: SOURCE,
      page: fake.page as never, context: fake.context as never, profileName: 'p',
    })).rejects.toThrow(/site said no/)
    expect(fake.evaluations()).toBe(1)
  })

  it('gives up on a recipe that never returns', async () => {
    const fake = fakeBrowser({ hang: true })
    await expect(runRecipeOnPage({
      meta: readMeta(SOURCE), source: SOURCE, timeoutMs: 20,
      page: fake.page as never, context: fake.context as never, profileName: 'p',
    })).rejects.toThrow(/timed out after 20ms/)
  })

  it('rejects an argument the recipe never declared, before opening anything', async () => {
    const fake = fakeBrowser()
    await expect(runRecipeOnPage({
      meta: readMeta(SOURCE), source: SOURCE, args: { limitt: 1 },
      page: fake.page as never, context: fake.context as never, profileName: 'p',
    })).rejects.toThrow(/unknown argument/)
    expect(fake.gotos).toEqual([])
  })
})

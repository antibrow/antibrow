import type { BrowserContext, Page } from 'playwright-core'
import { AntiDetectBrowser } from '../browser'
import { ensureCacheDir } from '../profile'
import { buildRunnerExpression } from './bootstrap'
import { coerceArgs, resolveEntry } from './source'
import { assertRunnable, ensureRecipeSource, findRecipe, loadRegistry } from './registry'
import type { RecipeMeta, RecipeRunResult } from './types'

export const DEFAULT_RECIPE_TIMEOUT_MS = 60_000

const LOG_BINDING = '__antibrowRecipeLog'

export interface RunRecipeOnPageInput {
  meta: RecipeMeta
  source: string
  args?: Record<string, unknown>
  page: Page
  context: BrowserContext
  profileName: string
  timeoutMs?: number
  onLog?: (message: string) => void
}

/**
 * Runs one recipe against an already-open page. Split out from `runRecipe` so
 * the enforcement below can be exercised without a kernel: it is the part that
 * has to hold.
 */
export async function runRecipeOnPage(input: RunRecipeOnPageInput): Promise<RecipeRunResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_RECIPE_TIMEOUT_MS
  const args = coerceArgs(input.meta, input.args ?? {})
  const entry = resolveEntry(input.meta, args)
  const allowed = new Set(input.meta.domains.map((d) => d.toLowerCase()))
  const blockedHosts = new Set<string>()
  const logs: string[] = []
  const started = Date.now()

  // The declaration is enforced here, at the network layer, and not inside the
  // helpers a recipe is asked to use: `run()` executes in the page, so it can
  // always call `fetch` itself. Anything but a declared host is aborted, which
  // is what stops a recipe for one site from spending another site's cookies.
  const guard = async (route: { request(): { url(): string }; abort(reason?: string): Promise<void>; continue(): Promise<void> }) => {
    let host = ''
    try {
      host = new URL(route.request().url()).hostname.toLowerCase()
    } catch { /* a non-http scheme has no host to check */ }
    if (!host || allowed.has(host)) return route.continue()
    blockedHosts.add(host)
    return route.abort('blockedbyclient')
  }

  await input.page.exposeFunction(LOG_BINDING, (message: string) => {
    logs.push(message)
    input.onLog?.(message)
  }).catch(() => { /* already bound on a reused page */ })

  await input.context.route('**/*', guard)
  try {
    await input.page.goto(entry, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const expression = buildRunnerExpression(input.source, {
      args, profileName: input.profileName, timeoutMs,
    })
    const value = await withTimeout(
      evaluateOnce(input.page, expression, timeoutMs),
      timeoutMs,
      `${input.meta.id} timed out after ${timeoutMs}ms`,
    )
    return {
      id: input.meta.id,
      profile: input.profileName,
      value,
      blockedHosts: [...blockedHosts],
      logs,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A blocked host is the likeliest cause of a recipe failing on a machine
    // where it used to work, and the recipe cannot see the block itself.
    const hint = blockedHosts.size
      ? ` (blocked, not in meta.domains: ${[...blockedHosts].join(', ')})`
      // "Failed to fetch" with nothing blocked on our side is almost always the
      // entry page's own Content-Security-Policy: a bare JSON endpoint usually
      // sends `default-src 'none'`, which vetoes every fetch the recipe makes
      // from that page. Nothing in the recipe can see that, so name it here.
      : /Failed to fetch/.test(message)
        ? ` (the page at ${entry} may forbid this request through its own` +
          ' Content-Security-Policy - use an entry page on the site itself rather than a bare API endpoint)'
        : ''
    throw new Error(`${input.meta.id}: ${message}${hint}`)
  } finally {
    await input.context.unroute('**/*', guard).catch(() => {})
  }
}

const CONTEXT_LOST = /Execution context was destroyed|Cannot find context|frame was detached/i

/** Attempts, not retries. Two was not enough: an anti-bot interstitial redirects
 *  to itself and then to the real page, so the recipe can lose its context twice
 *  in a row through no fault of its own. */
const EVALUATE_ATTEMPTS = 3

/**
 * The entry page settling - a redirect, a consent bounce, a client-side route
 * change - destroys the context the recipe was evaluating in. That is the
 * page's business rather than the recipe's, so it gets another go once the
 * navigation has landed.
 */
async function evaluateOnce(page: Page, expression: string, timeoutMs: number): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.evaluate(expression)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!CONTEXT_LOST.test(message) || attempt >= EVALUATE_ATTEMPTS) throw error
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {})
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0) return promise
  let timer: NodeJS.Timeout
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
    }),
  ])
}

export interface RecipeLaunchOptions {
  key: string
  server?: string
  cacheDir?: string
  /** Named profile to run on. Omit together with `temporary: true`. */
  profile?: string
  /** Run on a throwaway local profile. The only place an unreviewed recipe may run. */
  temporary?: boolean
  headless?: boolean
  /** Default false: a fanout opens several windows, and none of them should steal focus. */
  focusWindow?: boolean
  /** Default false: restored tabs are somebody else's logged-in session, and the site sees them. */
  restoreTabs?: boolean
  timeoutMs?: number
  onLog?: (message: string) => void
  args?: Record<string, unknown>
}

export interface RunRecipeOptions extends RecipeLaunchOptions {
  id: string
  allowUnreviewed?: boolean
}

export function temporaryRecipeProfileName(id: string, suffix: string): string {
  return `recipe-${id.replace(/[^a-z0-9]+/gi, '-')}-${suffix}`
}

/** Launch the profile a recipe should run on, run it, close. */
export async function runRecipeSource(
  meta: RecipeMeta,
  source: string,
  options: RecipeLaunchOptions,
): Promise<RecipeRunResult> {
  if (!options.profile && !options.temporary) {
    throw new Error('A recipe run needs either a profile name or temporary: true.')
  }
  if (options.profile && options.temporary) {
    throw new Error('A recipe run takes a profile name or temporary: true, not both.')
  }
  const cacheDir = ensureCacheDir(options.cacheDir)
  const ab = new AntiDetectBrowser({
    key: options.key,
    server: options.server,
    cacheDir,
    // stdout carries the recipe's JSON, so notices go to stderr.
    notify: (message) => console.error(message),
  })
  const profileName = options.profile
    ?? temporaryRecipeProfileName(meta.id, Math.random().toString(36).slice(2, 8))

  const session = await ab.launch({
    profile: profileName,
    temporary: !!options.temporary,
    headless: options.headless,
    focusWindow: options.focusWindow ?? false,
    restoreTabs: options.restoreTabs ?? false,
    label: `recipe ${meta.id}`,
  })
  try {
    return await runRecipeOnPage({
      meta,
      source,
      args: options.args,
      page: session.page,
      context: session.context,
      profileName,
      timeoutMs: options.timeoutMs,
      onLog: options.onLog,
    })
  } finally {
    await session.browser.close().catch(() => {})
  }
}

/** Fetch a published recipe, then run it. */
export async function runRecipe(options: RunRecipeOptions): Promise<RecipeRunResult> {
  const cacheDir = ensureCacheDir(options.cacheDir)
  const registry = await loadRegistry({ cacheDir })
  const entry = findRecipe(registry, options.id)
  assertRunnable(entry, {
    allowUnreviewed: options.allowUnreviewed,
    temporary: !!options.temporary,
    cacheDir,
  })
  const source = await ensureRecipeSource({ cacheDir, entry })
  return runRecipeSource(entry, source, { ...options, cacheDir })
}

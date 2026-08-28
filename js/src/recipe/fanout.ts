import { getLicenseToken } from '../engine'
import { runRecipe, type RunRecipeOptions } from './runtime'
import type { FanoutRecipeResult, RecipeRunResult } from './types'

const DEFAULT_SERVER = 'https://antibrow.com'

export interface FanoutRecipeOptions extends Omit<RunRecipeOptions, 'profile' | 'temporary'> {
  profiles: string[]
  /** Capped by the license's concurrency limit, never above it. */
  concurrency?: number
  notify?: (message: string) => void
  onResult?: (result: FanoutRecipeResult['results'][number]) => void
}

/**
 * One recipe, N profiles, each with its own persona, cookie jar and exit.
 *
 * The concurrency cap is read from the license before anything is queued rather
 * than discovered by launching into a refusal: the kernel enforces the limit
 * machine-wide, so the browser that gets turned away is not necessarily one of
 * ours - and a refused launch mid-fanout looks like a broken recipe.
 */
export async function fanoutRecipe(options: FanoutRecipeOptions): Promise<FanoutRecipeResult> {
  const profiles = [...new Set(options.profiles)]
  if (profiles.length === 0) throw new Error('fanoutRecipe needs at least one profile.')

  const license = await getLicenseToken({ key: options.key, server: options.server ?? DEFAULT_SERVER })
  const requested = options.concurrency ?? license.mi
  const concurrency = Math.max(1, Math.min(requested, license.mi, profiles.length))
  if (requested > license.mi) {
    options.notify?.(
      `Concurrency lowered to ${license.mi}: that is what this plan's license allows, and the browser enforces it.`,
    )
  }

  const results: FanoutRecipeResult['results'] = []
  const queue = [...profiles]
  const worker = async (): Promise<void> => {
    for (;;) {
      const profile = queue.shift()
      if (!profile) return
      let row: FanoutRecipeResult['results'][number]
      try {
        const run: RecipeRunResult = await runRecipe({ ...options, profile, temporary: false })
        row = { ok: true, ...run }
      } catch (error) {
        row = { ok: false, profile, error: error instanceof Error ? error.message : String(error) }
      }
      results.push(row)
      options.onResult?.(row)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  // Restored in the order asked for: the pool finishes out of order, and a
  // caller diffing two profiles' output should not have to sort first.
  const rank = new Map(profiles.map((name, index) => [name, index]))
  results.sort((a, b) => (rank.get(a.profile) ?? 0) - (rank.get(b.profile) ?? 0))
  return { id: options.id, concurrency, results }
}

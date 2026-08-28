/** Argument declaration from a recipe's `meta`. */
export interface RecipeArg {
  name: string
  type: 'string' | 'number' | 'boolean'
  description?: string
  default?: string | number | boolean
  required?: boolean
  /** Upper bound for a `number`. A larger value is rejected, never clamped. */
  max?: number
}

/**
 * Whether the recipe needs the profile to be signed in to the site. Advisory:
 * nothing here checks it, but `recipe info` prints it so an agent knows whether
 * a throwaway profile can produce a useful answer.
 */
export type RecipeIdentity = 'any' | 'logged-in' | 'anonymous'

export interface RecipeMeta {
  id: string
  summary: string
  /** Every host the recipe may reach. Enforced at the network layer. */
  domains: string[]
  entry: string
  identity: RecipeIdentity
  args?: RecipeArg[]
}

/** One row of the published registry. */
export interface RecipeEntry extends RecipeMeta {
  path: string
  sha256: string
  /** A maintainer read this exact byte sequence. Reset by any change. */
  reviewed: boolean
}

export interface RecipeRegistry {
  version: number
  recipes: RecipeEntry[]
}

export interface RecipeRunResult {
  id: string
  profile: string
  value: unknown
  /** Hosts the recipe tried to reach that `meta.domains` does not declare. */
  blockedHosts: string[]
  logs: string[]
  durationMs: number
}

export interface FanoutRecipeResult {
  id: string
  concurrency: number
  results: Array<
    | ({ ok: true } & RecipeRunResult)
    | { ok: false; profile: string; error: string }
  >
}

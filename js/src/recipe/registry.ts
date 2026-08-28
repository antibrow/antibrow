import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { retryFetch } from '../retry-fetch'
import { readMeta, validateMeta } from './source'
import type { RecipeEntry, RecipeRegistry } from './types'

/**
 * The published registry. A separate public repository on purpose: adding a
 * site must not mean a release of this package, and the review cadence is not
 * the release cadence.
 */
export const RECIPE_REGISTRY_URL = 'https://raw.githubusercontent.com/antibrow/recipes/main/registry.json'

export function recipeRegistryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIBROW_RECIPES_URL || RECIPE_REGISTRY_URL
}

export function recipesDir(cacheDir: string): string {
  return path.join(cacheDir, 'recipes')
}

/** Content-addressed, so a fetched file is either the pinned bytes or nothing. */
function sourcePath(cacheDir: string, sha256: string): string {
  return path.join(recipesDir(cacheDir), 'files', `${sha256}.js`)
}

function registryCachePath(cacheDir: string): string {
  return path.join(recipesDir(cacheDir), 'registry.json')
}

export function recipeLockPath(cacheDir: string): string {
  return path.join(recipesDir(cacheDir), 'recipes.lock')
}

export interface RecipeLock {
  version: number
  pins: Record<string, string>
}

export function readRecipeLock(cacheDir: string): RecipeLock {
  try {
    const raw = JSON.parse(fs.readFileSync(recipeLockPath(cacheDir), 'utf8')) as Partial<RecipeLock>
    if (raw && typeof raw.pins === 'object' && raw.pins) return { version: 1, pins: raw.pins as Record<string, string> }
  } catch { /* no lock yet, or an unreadable one: treat as first run */ }
  return { version: 1, pins: {} }
}

function writeRecipeLock(cacheDir: string, lock: RecipeLock): void {
  fs.mkdirSync(recipesDir(cacheDir), { recursive: true })
  fs.writeFileSync(recipeLockPath(cacheDir), `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function parseRegistry(text: string): RecipeRegistry {
  const body = JSON.parse(text) as Partial<RecipeRegistry>
  if (!body || !Array.isArray(body.recipes)) throw new Error('registry has no recipes array')
  const recipes = body.recipes.map((raw) => {
    const row = raw as unknown as Record<string, unknown>
    const meta = validateMeta(row)
    if (typeof row.path !== 'string' || row.path.includes('..') || row.path.startsWith('/')) {
      throw new Error(`${meta.id}: registry path is not a relative file path`)
    }
    if (typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)) {
      throw new Error(`${meta.id}: registry entry has no sha256`)
    }
    return { ...meta, path: row.path, sha256: row.sha256, reviewed: row.reviewed === true } satisfies RecipeEntry
  })
  return { version: typeof body.version === 'number' ? body.version : 1, recipes }
}

export interface UpdateRecipesResult {
  registry: RecipeRegistry
  added: string[]
  changed: string[]
  url: string
}

/**
 * Pulls the registry and pins what it names. A recipe whose bytes changed since
 * this machine last saw it is reported and refused until the caller says yes:
 * the file already ran once against a profile that may hold live logins, and a
 * silent swap is the shape a supply-chain attack takes here.
 */
export async function updateRecipes(options: {
  cacheDir: string
  acceptChanges?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<UpdateRecipesResult> {
  const url = recipeRegistryUrl(options.env)
  const res = await retryFetch(`${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now().toString(36)}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`recipe registry: HTTP ${res.status} from ${url}`)
  const text = await res.text()
  const registry = parseRegistry(text)

  const lock = readRecipeLock(options.cacheDir)
  const added: string[] = []
  const changed: string[] = []
  for (const entry of registry.recipes) {
    const pinned = lock.pins[entry.id]
    if (!pinned) added.push(entry.id)
    else if (pinned !== entry.sha256) changed.push(entry.id)
  }
  if (changed.length && !options.acceptChanges) {
    throw new Error(
      `these recipes changed since this machine pinned them: ${changed.join(', ')}. ` +
      'Read the diff, then re-run with --accept-changes.',
    )
  }

  for (const entry of registry.recipes) lock.pins[entry.id] = entry.sha256
  fs.mkdirSync(recipesDir(options.cacheDir), { recursive: true })
  fs.writeFileSync(registryCachePath(options.cacheDir), text, 'utf8')
  writeRecipeLock(options.cacheDir, lock)
  return { registry, added, changed, url }
}

export function loadCachedRegistry(cacheDir: string): RecipeRegistry | undefined {
  try {
    return parseRegistry(fs.readFileSync(registryCachePath(cacheDir), 'utf8'))
  } catch {
    return undefined
  }
}

/** Cached copy, pulling once if this machine has never had one. */
export async function loadRegistry(options: {
  cacheDir: string
  env?: NodeJS.ProcessEnv
}): Promise<RecipeRegistry> {
  const cached = loadCachedRegistry(options.cacheDir)
  if (cached) return cached
  const { registry } = await updateRecipes({ cacheDir: options.cacheDir, env: options.env })
  return registry
}

export function findRecipe(registry: RecipeRegistry, id: string): RecipeEntry {
  const entry = registry.recipes.find((r) => r.id === id)
  if (entry) return entry
  const near = registry.recipes.map((r) => r.id).filter((known) => known.split('/')[0] === id.split('/')[0])
  throw new Error(
    `unknown recipe "${id}".` +
    (near.length ? ` That site has: ${near.join(', ')}` : ' Run `recipe list` to see what is published.'),
  )
}

/**
 * The recipe's own `meta` has to agree with the registry row that advertised
 * it. Both come from the same repository, so this is not about a hostile
 * registry - it catches the row and the file drifting apart, which is exactly
 * how a recipe would end up running with a wider allowlist than the one a
 * reviewer signed off on.
 */
function assertMetaMatchesEntry(entry: RecipeEntry, source: string): void {
  const meta = readMeta(source)
  if (meta.id !== entry.id) throw new Error(`${entry.id}: file declares id ${meta.id}`)
  if (meta.entry !== entry.entry) throw new Error(`${entry.id}: file and registry disagree on meta.entry`)
  if (meta.identity !== entry.identity) throw new Error(`${entry.id}: file and registry disagree on meta.identity`)
  const fromFile = [...meta.domains].sort().join(',')
  const fromRegistry = [...entry.domains].map((d) => d.toLowerCase()).sort().join(',')
  if (fromFile !== fromRegistry) throw new Error(`${entry.id}: file and registry disagree on meta.domains`)
}

/** Local copy of the pinned bytes, downloading and verifying them if needed. */
export async function ensureRecipeSource(options: {
  cacheDir: string
  entry: RecipeEntry
  env?: NodeJS.ProcessEnv
}): Promise<string> {
  const { cacheDir, entry } = options
  const file = sourcePath(cacheDir, entry.sha256)
  if (fs.existsSync(file)) {
    const cached = fs.readFileSync(file, 'utf8')
    if (sha256(cached) === entry.sha256) {
      assertMetaMatchesEntry(entry, cached)
      return cached
    }
    fs.rmSync(file, { force: true })
  }

  const url = new URL(entry.path, recipeRegistryUrl(options.env)).toString()
  const res = await retryFetch(`${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now().toString(36)}`)
  if (!res.ok) throw new Error(`${entry.id}: HTTP ${res.status} from ${url}`)
  const source = await res.text()
  const digest = sha256(source)
  if (digest !== entry.sha256) {
    throw new Error(`${entry.id}: sha256 mismatch (registry ${entry.sha256.slice(0, 12)}, file ${digest.slice(0, 12)})`)
  }
  assertMetaMatchesEntry(entry, source)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source, 'utf8')
  return source
}

/**
 * The three refusals that make the capability declaration mean something. An
 * unreviewed recipe is allowed only where a lost cookie jar costs nothing: a
 * temporary profile is local-only, so nothing it collects travels to another
 * machine.
 */
export function assertRunnable(entry: RecipeEntry, options: {
  allowUnreviewed?: boolean
  temporary: boolean
  cacheDir: string
}): void {
  const pinned = readRecipeLock(options.cacheDir).pins[entry.id]
  if (pinned && pinned !== entry.sha256) {
    throw new Error(`${entry.id} changed since it was pinned. Run \`recipe update --accept-changes\` after reading the diff.`)
  }
  if (entry.reviewed) return
  if (!options.allowUnreviewed) {
    throw new Error(`${entry.id} has not been reviewed. Pass --allow-unreviewed to run it anyway.`)
  }
  if (!options.temporary) {
    throw new Error(
      `${entry.id} has not been reviewed, so it may only run on a temporary profile. Add --temporary.`,
    )
  }
}

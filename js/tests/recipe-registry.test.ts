import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertRunnable, ensureRecipeSource, findRecipe, loadCachedRegistry, readRecipeLock, updateRecipes,
} from '../src/recipe/registry'
import type { RecipeEntry } from '../src/recipe/types'

const REGISTRY_URL = 'https://recipes.test/registry.json'

function recipeSource(id: string, domains = ['example.com']): string {
  return `export const meta = {
  id: '${id}',
  summary: 'Lists the things.',
  domains: ${JSON.stringify(domains)},
  entry: 'https://${domains[0]}/',
  identity: 'any',
}

export async function run(ctx) {
  return await ctx.fetchJson('/list.json')
}
`
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function registryBody(rows: Array<{ id: string; source: string; reviewed?: boolean; domains?: string[] }>) {
  return {
    version: 1,
    recipes: rows.map((row) => ({
      id: row.id,
      path: `sites/${row.id}.recipe.js`,
      sha256: sha(row.source),
      reviewed: row.reviewed ?? true,
      summary: 'Lists the things.',
      domains: row.domains ?? ['example.com'],
      entry: `https://${(row.domains ?? ['example.com'])[0]}/`,
      identity: 'any',
      args: [],
    })),
  }
}

let cacheDir: string
const realFetch = globalThis.fetch
const env = { ANTIBROW_RECIPES_URL: REGISTRY_URL } as NodeJS.ProcessEnv

function serve(routes: Record<string, string>): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input).split('?')[0]
    const body = routes[url]
    if (body === undefined) return { ok: false, status: 404, text: async () => 'missing' } as Response
    return { ok: true, status: 200, text: async () => body } as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-registry-'))
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

describe('updateRecipes', () => {
  it('caches the registry and pins every recipe it names', async () => {
    const source = recipeSource('example/list')
    serve({ [REGISTRY_URL]: JSON.stringify(registryBody([{ id: 'example/list', source }])) })

    const result = await updateRecipes({ cacheDir, env })
    expect(result.added).toEqual(['example/list'])
    expect(loadCachedRegistry(cacheDir)?.recipes).toHaveLength(1)
    expect(readRecipeLock(cacheDir).pins['example/list']).toBe(sha(source))
  })

  // The file already ran once against a profile that may hold live logins, so a
  // silent swap of its bytes is exactly the shape an attack takes here.
  it('refuses a recipe whose bytes changed, until told to accept it', async () => {
    const first = recipeSource('example/list')
    serve({ [REGISTRY_URL]: JSON.stringify(registryBody([{ id: 'example/list', source: first }])) })
    await updateRecipes({ cacheDir, env })

    const second = `${first}\n// a later revision\n`
    serve({ [REGISTRY_URL]: JSON.stringify(registryBody([{ id: 'example/list', source: second }])) })
    await expect(updateRecipes({ cacheDir, env })).rejects.toThrow(/changed since this machine pinned them/)
    expect(readRecipeLock(cacheDir).pins['example/list']).toBe(sha(first))

    const accepted = await updateRecipes({ cacheDir, env, acceptChanges: true })
    expect(accepted.changed).toEqual(['example/list'])
    expect(readRecipeLock(cacheDir).pins['example/list']).toBe(sha(second))
  })

  it('rejects a registry row with no sha256', async () => {
    const body = registryBody([{ id: 'example/list', source: recipeSource('example/list') }])
    delete (body.recipes[0] as Record<string, unknown>).sha256
    serve({ [REGISTRY_URL]: JSON.stringify(body) })
    await expect(updateRecipes({ cacheDir, env })).rejects.toThrow(/no sha256/)
  })

  it('rejects a registry row declaring a wildcard host', async () => {
    const body = registryBody([{ id: 'example/list', source: recipeSource('example/list') }])
    ;(body.recipes[0] as Record<string, unknown>).domains = ['*.example.com']
    serve({ [REGISTRY_URL]: JSON.stringify(body) })
    await expect(updateRecipes({ cacheDir, env })).rejects.toThrow(/exact hostnames/)
  })
})

describe('ensureRecipeSource', () => {
  const fileUrl = 'https://recipes.test/sites/example/list.recipe.js'

  it('downloads, verifies and reuses the pinned bytes', async () => {
    const source = recipeSource('example/list')
    const entry = registryBody([{ id: 'example/list', source }]).recipes[0] as RecipeEntry
    serve({ [fileUrl]: source })

    expect(await ensureRecipeSource({ cacheDir, entry, env })).toBe(source)
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    expect(await ensureRecipeSource({ cacheDir, entry, env })).toBe(source)
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls)
  })

  it('refuses bytes that do not match the pinned digest', async () => {
    const entry = registryBody([{ id: 'example/list', source: recipeSource('example/list') }])
      .recipes[0] as RecipeEntry
    serve({ [fileUrl]: `${recipeSource('example/list')}// tampered\n` })
    await expect(ensureRecipeSource({ cacheDir, entry, env })).rejects.toThrow(/sha256 mismatch/)
  })

  // The row is what a reviewer signed off on; the file is what runs. A wider
  // allowlist in the file than in the row must not be allowed to take effect.
  it('refuses a file whose meta disagrees with the row', async () => {
    const source = recipeSource('example/list', ['example.com', 'mail.example.net'])
    const entry = {
      ...(registryBody([{ id: 'example/list', source }]).recipes[0] as RecipeEntry),
      domains: ['example.com'],
    }
    serve({ [fileUrl]: source })
    await expect(ensureRecipeSource({ cacheDir, entry, env })).rejects.toThrow(/disagree on meta.domains/)
  })
})

describe('assertRunnable', () => {
  const entry = (over: Partial<RecipeEntry> = {}): RecipeEntry => ({
    ...(registryBody([{ id: 'example/list', source: recipeSource('example/list') }]).recipes[0] as RecipeEntry),
    ...over,
  })

  it('lets a reviewed recipe run anywhere', () => {
    expect(() => assertRunnable(entry(), { temporary: false, cacheDir })).not.toThrow()
  })

  it('needs an explicit opt-in for an unreviewed recipe', () => {
    expect(() => assertRunnable(entry({ reviewed: false }), { temporary: true, cacheDir }))
      .toThrow(/has not been reviewed/)
  })

  // A temporary profile is local-only, so nothing an unreviewed recipe touches
  // travels to another machine.
  it('confines an unreviewed recipe to a temporary profile', () => {
    expect(() => assertRunnable(entry({ reviewed: false }), {
      allowUnreviewed: true, temporary: false, cacheDir,
    })).toThrow(/only run on a temporary profile/)
    expect(() => assertRunnable(entry({ reviewed: false }), {
      allowUnreviewed: true, temporary: true, cacheDir,
    })).not.toThrow()
  })

  it('refuses a recipe that drifted from the local pin', async () => {
    const source = recipeSource('example/list')
    serve({ [REGISTRY_URL]: JSON.stringify(registryBody([{ id: 'example/list', source }])) })
    await updateRecipes({ cacheDir, env })
    expect(() => assertRunnable(entry({ sha256: sha(`${source}// other\n`) }), { temporary: false, cacheDir }))
      .toThrow(/changed since it was pinned/)
  })
})

describe('findRecipe', () => {
  it('points at the other commands for that site', () => {
    const registry = { version: 1, recipes: [entryFor('example/list'), entryFor('example/search')] }
    expect(() => findRecipe(registry, 'example/lists')).toThrow(/example\/list, example\/search/)
  })
})

function entryFor(id: string): RecipeEntry {
  return registryBody([{ id, source: recipeSource(id) }]).recipes[0] as RecipeEntry
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, runRecipeCli } from '../src/recipe/cli'

const REGISTRY_URL = 'https://recipes.test/registry.json'

const SOURCE = `export const meta = {
  id: 'example/list',
  summary: 'Lists the things.',
  domains: ['example.com'],
  entry: 'https://example.com/',
  identity: 'any',
  args: [{ name: 'limit', type: 'number', default: 10, max: 50 }],
}

export async function run(ctx, args) {
  return await ctx.fetchJson('/list.json?limit=' + args.limit)
}
`

const REGISTRY = {
  version: 1,
  recipes: [
    {
      id: 'example/list',
      path: 'sites/example/list.recipe.js',
      sha256: createHash('sha256').update(SOURCE).digest('hex'),
      reviewed: true,
      summary: 'Lists the things.',
      domains: ['example.com'],
      entry: 'https://example.com/',
      identity: 'any',
      args: [{ name: 'limit', type: 'number', default: 10, max: 50 }],
    },
    {
      id: 'other/thing',
      path: 'sites/other/thing.recipe.js',
      sha256: createHash('sha256').update('x').digest('hex'),
      reviewed: false,
      summary: 'Does the other thing.',
      domains: ['other.test'],
      entry: 'https://other.test/',
      identity: 'anonymous',
      args: [],
    },
  ],
}

let dir: string
let env: NodeJS.ProcessEnv
const realFetch = globalThis.fetch

function io() {
  const out: string[] = []
  const err: string[] = []
  return { out: (l: string) => out.push(l), err: (l: string) => err.push(l), outText: () => out.join('\n'), errText: () => err.join('\n') }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-'))
  env = { ANTIBROW_CACHE_DIR: path.join(dir, 'cache'), ANTIBROW_RECIPES_URL: REGISTRY_URL } as NodeJS.ProcessEnv
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input).split('?')[0]
    if (url === REGISTRY_URL) return { ok: true, status: 200, text: async () => JSON.stringify(REGISTRY) } as Response
    if (url === 'https://recipes.test/GUIDE.md') return { ok: true, status: 200, text: async () => '# Writing a recipe' } as Response
    return { ok: false, status: 404, text: async () => 'missing' } as Response
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('reads both --flag value and --flag=value', () => {
    expect(parseArgs(['run', 'x/y', '--profile', 'p1', '--jq=.a', '--json'])).toEqual({
      positionals: ['run', 'x/y'],
      flags: { profile: 'p1', jq: '.a', json: true },
    })
  })
})

describe('recipe cli', () => {
  it('update reports what it pinned', async () => {
    const sink = io()
    expect(await runRecipeCli(['update'], env, sink)).toBe(0)
    expect(sink.outText()).toContain('2 recipe(s) from https://recipes.test/registry.json')
    expect(sink.outText()).toContain('new: example/list, other/thing')
  })

  it('list marks what nobody reviewed', async () => {
    const sink = io()
    expect(await runRecipeCli(['list'], env, sink)).toBe(0)
    expect(sink.outText()).toMatch(/example\/list\s+ +Lists the things\./)
    expect(sink.outText()).toMatch(/other\/thing\s+! Does the other thing\./)
  })

  it('list --site filters, and says so when nothing matches', async () => {
    const one = io()
    expect(await runRecipeCli(['list', '--site', 'example', '--json'], env, one)).toBe(0)
    expect(JSON.parse(one.outText())).toHaveLength(1)

    const none = io()
    expect(await runRecipeCli(['list', '--site', 'nope'], env, none)).toBe(1)
    expect(none.errText()).toContain('no recipes for site "nope"')
  })

  it('info is self-describing, so an agent does not have to guess', async () => {
    const sink = io()
    expect(await runRecipeCli(['info', 'example/list'], env, sink)).toBe(0)
    const text = sink.outText()
    expect(text).toContain('entry     https://example.com/')
    expect(text).toContain('domains   example.com')
    expect(text).toContain('identity  any')
    expect(text).toContain('limit')
    expect(text).toContain('default 10')
    expect(text).toContain('max 50')
  })

  it('info points at the other commands for that site', async () => {
    const sink = io()
    expect(await runRecipeCli(['info', 'example/lists'], env, sink)).toBe(1)
    expect(sink.errText()).toContain('example/list')
  })

  it('guide prints the authoring guide and caches it', async () => {
    const sink = io()
    expect(await runRecipeCli(['guide'], env, sink)).toBe(0)
    expect(sink.outText()).toContain('# Writing a recipe')
    expect(fs.existsSync(path.join(env.ANTIBROW_CACHE_DIR!, 'recipes', 'GUIDE.md'))).toBe(true)
  })

  it('scaffold writes a skeleton at the path the registry expects', async () => {
    const sink = io()
    expect(await runRecipeCli(['scaffold', 'newsite/list', '--dir', dir], env, sink)).toBe(0)
    const file = path.join(dir, 'sites', 'newsite', 'list.recipe.js')
    expect(fs.readFileSync(file, 'utf8')).toContain("id: 'newsite/list'")
    expect(await runRecipeCli(['scaffold', 'newsite/list', '--dir', dir], env, io())).toBe(1)
  })

  it('test refuses a target with no local file, rather than silently running the published one', async () => {
    const sink = io()
    expect(await runRecipeCli(['test', 'example/list', '--dir', dir], env, sink)).toBe(1)
    expect(sink.errText()).toContain('no local recipe')
  })

  it('run needs an api key', async () => {
    const sink = io()
    expect(await runRecipeCli(['run', 'example/list', '--temporary'], { ...env, ANTIBROW_API_KEY: '' }, sink)).toBe(1)
    expect(sink.errText()).toContain('No API key')
  })

  it('fanout needs profiles', async () => {
    const sink = io()
    expect(await runRecipeCli(['fanout', 'example/list'], { ...env, ANTIBROW_API_KEY: 'k' }, sink)).toBe(1)
    expect(sink.errText()).toContain('--profiles')
  })

  it('help lists every subcommand', async () => {
    const sink = io()
    expect(await runRecipeCli([], env, sink)).toBe(1)
    for (const command of ['update', 'list', 'info', 'run', 'fanout', 'test', 'scaffold', 'guide']) {
      expect(sink.outText()).toContain(command)
    }
  })

  it('rejects an unknown subcommand', async () => {
    const sink = io()
    expect(await runRecipeCli(['runn'], env, sink)).toBe(1)
    expect(sink.errText()).toContain('unknown recipe command: runn')
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { ensureCacheDir, listProfiles } from '../profile'
import { fanoutRecipe } from './fanout'
import {
  ensureRecipeSource, findRecipe, loadCachedRegistry, loadRegistry, recipeRegistryUrl,
  recipesDir, updateRecipes,
} from './registry'
import { applyFilter } from './select'
import { readMeta } from './source'
import { assertRunnable } from './registry'
import { runRecipe, runRecipeSource } from './runtime'
import type { RecipeEntry, RecipeRunResult } from './types'

export interface RecipeCliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const consoleIo: RecipeCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}

interface Parsed {
  positionals: string[]
  flags: Record<string, string | true>
}

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }
  return { positionals, flags }
}

/** Matches the Python SDK's precedence; both SDKs share one cache. */
function cacheDirFromEnv(env: NodeJS.ProcessEnv): string {
  return ensureCacheDir(env.ANTIBROW_CACHE_DIR || env.ANTI_DETECT_BROWSER_CACHE_DIR)
}

function apiKeyFromEnv(env: NodeJS.ProcessEnv): string {
  const key = env.ANTIBROW_API_KEY || env.ANTI_DETECT_BROWSER_KEY
  if (!key) {
    throw new Error(
      'No API key. Set ANTIBROW_API_KEY (or ANTI_DETECT_BROWSER_KEY). Get one at https://antibrow.com.',
    )
  }
  return key
}

function flagString(flags: Parsed['flags'], name: string): string | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (value === true) throw new Error(`--${name} needs a value`)
  return value
}

function flagNumber(flags: Parsed['flags'], name: string): number | undefined {
  const raw = flagString(flags, name)
  if (raw === undefined) return undefined
  const num = Number(raw)
  if (!Number.isFinite(num)) throw new Error(`--${name} must be a number`)
  return num
}

function parseArgsJson(flags: Parsed['flags']): Record<string, unknown> {
  const raw = flagString(flags, 'args')
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('--args must be a JSON object, e.g. --args \'{"limit":5}\'')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--args must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function shaped(value: unknown, flags: Parsed['flags']): unknown {
  const filter = flagString(flags, 'jq')
  return filter ? applyFilter(value, filter) : value
}

function printValue(io: RecipeCliIo, value: unknown): void {
  io.out(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function reportRun(io: RecipeCliIo, run: RecipeRunResult, flags: Parsed['flags']): void {
  if (run.blockedHosts.length) {
    io.err(`blocked hosts (not in meta.domains): ${run.blockedHosts.join(', ')}`)
  }
  if (flags.json) {
    io.out(JSON.stringify({ ...run, value: shaped(run.value, flags) }, null, 2))
    return
  }
  printValue(io, shaped(run.value, flags))
  io.err(`${run.id} on ${run.profile} in ${run.durationMs}ms`)
}

function describe(entry: RecipeEntry): string[] {
  const lines = [
    `${entry.id}${entry.reviewed ? '' : '  [unreviewed]'}`,
    `  ${entry.summary}`,
    `  entry     ${entry.entry}`,
    `  domains   ${entry.domains.join(', ')}`,
    `  identity  ${entry.identity}`,
  ]
  if (entry.args?.length) {
    lines.push('  args')
    for (const arg of entry.args) {
      const bits: string[] = [arg.type]
      if (arg.required) bits.push('required')
      if (arg.default !== undefined) bits.push(`default ${JSON.stringify(arg.default)}`)
      if (arg.max !== undefined) bits.push(`max ${arg.max}`)
      lines.push(`    ${arg.name.padEnd(12)} ${bits.join(', ')}${arg.description ? ` - ${arg.description}` : ''}`)
    }
  } else {
    lines.push('  args      (none)')
  }
  return lines
}

const SCAFFOLD = (id: string) => `export const meta = {
  id: '${id}',
  summary: 'One sentence: what this command returns.',
  // Every host the recipe may reach. Exact hostnames, no wildcards.
  domains: ['example.com'],
  entry: 'https://example.com/',
  identity: 'any',
  args: [
    { name: 'limit', type: 'number', default: 25, max: 100 },
  ],
}

// Runs inside the page: relative fetches carry this profile's session for the
// site, and document/window are available. There is no fs, no process, no goto.
export async function run(ctx, args) {
  const res = await ctx.fetchJson(\`/some/endpoint.json?limit=\${args.limit}\`)
  return { items: res.items }
}
`

const HELP = `anti-detect-browser recipe <command>

  update [--accept-changes]        pull the registry and pin what it names
  list [--site <site>] [--json]    published recipes
  info <id> [--json]               args, domains, identity, review state
  run <id> [options]               run one recipe and print its JSON
  fanout <id> --profiles <pattern> run one recipe on several profiles at once
  test <id|file> [options]         run a local working copy on a temporary profile
  scaffold <site>/<command>        write a recipe skeleton
  guide                            print the recipe authoring guide

Options for run / fanout / test:
  --profile <name>     profile to run on
  --temporary          run on a throwaway local profile instead
  --args '<json>'      recipe arguments, e.g. --args '{"limit":5}'
  --jq '<filter>'      trim the output: .items[].title, .items[0], length, keys, |
  --json               print the whole result object, not just the value
  --allow-unreviewed   run a recipe nobody has reviewed (temporary profiles only)
  --headless           no window
  --timeout <ms>       per-run limit (default 60000)
  --concurrency <n>    fanout only; capped by the license's concurrency limit
  --profiles <pattern> fanout only; a name or a '*' pattern over local profiles

Environment:
  ANTIBROW_API_KEY     API key
  ANTIBROW_RECIPES_URL registry url, for a fork or a local file server
  ANTIBROW_CACHE_DIR   cache directory`

function matchProfiles(pattern: string, cacheDir: string): string[] {
  if (!pattern.includes('*')) return [pattern]
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  const matched = listProfiles(cacheDir).filter((name) => re.test(name))
  if (!matched.length) throw new Error(`no local profile matches "${pattern}"`)
  return matched
}

function localRecipePath(target: string, flags: Parsed['flags']): string | undefined {
  const dir = flagString(flags, 'dir') ?? process.cwd()
  const file = target.endsWith('.js')
    ? path.resolve(dir, target)
    : path.join(dir, 'sites', `${target}.recipe.js`)
  return fs.existsSync(file) ? file : undefined
}

async function cmdGuide(cacheDir: string, env: NodeJS.ProcessEnv, io: RecipeCliIo): Promise<number> {
  const cached = path.join(recipesDir(cacheDir), 'GUIDE.md')
  const url = new URL('GUIDE.md', recipeRegistryUrl(env)).toString()
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, text, 'utf8')
    io.out(text)
    return 0
  } catch (error) {
    if (fs.existsSync(cached)) {
      io.err(`showing the cached guide: ${error instanceof Error ? error.message : error}`)
      io.out(fs.readFileSync(cached, 'utf8'))
      return 0
    }
    io.err(`could not fetch the guide (${error instanceof Error ? error.message : error}). Read it at ${url}`)
    return 1
  }
}

export async function runRecipeCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: RecipeCliIo = consoleIo,
): Promise<number> {
  const { positionals, flags } = parseArgs(argv)
  const command = positionals[0]
  if (!command || command === 'help' || flags.help) {
    io.out(HELP)
    return command ? 0 : 1
  }
  const cacheDir = cacheDirFromEnv(env)

  try {
    if (command === 'update') {
      const result = await updateRecipes({ cacheDir, acceptChanges: flags['accept-changes'] === true, env })
      if (flags.json) {
        io.out(JSON.stringify({ url: result.url, count: result.registry.recipes.length, added: result.added, changed: result.changed }, null, 2))
        return 0
      }
      io.out(`${result.registry.recipes.length} recipe(s) from ${result.url}`)
      if (result.added.length) io.out(`  new: ${result.added.join(', ')}`)
      if (result.changed.length) io.out(`  changed: ${result.changed.join(', ')}`)
      return 0
    }

    if (command === 'list') {
      const registry = await loadRegistry({ cacheDir, env })
      const site = flagString(flags, 'site')
      const rows = registry.recipes.filter((r) => !site || r.id.split('/')[0] === site)
      if (flags.json) {
        io.out(JSON.stringify(rows, null, 2))
        return 0
      }
      if (!rows.length) {
        io.err(site ? `no recipes for site "${site}"` : 'the registry is empty')
        return 1
      }
      const width = Math.max(...rows.map((r) => r.id.length))
      for (const row of rows) {
        io.out(`${row.id.padEnd(width)}  ${row.reviewed ? ' ' : '!'} ${row.summary}`)
      }
      io.err('! = not reviewed, runs only on a temporary profile with --allow-unreviewed')
      return 0
    }

    if (command === 'info') {
      const id = positionals[1]
      if (!id) throw new Error('recipe info needs a recipe id')
      const entry = findRecipe(await loadRegistry({ cacheDir, env }), id)
      if (flags.json) {
        io.out(JSON.stringify(entry, null, 2))
        return 0
      }
      for (const line of describe(entry)) io.out(line)
      return 0
    }

    if (command === 'guide') return await cmdGuide(cacheDir, env, io)

    if (command === 'scaffold') {
      const id = positionals[1]
      if (!id || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) {
        throw new Error('recipe scaffold needs <site>/<command>, lowercase')
      }
      const dir = flagString(flags, 'dir') ?? process.cwd()
      const file = path.join(dir, 'sites', `${id}.recipe.js`)
      if (fs.existsSync(file)) throw new Error(`${file} already exists`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, SCAFFOLD(id), 'utf8')
      io.out(file)
      io.err(`next: edit it, then \`anti-detect-browser recipe test ${id}\``)
      return 0
    }

    if (command === 'run' || command === 'test') {
      const target = positionals[1]
      if (!target) throw new Error(`recipe ${command} needs a recipe id`)
      // Resolved before the key is demanded: a missing working copy is a usage
      // mistake, and asking for credentials first hides it.
      const local = command === 'test' ? localRecipePath(target, flags) : undefined
      if (command === 'test' && !local) {
        throw new Error(`no local recipe for "${target}". Run it from the recipes checkout, or use \`recipe run\`.`)
      }
      const temporary = flags.temporary === true || (command === 'test' && !flags.profile)
      const launch = {
        key: apiKeyFromEnv(env),
        server: env.ANTIBROW_SERVER || env.ANTI_DETECT_BROWSER_SERVER,
        cacheDir,
        profile: flagString(flags, 'profile'),
        temporary: temporary && !flags.profile,
        headless: flags.headless === true,
        timeoutMs: flagNumber(flags, 'timeout'),
        args: parseArgsJson(flags),
        onLog: (message: string) => io.err(`  ${message}`),
      }

      if (local) {
        const source = fs.readFileSync(local, 'utf8')
        io.err(`running the working copy at ${local}`)
        reportRun(io, await runRecipeSource(readMeta(source), source, launch), flags)
        return 0
      }
      reportRun(io, await runRecipe({
        ...launch,
        id: target,
        allowUnreviewed: flags['allow-unreviewed'] === true,
      }), flags)
      return 0
    }

    if (command === 'fanout') {
      const id = positionals[1]
      if (!id) throw new Error('recipe fanout needs a recipe id')
      const pattern = flagString(flags, 'profiles')
      if (!pattern) throw new Error('recipe fanout needs --profiles <name-or-pattern>')
      const profiles = pattern.split(',').flatMap((p) => matchProfiles(p.trim(), cacheDir))
      const result = await fanoutRecipe({
        id,
        key: apiKeyFromEnv(env),
        server: env.ANTIBROW_SERVER || env.ANTI_DETECT_BROWSER_SERVER,
        cacheDir,
        profiles,
        concurrency: flagNumber(flags, 'concurrency'),
        args: parseArgsJson(flags),
        timeoutMs: flagNumber(flags, 'timeout'),
        headless: flags.headless === true,
        notify: (message) => io.err(message),
        onResult: (row) => io.err(row.ok ? `  ${row.profile} ok` : `  ${row.profile} failed: ${row.error}`),
      })
      if (flags.json) {
        io.out(JSON.stringify({
          ...result,
          results: result.results.map((r) => (r.ok ? { ...r, value: shaped(r.value, flags) } : r)),
        }, null, 2))
      } else {
        for (const row of result.results) {
          io.out(`--- ${row.profile}`)
          if (row.ok) printValue(io, shaped(row.value, flags))
          else io.out(`error: ${row.error}`)
        }
      }
      return result.results.every((r) => r.ok) ? 0 : 1
    }

    io.err(`unknown recipe command: ${command}`)
    io.out(HELP)
    return 1
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

/** `recipe list` without a network round trip, for callers that only want what is cached. */
export function cachedRecipeIds(cacheDir: string): string[] {
  return (loadCachedRegistry(cacheDir)?.recipes ?? []).map((r) => r.id)
}

export { assertRunnable, ensureRecipeSource }

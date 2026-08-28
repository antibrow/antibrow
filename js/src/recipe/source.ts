import vm from 'node:vm'
import { stripExports } from './bootstrap'
import type { RecipeArg, RecipeIdentity, RecipeMeta } from './types'

const IDENTITIES: RecipeIdentity[] = ['any', 'logged-in', 'anonymous']
const ARG_TYPES = ['string', 'number', 'boolean']

/**
 * Reads `meta` out of a recipe without importing it. An import would run the
 * file's top level, and the caller has not decided to trust it yet - this is
 * what the registry entry gets compared against.
 */
export function readMeta(source: string): RecipeMeta {
  let value: unknown
  try {
    value = vm.runInNewContext(`${stripExports(source)}\n;meta`, Object.create(null), { timeout: 500 })
  } catch (error) {
    throw new Error(`recipe meta is not readable: ${error instanceof Error ? error.message : error}`)
  }
  return validateMeta(value)
}

export function validateMeta(value: unknown): RecipeMeta {
  if (!value || typeof value !== 'object') throw new Error('recipe meta must be an object')
  const meta = value as Record<string, unknown>
  const id = meta.id
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error('recipe meta.id must look like <site>/<command>')
  }
  if (typeof meta.summary !== 'string' || !meta.summary) throw new Error(`${id}: meta.summary is required`)
  if (!Array.isArray(meta.domains) || meta.domains.length === 0) {
    throw new Error(`${id}: meta.domains must list at least one host`)
  }
  const domains = meta.domains.map((d) => {
    if (typeof d !== 'string' || d.includes('*') || d.startsWith('.') || !d.includes('.')) {
      throw new Error(`${id}: meta.domains must be exact hostnames, no wildcards`)
    }
    return d.toLowerCase()
  })
  if (typeof meta.entry !== 'string') throw new Error(`${id}: meta.entry is required`)
  const args = validateArgs(id, meta.args)
  assertEntry(id, meta.entry, domains, args)
  const identity = meta.identity as RecipeIdentity
  if (!IDENTITIES.includes(identity)) throw new Error(`${id}: meta.identity must be any | logged-in | anonymous`)
  return { id, summary: meta.summary, domains, entry: meta.entry, identity, args }
}

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * `meta.entry` may interpolate declared arguments - `…/search?q={query}`. Sites
 * that only render results on a real navigation (Google answers a fetch for its
 * own result page with a redirect interstitial) are unreachable otherwise,
 * because a recipe cannot navigate once it is running.
 *
 * The host stays literal on purpose: it is the thing `meta.domains` is checked
 * against, and an argument-controlled host would let a caller point a reviewed
 * recipe at any site with that profile's cookies.
 */
function assertEntry(id: string, entry: string, domains: string[], args: RecipeArg[]): void {
  const declared = new Set(args.map((a) => a.name))
  for (const [, name] of entry.matchAll(PLACEHOLDER_RE)) {
    if (!declared.has(name)) throw new Error(`${id}: meta.entry uses {${name}}, which is not a declared argument`)
  }
  let url: URL
  try {
    url = new URL(entry.replace(PLACEHOLDER_RE, 'x'))
  } catch {
    throw new Error(`${id}: meta.entry is not a url`)
  }
  if (url.protocol !== 'https:') throw new Error(`${id}: meta.entry must be https`)
  if (PLACEHOLDER_RE.test(new URL(entry.replace(PLACEHOLDER_RE, 'x')).origin) || /\{/.test(entry.split('/')[2] ?? '')) {
    throw new Error(`${id}: meta.entry may not interpolate the host`)
  }
  if (!domains.includes(url.hostname)) throw new Error(`${id}: meta.entry host is not in meta.domains`)
}

/** The entry url for one run, with declared arguments interpolated. */
export function resolveEntry(meta: RecipeMeta, args: Record<string, unknown>): string {
  return meta.entry.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = args[name]
    return value === undefined || value === null ? '' : encodeURIComponent(String(value))
  })
}

function validateArgs(id: string, value: unknown): RecipeArg[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${id}: meta.args must be an array`)
  return value.map((raw) => {
    const arg = raw as Record<string, unknown>
    if (!arg || typeof arg.name !== 'string' || !arg.name) throw new Error(`${id}: every meta.args entry needs a name`)
    if (typeof arg.type !== 'string' || !ARG_TYPES.includes(arg.type)) {
      throw new Error(`${id}: argument ${arg.name} needs type ${ARG_TYPES.join(' | ')}`)
    }
    return {
      name: arg.name,
      type: arg.type as RecipeArg['type'],
      description: typeof arg.description === 'string' ? arg.description : undefined,
      default: arg.default as RecipeArg['default'],
      required: arg.required === true,
      max: typeof arg.max === 'number' ? arg.max : undefined,
    }
  })
}

/**
 * Fills defaults and rejects anything the recipe did not declare. An unknown
 * name is an error rather than a passthrough: the usual cause is a typo, and
 * silently dropping it produces a plausible-looking result for the wrong query.
 */
export function coerceArgs(meta: RecipeMeta, input: Record<string, unknown> = {}): Record<string, unknown> {
  const declared = meta.args ?? []
  const known = new Set(declared.map((a) => a.name))
  for (const name of Object.keys(input)) {
    if (!known.has(name)) {
      const list = declared.length ? declared.map((a) => a.name).join(', ') : '(none)'
      throw new Error(`${meta.id}: unknown argument "${name}". Declared: ${list}`)
    }
  }
  const out: Record<string, unknown> = {}
  for (const arg of declared) {
    const raw = input[arg.name]
    if (raw === undefined || raw === null || raw === '') {
      if (arg.required) throw new Error(`${meta.id}: argument "${arg.name}" is required`)
      if (arg.default !== undefined) out[arg.name] = arg.default
      continue
    }
    out[arg.name] = coerceOne(meta.id, arg, raw)
  }
  return out
}

function coerceOne(id: string, arg: RecipeArg, raw: unknown): string | number | boolean {
  if (arg.type === 'number') {
    const num = typeof raw === 'number' ? raw : Number(String(raw))
    if (!Number.isFinite(num)) throw new Error(`${id}: argument "${arg.name}" must be a number`)
    if (arg.max !== undefined && num > arg.max) {
      throw new Error(`${id}: argument "${arg.name}" is capped at ${arg.max}`)
    }
    return num
  }
  if (arg.type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    const text = String(raw).toLowerCase()
    if (['true', '1', 'yes'].includes(text)) return true
    if (['false', '0', 'no'].includes(text)) return false
    throw new Error(`${id}: argument "${arg.name}" must be true or false`)
  }
  return String(raw)
}

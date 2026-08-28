import { describe, it, expect } from 'vitest'
import { coerceArgs, readMeta, resolveEntry, validateMeta } from '../src/recipe/source'
import { buildRunnerExpression, stripExports } from '../src/recipe/bootstrap'

const GOOD = `export const meta = {
  id: 'example/list',
  summary: 'Lists the things.',
  domains: ['example.com'],
  entry: 'https://example.com/',
  identity: 'any',
  args: [{ name: 'limit', type: 'number', default: 10, max: 50 }],
}

export async function run(ctx, args) {
  return { limit: args.limit }
}
`

describe('readMeta', () => {
  it('reads meta without importing the file', () => {
    expect(readMeta(GOOD)).toMatchObject({ id: 'example/list', domains: ['example.com'], identity: 'any' })
  })

  // The file has not been trusted yet at this point, so top-level code must not
  // get a chance to run and no host binding may be reachable from it.
  it('cannot reach the host from a recipe body', () => {
    const hostile = `export const meta = { id: 'x/y', summary: 'aaaaaaaaaa', domains: ['example.com'], entry: 'https://example.com/', identity: 'any' }
    if (typeof process !== 'undefined') throw new Error('process reached')
    if (typeof require !== 'undefined') throw new Error('require reached')
    export async function run() { return 1 }`
    expect(readMeta(hostile).id).toBe('x/y')
  })
})

describe('validateMeta', () => {
  const base = {
    id: 'example/list',
    summary: 'Lists the things.',
    domains: ['example.com'],
    entry: 'https://example.com/',
    identity: 'any',
  }

  it('lowercases declared hosts', () => {
    expect(validateMeta({ ...base, domains: ['Example.COM'] }).domains).toEqual(['example.com'])
  })

  it('rejects a wildcard host', () => {
    expect(() => validateMeta({ ...base, domains: ['*.example.com'] })).toThrow(/exact hostnames/)
    expect(() => validateMeta({ ...base, domains: ['.example.com'] })).toThrow(/exact hostnames/)
  })

  it('rejects an entry host that is not declared', () => {
    expect(() => validateMeta({ ...base, entry: 'https://other.com/' })).toThrow(/not in meta.domains/)
  })

  it('rejects a plaintext entry', () => {
    expect(() => validateMeta({ ...base, entry: 'http://example.com/' })).toThrow(/must be https/)
  })

  it('rejects an unknown identity', () => {
    expect(() => validateMeta({ ...base, identity: 'root' })).toThrow(/meta.identity/)
  })
})

// Some sites only render results on a real navigation (Google answers a fetch
// for its own result page with a redirect interstitial), and a recipe cannot
// navigate once it is running.
describe('entry templates', () => {
  const templated = {
    id: 'example/search',
    summary: 'Searches the things.',
    domains: ['example.com'],
    entry: 'https://example.com/search?q={query}&n={limit}',
    identity: 'any',
    args: [
      { name: 'query', type: 'string', required: true },
      { name: 'limit', type: 'number', default: 10, max: 50 },
    ],
  }

  it('interpolates declared arguments, url-encoded', () => {
    const meta = validateMeta(templated)
    expect(resolveEntry(meta, coerceArgs(meta, { query: 'a b/c&d' })))
      .toBe('https://example.com/search?q=a%20b%2Fc%26d&n=10')
  })

  it('drops a placeholder whose optional argument was omitted', () => {
    const meta = validateMeta({ ...templated, args: [{ name: 'query', type: 'string' }, ...templated.args.slice(1)] })
    expect(resolveEntry(meta, coerceArgs(meta, {}))).toBe('https://example.com/search?q=&n=10')
  })

  it('rejects a placeholder that is not a declared argument', () => {
    expect(() => validateMeta({ ...templated, entry: 'https://example.com/s?q={nope}' }))
      .toThrow(/not a declared argument/)
  })

  // An argument-controlled host would let a caller point a reviewed recipe at
  // any site, with that profile's cookies.
  it('refuses to interpolate the host', () => {
    expect(() => validateMeta({
      ...templated,
      entry: 'https://{query}.example.com/',
      domains: ['example.com'],
    })).toThrow(/may not interpolate the host/)
  })

  it('still checks the host against meta.domains', () => {
    expect(() => validateMeta({ ...templated, entry: 'https://other.com/search?q={query}' }))
      .toThrow(/not in meta.domains/)
  })
})

describe('coerceArgs', () => {
  const meta = readMeta(GOOD)

  it('fills declared defaults', () => {
    expect(coerceArgs(meta, {})).toEqual({ limit: 10 })
  })

  it('coerces a string from the command line', () => {
    expect(coerceArgs(meta, { limit: '5' })).toEqual({ limit: 5 })
  })

  it('rejects a value over the declared cap instead of clamping it', () => {
    expect(() => coerceArgs(meta, { limit: 500 })).toThrow(/capped at 50/)
  })

  // The usual cause is a typo, and dropping it silently produces a
  // plausible-looking answer to the wrong question.
  it('rejects an argument the recipe never declared', () => {
    expect(() => coerceArgs(meta, { limitt: 5 })).toThrow(/unknown argument/)
  })

  it('rejects a missing required argument', () => {
    const required = validateMeta({
      id: 'example/search', summary: 'Searches things.', domains: ['example.com'],
      entry: 'https://example.com/', identity: 'any',
      args: [{ name: 'query', type: 'string', required: true }],
    })
    expect(() => coerceArgs(required, {})).toThrow(/is required/)
    expect(coerceArgs(required, { query: 'x' })).toEqual({ query: 'x' })
  })
})

describe('buildRunnerExpression', () => {
  // Playwright drops the `arg` for a string page function, so the payload has
  // to travel inside the expression or the recipe runs with no arguments and
  // returns nothing.
  it('carries the payload inside the expression', () => {
    const expression = buildRunnerExpression(GOOD, { args: { limit: 7 }, profileName: 'p1', timeoutMs: 5000 })
    expect(expression).toContain('const payload = {"args":{"limit":7},"profileName":"p1","timeoutMs":5000}')
    expect(expression.startsWith('(async () => {')).toBe(true)
    expect(expression.endsWith('})()')).toBe(true)
  })

  it('strips only the two allowed exports', () => {
    expect(stripExports(GOOD)).toContain('const meta =')
    expect(stripExports(GOOD)).toContain('async function run')
    expect(stripExports(GOOD)).not.toContain('export')
  })

  // A recipe declaring `ctx` or `payload` at top level would otherwise be a
  // syntax error at run time, on a user's machine, in a file we did not write.
  it('survives a recipe that declares the runtime own names', async () => {
    const colliding = `export const meta = ${JSON.stringify({
      id: 'example/list', summary: 'Lists the things.', domains: ['example.com'],
      entry: 'https://example.com/', identity: 'any',
    })}
const ctx = 'mine'
const payload = 'mine too'
export async function run(c, a) { return { ctx, payload, name: c.profileName, a } }`
    const value = eval(buildRunnerExpression(colliding, {
      args: { q: 1 }, profileName: 'p1', timeoutMs: 0,
    })) as Promise<unknown>
    await expect(value).resolves.toEqual({
      ctx: 'mine', payload: 'mine too', name: 'p1', a: { q: 1 },
    })
  })

  it('refuses a file that exports no run()', async () => {
    const value = eval(buildRunnerExpression('export const meta = {}\nconst run = 5', {
      args: {}, profileName: 'p1', timeoutMs: 0,
    })) as Promise<unknown>
    await expect(value).rejects.toThrow(/exports no run/)
  })
})

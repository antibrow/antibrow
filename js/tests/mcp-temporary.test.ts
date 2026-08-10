import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mcpRootOptions } from '../src/mcp'

describe('mcpRootOptions', () => {
  it('defaults to the managed tree', () => {
    expect(mcpRootOptions(undefined)).toEqual({ temporary: false })
    expect(mcpRootOptions({})).toEqual({ temporary: false })
  })

  it('reads the temporary flag', () => {
    expect(mcpRootOptions({ temporary: true })).toEqual({ temporary: true })
    expect(mcpRootOptions({ temporary: false })).toEqual({ temporary: false })
  })

  it('ignores a non-boolean value rather than guessing', () => {
    expect(mcpRootOptions({ temporary: 'yes' })).toEqual({ temporary: false })
  })
})

// A non-compliant client sending `"temporary": "yes"` must land on the managed
// tree for all four profile tools, not just three - launch_browser used to cast
// `args?.temporary` directly, so it alone treated "yes" as truthy and opened a
// session in the tree the other three tools weren't looking at. Source-scanned
// because the four handlers aren't independently exported for a black-box call.
describe('mcpRootOptions is the only interpreter of `temporary` in mcp.ts', () => {
  const mcpSource = readFileSync(fileURLToPath(new URL('../src/mcp.ts', import.meta.url)), 'utf8')

  it('launch_browser, list_profiles, create_profile and delete_profile all route through mcpRootOptions(args)', () => {
    const callSites = mcpSource.match(/mcpRootOptions\(args\)/g) ?? []
    expect(callSites.length).toBe(4)
  })

  it('never casts args.temporary directly, bypassing the shared normalizer', () => {
    expect(mcpSource).not.toMatch(/args\?\.temporary\s+as\s+boolean/)
  })
})

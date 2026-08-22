import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8')

// A static import of the MCP SDK puts it back in the install tree for every
// consumer: it drags in a whole HTTP server stack (~90 packages) that only
// `--mcp` ever runs.
describe('mcp sdk stays optional', () => {
  const pkg = JSON.parse(read('package.json'))

  it('is not a hard dependency', () => {
    expect(pkg.dependencies).not.toHaveProperty('@modelcontextprotocol/sdk')
    expect(pkg.peerDependenciesMeta['@modelcontextprotocol/sdk'].optional).toBe(true)
  })

  it('is only imported lazily', () => {
    for (const line of read('src/mcp.ts').split('\n')) {
      if (line.includes('@modelcontextprotocol/sdk')) {
        expect(line, line.trim()).not.toMatch(/^\s*import\s/)
      }
    }
  })
})

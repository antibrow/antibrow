import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

/**
 * The body of one top-level `export interface`. The retired options this file
 * guards against were all fields of `LaunchOptions`, and scanning the whole of
 * types.ts for their names cannot tell that apart from an unrelated declaration
 * that happens to share one: `ProfileConfig.kernelVersion` (the kernel a synced
 * profile runs, which has to travel to a machine that has never opened it) reads
 * as the retired `LaunchOptions.kernelVersion` to a file-wide regex.
 */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`)
  // A rename would otherwise leave every assertion below passing against an
  // empty string - a guard that guards nothing.
  expect(start, `interface ${name} not found in types.ts`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n}', start)
  expect(end, `interface ${name} is unterminated`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('engine SDK cutover guards', () => {
  it('does not expose or depend on the retired dual-kernel engine', () => {
    expect(read('src/browser.ts')).not.toMatch(/KernelManager|createEngine|resolveLaunchConfig/)
    expect(existsSync(join(root, 'src/engine/chromium.ts'))).toBe(false)
    expect(existsSync(join(root, 'src/engine/firefox.ts'))).toBe(false)
    expect(existsSync(join(root, 'src/engine/factory.ts'))).toBe(false)
  })

  it('removes legacy fingerprint/kernel launch options from public types', () => {
    const types = read('src/types.ts')
    const launchOptions = interfaceBody(types, 'LaunchOptions')
    for (const retired of [/fingerprint\??:/, /kernel\??:/, /kernelVersion\??:/, /\bos\??:/]) {
      expect(launchOptions).not.toMatch(retired)
    }
    // The dual-kernel filter type is gone outright, so this one stays file-wide.
    expect(types).not.toContain('FingerprintFilter')
  })

  it('targets win32 + linux + darwin and does not ship old kernel dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as Record<string, unknown>
    // The kernel ships win64 + linux64 + mac-universal builds.
    expect(pkg.os).toEqual(['win32', 'linux', 'darwin'])
    const deps = pkg.dependencies as Record<string, string>
    expect(deps['camoufox-js']).toBeUndefined()
  })
})

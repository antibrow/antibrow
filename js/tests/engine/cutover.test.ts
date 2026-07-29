import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
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
    expect(types).not.toMatch(/fingerprint\??:/)
    expect(types).not.toMatch(/kernel\??:/)
    expect(types).not.toMatch(/kernelVersion\??:/)
    expect(types).not.toMatch(/\bos\??:/)
    expect(types).not.toContain('FingerprintFilter')
  })

  it('targets win32 + linux and does not ship old kernel dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as Record<string, unknown>
    // The kernel ships win64 + linux64 builds.
    expect(pkg.os).toEqual(['win32', 'linux'])
    const deps = pkg.dependencies as Record<string, string>
    expect(deps['camoufox-js']).toBeUndefined()
  })
})

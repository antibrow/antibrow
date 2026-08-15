import { describe, it, expect } from 'vitest'
import { registerKernelVersions, allKernelVersions, KERNEL_VERSIONS, currentPlatform } from '../../src/engine/downloader'

// The remote manifest is mirrored append-style: a major can carry two full
// version rows (an earlier patch and a later one) at once, both present in
// the same refresh. registerKernelVersions must land on the newer row's
// build regardless of which order it saw the rows in - a caller cannot be
// trusted to sort, and even the one caller that does (fetchRemoteKernelVersions)
// only sorts within its own return value, not against what was registered before.
const plat = currentPlatform()

function row(fullVersion: string, build: string, url: string) {
  return {
    version: fullVersion,
    label: 'Chrome 861',
    platforms: { [plat]: { downloadUrl: url, exeRelPath: 'chrome.exe', build, sourceVersion: fullVersion } },
  }
}

describe('registerKernelVersions merge is order-independent on full version', () => {
  it('newest-first: the registered build is the newest row\'s', () => {
    registerKernelVersions([
      row('861.0.0.10', '2026-08-15', 'https://x/new.zip'),
      row('861.0.0.9', '2026-08-10c', 'https://x/old.zip'),
    ])
    const kv = allKernelVersions().find((k) => k.version === '861')
    expect(kv?.platforms[plat]?.build).toBe('2026-08-15')
    expect(kv?.platforms[plat]?.downloadUrl).toBe('https://x/new.zip')
  })

  it('oldest-first: same result - the fix must not depend on caller sort order', () => {
    registerKernelVersions([
      row('862.0.0.9', '2026-08-10c', 'https://x/old.zip'),
      row('862.0.0.10', '2026-08-15', 'https://x/new.zip'),
    ])
    const kv = allKernelVersions().find((k) => k.version === '862')
    expect(kv?.platforms[plat]?.build).toBe('2026-08-15')
    expect(kv?.platforms[plat]?.downloadUrl).toBe('https://x/new.zip')
  })

  it('a later refresh with a newer build for the SAME full version updates it', () => {
    registerKernelVersions([row('863.0.0.9', '2026-08-10c', 'https://x/a.zip')])
    registerKernelVersions([row('863.0.0.9', '2026-08-15', 'https://x/a.zip')])
    const kv = allKernelVersions().find((k) => k.version === '863')
    expect(kv?.platforms[plat]?.build).toBe('2026-08-15')
  })

  // Choice: build is an opaque freshness marker we cannot validate, so a
  // refresh that carries an older-looking build for a full version we already
  // recorded a newer build for is treated as stale data and ignored rather
  // than applied. Silently walking a known-good build backwards would make
  // "update available" flap based on manifest race/anomaly, not a real change.
  it('a later refresh with an older build for the SAME full version does not downgrade it', () => {
    registerKernelVersions([row('864.0.0.9', '2026-08-15', 'https://x/a.zip')])
    registerKernelVersions([row('864.0.0.9', '2026-08-10c', 'https://x/a.zip')])
    const kv = allKernelVersions().find((k) => k.version === '864')
    expect(kv?.platforms[plat]?.build).toBe('2026-08-15')
  })

  it('baseline URLs still win over remote ones for the same version and platform', () => {
    const baselineVersion = KERNEL_VERSIONS[0].version
    const baselineUrl = KERNEL_VERSIONS[0].platforms[plat]?.downloadUrl
    expect(baselineUrl).toBeTruthy()

    registerKernelVersions([
      { version: `${baselineVersion}.9.9.9`, label: 'x', platforms: { [plat]: { downloadUrl: 'https://x/remote.zip', exeRelPath: 'chrome.exe', build: '2026-08-15' } } },
    ])

    const kv = allKernelVersions().find((k) => k.version === baselineVersion)
    expect(kv?.platforms[plat]?.downloadUrl).toBe(baselineUrl)
    expect(kv?.platforms[plat]?.build).toBe('2026-08-15')
  })
})

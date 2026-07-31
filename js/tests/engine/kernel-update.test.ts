import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  registerKernelVersions,
  findKernelVersion,
  kernelExePath,
  writeInstalledKernelBuild,
  installedKernelBuild,
  kernelUpdateStatus,
  installedKernelUpdates,
} from '../../src/engine/downloader'

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** "Install" a kernel version on disk (exe present) so isKernelInstalled is true. */
function install(cache: string, version: string): void {
  const kv = findKernelVersion(version)
  const exe = kernelExePath(cache, kv)
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'MZ')
}

// A runtime-registered version (built for all three platforms) with a known
// build, so the test works on win32, linux and darwin. Unique version → no
// cross-test bleed.
const TEST_VERSION = '199.0.0.1'
registerKernelVersions([
  {
    version: TEST_VERSION,
    label: 'Chrome 199 (test)',
    platforms: {
      win32: { downloadUrl: 'https://example.test/x-win64.zip', exeRelPath: 'chrome.exe', build: '2026-07-24 10:00' },
      linux: { downloadUrl: 'https://example.test/x-linux64.zip', exeRelPath: 'chrome', build: '2026-07-24 10:00' },
      darwin: { downloadUrl: 'https://example.test/x-mac-universal.zip', exeRelPath: 'Chromium.app/Contents/MacOS/Chromium', build: '2026-07-24 10:00' },
    },
  },
])

describe('kernel update detection', () => {
  it('returns null for a not-installed version', () => {
    const cache = tmp('kupd-')
    expect(kernelUpdateStatus(cache, TEST_VERSION)).toBeNull()
    expect(installedKernelUpdates(cache)).toEqual([])
  })

  it('flags no update when the installed build matches the published build', () => {
    const cache = tmp('kupd-')
    install(cache, TEST_VERSION)
    writeInstalledKernelBuild(cache, TEST_VERSION, '2026-07-24 10:00')

    const s = kernelUpdateStatus(cache, TEST_VERSION)
    expect(s).toMatchObject({ version: TEST_VERSION, installed: true, updateAvailable: false })
    expect(installedKernelUpdates(cache).some((u) => u.updateAvailable)).toBe(false)
  })

  it('flags an update when the published build is newer than the installed one', () => {
    const cache = tmp('kupd-')
    install(cache, TEST_VERSION)
    writeInstalledKernelBuild(cache, TEST_VERSION, '2026-07-20 08:00') // older

    const s = kernelUpdateStatus(cache, TEST_VERSION)
    expect(s).toMatchObject({
      version: TEST_VERSION,
      installedBuild: '2026-07-20 08:00',
      availableBuild: '2026-07-24 10:00',
      updateAvailable: true,
    })
    expect(installedKernelUpdates(cache).find((u) => u.version === TEST_VERSION)?.updateAvailable).toBe(true)
  })

  it('adopts the current build (no nag) for a legacy install with no build marker', () => {
    const cache = tmp('kupd-')
    install(cache, TEST_VERSION) // no build marker written

    const s = kernelUpdateStatus(cache, TEST_VERSION)
    expect(s?.updateAvailable).toBe(false)
    // adoption persisted the current build so a future real bump is detectable
    expect(installedKernelBuild(cache, TEST_VERSION)).toBe('2026-07-24 10:00')
  })
})

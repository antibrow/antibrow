import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  registerKernelVersions,
  findKernelVersion,
  kernelExePath,
  writeInstalledKernelBuild,
  newerKernelThan,
} from '../../src/engine/downloader'
import { noticeNewerKernel } from '../../src/engine/index'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knewer-'))
}

function install(cache: string, version: string, build: string): void {
  const exe = kernelExePath(cache, findKernelVersion(version))
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'MZ')
  writeInstalledKernelBuild(cache, version, build)
}

const asset = (build: string) => ({
  win32: { downloadUrl: 'https://example.test/a.zip', exeRelPath: 'chrome.exe', build },
  linux: { downloadUrl: 'https://example.test/a.zip', exeRelPath: 'chrome', build },
  darwin: { downloadUrl: 'https://example.test/a.zip', exeRelPath: 'Chromium.app/Contents/MacOS/Chromium', build },
})

registerKernelVersions([
  { version: '196', label: 'Chrome 196', platforms: asset('2026-10-22') },
  { version: '197', label: 'Chrome 197', platforms: asset('2026-10-22') },
])

describe('newerKernelThan', () => {
  it('reports nothing for the newest kernel on its latest build', () => {
    const cache = tmp()
    install(cache, '197', '2026-10-22')
    expect(newerKernelThan(cache, '197')).toEqual({})
  })

  it('reports a newer build of the installed version', () => {
    const cache = tmp()
    install(cache, '197', '2026-10-14')
    expect(newerKernelThan(cache, '197')).toEqual({ build: { installed: '2026-10-14', available: '2026-10-22' } })
  })

  it('reports a newer version even when this one is not installed yet', () => {
    expect(newerKernelThan(tmp(), '196')).toEqual({ version: '197' })
  })
})

describe('noticeNewerKernel', () => {
  it('says each finding once per process', () => {
    const cache = tmp()
    install(cache, '196', '2026-10-01')
    const seen: string[] = []
    const opts = { onNotice: (m: string) => seen.push(m) }
    noticeNewerKernel(cache, findKernelVersion('196'), opts)
    noticeNewerKernel(cache, findKernelVersion('196'), opts)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain('updateKernelBeforeLaunch: true')
    expect(seen[1]).toContain('Chrome 197 is available')
  })

  it('skips the build notice when the launch is about to update anyway', () => {
    const cache = tmp()
    install(cache, '197', '2026-09-01')
    const seen: string[] = []
    noticeNewerKernel(cache, findKernelVersion('197'), { updateKernelBeforeLaunch: true, onNotice: (m) => seen.push(m) })
    expect(seen).toEqual([])
  })
})

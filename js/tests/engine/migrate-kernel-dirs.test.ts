import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyKernelDirs, KERNEL_VERSION_CACHE_FILE } from '../../src/engine/downloader'

let cacheDir: string

function makeKernel(name: string, build: string): string {
  const dir = path.join(cacheDir, 'kernels', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.fp-build'), build, 'utf8')
  fs.writeFileSync(path.join(dir, 'chrome.exe'), 'binary', 'utf8')
  return dir
}

const kernels = (): string[] => fs.readdirSync(path.join(cacheDir, 'kernels')).sort()

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-migrate-'))
})

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

describe('migrateLegacyKernelDirs', () => {
  it('renames a legacy dir to its major and keeps the build marker', () => {
    makeKernel('150.0.0.0', '2026-08-10')
    migrateLegacyKernelDirs(cacheDir)
    expect(kernels()).toEqual(['150'])
    expect(fs.readFileSync(path.join(cacheDir, 'kernels', '150', '.fp-build'), 'utf8')).toBe('2026-08-10')
    expect(fs.existsSync(path.join(cacheDir, 'kernels', '150', 'chrome.exe'))).toBe(true)
  })

  it('drops the legacy dir when the major dir already exists', () => {
    makeKernel('150', 'new')
    makeKernel('150.0.0.0', 'old')
    migrateLegacyKernelDirs(cacheDir)
    expect(kernels()).toEqual(['150'])
    expect(fs.readFileSync(path.join(cacheDir, 'kernels', '150', '.fp-build'), 'utf8')).toBe('new')
  })

  // The tails are 9 and 10 so numeric and string order disagree: sorted as text,
  // "150.0.0.9" wins and the older build is the one that survives.
  it('keeps the newest of several legacy dirs sharing a major', () => {
    makeKernel('150.0.0.9', 'older')
    makeKernel('150.0.0.10', 'newer')
    migrateLegacyKernelDirs(cacheDir)
    expect(kernels()).toEqual(['150'])
    expect(fs.readFileSync(path.join(cacheDir, 'kernels', '150', '.fp-build'), 'utf8')).toBe('newer')
  })

  // The one invariant of a migration that moves 190-320MB: a rename it could not
  // perform must never be followed by a delete, or the only copy is gone and an
  // offline machine has no kernel at all.
  it('deletes nothing when the rename fails', () => {
    makeKernel('150.0.0.9', 'older')
    makeKernel('150.0.0.10', 'newer')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EACCES: locked') })
    const rm = vi.spyOn(fs, 'rmSync')
    try {
      migrateLegacyKernelDirs(cacheDir)
      expect(rename).toHaveBeenCalledTimes(1)
      expect(rm).not.toHaveBeenCalled()
      expect(kernels()).toEqual(['150.0.0.10', '150.0.0.9'])
    } finally {
      rename.mockRestore()
      rm.mockRestore()
    }
  })

  it('migrates each major independently and is idempotent', () => {
    makeKernel('149.0.0.0', 'a')
    makeKernel('151.0.0.0', 'b')
    migrateLegacyKernelDirs(cacheDir)
    migrateLegacyKernelDirs(cacheDir)
    expect(kernels()).toEqual(['149', '151'])
  })

  it('does nothing when there is no kernels dir', () => {
    expect(() => migrateLegacyKernelDirs(cacheDir)).not.toThrow()
  })

  it('leaves the old shared catalogue cache for older clients on this machine', () => {
    const legacy = path.join(cacheDir, 'kernel-versions-cache.json')
    fs.writeFileSync(legacy, '[]', 'utf8')
    migrateLegacyKernelDirs(cacheDir)
    expect(fs.existsSync(legacy)).toBe(true)
    expect(KERNEL_VERSION_CACHE_FILE).toBe('kernel-catalog-cache.json')
  })
})

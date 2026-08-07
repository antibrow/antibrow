import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getProfileDir,
  getProfilesDir,
  createTempProfileDir,
  listProfiles,
  profileExists,
  ensureCacheDir,
} from '../src/profile'
import { readProfileMeta } from '../src/engine/profile-dir'

describe('profile management', () => {
  const testCacheDir = join(tmpdir(), `anti-detect-test-${Date.now()}`)

  beforeEach(() => {
    if (!existsSync(testCacheDir)) {
      mkdirSync(testCacheDir, { recursive: true })
    }
  })

  afterEach(() => {
    try {
      rmSync(testCacheDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe('getProfilesDir', () => {
    it('should return profiles subdirectory of cache dir', () => {
      const dir = getProfilesDir(testCacheDir)
      expect(dir).toContain('profiles')
      expect(dir.startsWith(testCacheDir)).toBe(true)
    })
  })

  describe('getProfileDir', () => {
    it('creates an id-named directory carrying the profile name', () => {
      const dir = getProfileDir('gmail', testCacheDir)
      expect(dir.startsWith(join(testCacheDir, 'profiles'))).toBe(true)
      expect(basename(dir)).not.toBe('gmail')
      expect(readProfileMeta(dir)?.name).toBe('gmail')
      expect(getProfileDir('gmail', testCacheDir)).toBe(dir)   // stable across calls
    })
  })

  describe('createTempProfileDir', () => {
    it('should create a new unique directory each time', () => {
      const dir1 = createTempProfileDir(testCacheDir)
      const dir2 = createTempProfileDir(testCacheDir)
      expect(dir1).not.toBe(dir2)
      expect(existsSync(dir1)).toBe(true)
      expect(existsSync(dir2)).toBe(true)
    })

    it('should create directory under temp subdirectory', () => {
      const dir = createTempProfileDir(testCacheDir)
      expect(dir).toContain('temp')
    })
  })

  describe('listProfiles', () => {
    it('lists profile names, not directory names', () => {
      getProfileDir('gmail', testCacheDir)
      getProfileDir('a@b.com', testCacheDir)
      expect(listProfiles(testCacheDir).sort()).toEqual(['a@b.com', 'gmail'])
    })

    it('should return empty array when no profiles exist', () => {
      const profiles = listProfiles(testCacheDir)
      expect(profiles).toEqual([])
    })

    it('should handle non-existent cache directory', () => {
      const profiles = listProfiles('/non/existent/path')
      expect(profiles).toEqual([])
    })
  })

  describe('profileExists', () => {
    it('reports existence by name', () => {
      getProfileDir('gmail', testCacheDir)
      expect(profileExists('gmail', testCacheDir)).toBe(true)
      expect(profileExists('nope', testCacheDir)).toBe(false)
    })
  })

  describe('ensureCacheDir', () => {
    it('should create directory if it does not exist', () => {
      const dir = join(testCacheDir, 'new-cache')
      const result = ensureCacheDir(dir)
      expect(existsSync(result)).toBe(true)
      expect(result).toBe(dir)
    })

    it('should not throw if directory already exists', () => {
      const result = ensureCacheDir(testCacheDir)
      expect(existsSync(result)).toBe(true)
    })
  })
})

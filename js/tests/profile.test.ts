import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getProfileDir,
  getProfilesDir,
  createTempProfileDir,
  listProfiles,
  profileExists,
  ensureCacheDir,
} from '../src/profile'

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
    it('should create profile directory if it does not exist', () => {
      const dir = getProfileDir('test-profile', testCacheDir)
      expect(existsSync(dir)).toBe(true)
      expect(dir).toContain('test-profile')
    })

    it('should return same directory on repeated calls', () => {
      const dir1 = getProfileDir('my-profile', testCacheDir)
      const dir2 = getProfileDir('my-profile', testCacheDir)
      expect(dir1).toBe(dir2)
    })

    it('should throw on empty profile name', () => {
      expect(() => getProfileDir('', testCacheDir)).toThrow('Profile name is required')
    })

    it('should sanitize profile names with special characters', () => {
      const dir = getProfileDir('user:account/test', testCacheDir)
      // The profile directory name itself should not contain special characters
      // (the full path may contain : and / on Windows/Unix respectively)
      const profileDirName = dir.split(/[\\/]/).pop() || ''
      expect(profileDirName).not.toContain(':')
      expect(profileDirName).not.toContain('/')
      expect(existsSync(dir)).toBe(true)
    })

    it('should prevent path traversal', () => {
      const dir = getProfileDir('../../../etc/passwd', testCacheDir)
      expect(dir).not.toContain('..')
      expect(dir.startsWith(join(testCacheDir, 'profiles'))).toBe(true)
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
    it('should return empty array when no profiles exist', () => {
      const profiles = listProfiles(testCacheDir)
      expect(profiles).toEqual([])
    })

    it('should list created profiles', () => {
      getProfileDir('profile-a', testCacheDir)
      getProfileDir('profile-b', testCacheDir)
      getProfileDir('profile-c', testCacheDir)

      const profiles = listProfiles(testCacheDir)
      expect(profiles).toContain('profile-a')
      expect(profiles).toContain('profile-b')
      expect(profiles).toContain('profile-c')
      expect(profiles.length).toBe(3)
    })

    it('should handle non-existent cache directory', () => {
      const profiles = listProfiles('/non/existent/path')
      expect(profiles).toEqual([])
    })
  })

  describe('profileExists', () => {
    it('should return false for non-existent profile', () => {
      expect(profileExists('nonexistent', testCacheDir)).toBe(false)
    })

    it('should return true for existing profile', () => {
      getProfileDir('existing-profile', testCacheDir)
      expect(profileExists('existing-profile', testCacheDir)).toBe(true)
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

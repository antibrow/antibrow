import { mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_CACHE_DIR = join(homedir(), '.anti-detect-browser')
const PROFILES_DIR = 'profiles'

/** The profiles root directory. */
export function getProfilesDir(cacheDir?: string): string {
  const base = cacheDir || DEFAULT_CACHE_DIR
  return resolve(base, PROFILES_DIR)
}

/** Get or create a profile's user data directory. */
export function getProfileDir(profileName: string, cacheDir?: string): string {
  if (!profileName) {
    throw new Error('Profile name is required')
  }

  // Sanitize the name to prevent path traversal.
  const sanitized = profileName
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.\./g, '_')
    .trim()

  if (!sanitized) {
    throw new Error('Invalid profile name after sanitization')
  }

  const profileDir = join(getProfilesDir(cacheDir), sanitized)

  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true })
  }

  return profileDir
}

/** A temporary user data directory for non-persistent sessions. */
export function createTempProfileDir(cacheDir?: string): string {
  const base = cacheDir || DEFAULT_CACHE_DIR
  const tempDir = join(base, 'temp', `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)

  mkdirSync(tempDir, { recursive: true })
  return tempDir
}

/** All existing profile names. */
export function listProfiles(cacheDir?: string): string[] {
  const profilesDir = getProfilesDir(cacheDir)

  if (!existsSync(profilesDir)) {
    return []
  }

  return readdirSync(profilesDir).filter(name => {
    const fullPath = join(profilesDir, name)
    try {
      return statSync(fullPath).isDirectory()
    } catch {
      return false
    }
  })
}

/** Whether a profile directory exists. */
export function profileExists(profileName: string, cacheDir?: string): boolean {
  const sanitized = profileName
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.\./g, '_')
    .trim()

  const profileDir = join(getProfilesDir(cacheDir), sanitized)
  return existsSync(profileDir)
}

/** The cache directory, created if needed. */
export function ensureCacheDir(cacheDir?: string): string {
  const dir = cacheDir || DEFAULT_CACHE_DIR
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

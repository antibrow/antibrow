import { mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveProfileDirSync, listProfileEntries } from './engine/profile-dir'

const DEFAULT_CACHE_DIR = join(homedir(), '.anti-detect-browser')
const PROFILES_DIR = 'profiles'

/** The profiles root directory. */
export function getProfilesDir(cacheDir?: string): string {
  const base = cacheDir || DEFAULT_CACHE_DIR
  return resolve(base, PROFILES_DIR)
}

/** Get or create a profile's user data directory. */
export function getProfileDir(profileName: string, cacheDir?: string): string {
  const dir = resolveProfileDirSync(cacheDir || DEFAULT_CACHE_DIR, profileName).dir
  mkdirSync(dir, { recursive: true })
  return dir
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
  return listProfileEntries(cacheDir || DEFAULT_CACHE_DIR).map((e) => e.name)
}

/** Whether a profile with this name exists. */
export function profileExists(profileName: string, cacheDir?: string): boolean {
  return listProfileEntries(cacheDir || DEFAULT_CACHE_DIR).some((e) => e.name === profileName)
}

/** The cache directory, created if needed. */
export function ensureCacheDir(cacheDir?: string): string {
  const dir = cacheDir || DEFAULT_CACHE_DIR
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export { listProfileEntries } from './engine/profile-dir'

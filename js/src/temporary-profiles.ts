import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { listProfileEntries } from './engine/profile-dir'

const DEFAULT_CACHE_DIR = path.join(homedir(), '.anti-detect-browser')

export interface ClearTemporaryOptions {
  /** Keep profiles used within this many days. Unset deletes all of them. */
  olderThanDays?: number
  /** Report what would go, delete nothing. */
  dryRun?: boolean
  /** Absolute directories to leave alone, e.g. a session still running. */
  skipDirs?: string[]
}

export interface ClearedTemporaryProfile {
  name: string
  dir: string
  bytes: number
}

/** When the kernel last wrote to this profile. */
export function temporaryProfileLastUsed(dir: string): number {
  try {
    return fs.statSync(path.join(dir, 'user-data')).mtimeMs
  } catch {
    try {
      return fs.statSync(dir).mtimeMs
    } catch {
      return 0
    }
  }
}

function dirSize(dir: string): number {
  let total = 0
  let items: fs.Dirent[]
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const item of items) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      total += dirSize(full)
    } else {
      try {
        total += fs.statSync(full).size
      } catch { /* raced with a delete */ }
    }
  }
  return total
}

/**
 * Delete temporary profiles. Only ever reads the temporary tree, so a managed
 * profile sharing a name with a temporary one is never at risk.
 *
 * No process check is possible across processes: call this when nothing is
 * running, or pass live directories in `skipDirs`.
 */
export function clearTemporaryProfiles(
  cacheDir?: string,
  opts?: ClearTemporaryOptions,
): ClearedTemporaryProfile[] {
  const root = cacheDir || DEFAULT_CACHE_DIR
  const skip = new Set((opts?.skipDirs ?? []).map((d) => path.resolve(d)))
  const cutoff = opts?.olderThanDays === undefined
    ? undefined
    : Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000

  const cleared: ClearedTemporaryProfile[] = []
  for (const entry of listProfileEntries(root, { temporary: true })) {
    if (skip.has(path.resolve(entry.dir))) continue
    if (cutoff !== undefined && temporaryProfileLastUsed(entry.dir) > cutoff) continue
    const bytes = dirSize(entry.dir)
    if (!opts?.dryRun) {
      // A lingering lock (Windows) or a permission error must not abort the
      // sweep, and an entry we failed to remove must not be reported as gone.
      try {
        fs.rmSync(entry.dir, { recursive: true, force: true })
      } catch {
        continue
      }
    }
    cleared.push({ name: entry.name, dir: entry.dir, bytes })
  }
  return cleared
}

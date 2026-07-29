import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { existsSync } from 'node:fs'

/** Extract per-site permission grants from Chrome's Preferences file. */
export async function extractPermissions(profileDir: string): Promise<Record<string, unknown> | null> {
  const prefsPath = join(profileDir, 'Default', 'Preferences')
  if (!existsSync(prefsPath)) return null

  try {
    const raw = await readFile(prefsPath, 'utf-8')
    const prefs = JSON.parse(raw)
    const exceptions = prefs?.profile?.content_settings?.exceptions
    if (!exceptions || typeof exceptions !== 'object') return null
    if (Object.keys(exceptions).length === 0) return null
    return exceptions
  } catch {
    return null
  }
}

/** Restore site permissions. Must run before the browser starts. */
export async function restorePermissions(profileDir: string, permissions: Record<string, unknown>): Promise<void> {
  const defaultDir = join(profileDir, 'Default')
  const prefsPath = join(defaultDir, 'Preferences')

  let prefs: Record<string, unknown> = {}
  if (existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(await readFile(prefsPath, 'utf-8'))
    } catch {
      prefs = {}
    }
  } else {
    await mkdir(defaultDir, { recursive: true })
  }

  if (!prefs.profile || typeof prefs.profile !== 'object') {
    prefs.profile = {}
  }
  const profile = prefs.profile as Record<string, unknown>

  if (!profile.content_settings || typeof profile.content_settings !== 'object') {
    profile.content_settings = {}
  }
  const cs = profile.content_settings as Record<string, unknown>

  // Server entries fill gaps; local ones win.
  const existing = (cs.exceptions || {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(permissions)) {
    if (!(key in existing)) {
      existing[key] = value
    }
  }
  cs.exceptions = existing

  await writeFile(prefsPath, JSON.stringify(prefs))
}

/** Archive a directory into a gzipped, base64-encoded JSON bundle. */
export async function archiveDirectory(dirPath: string): Promise<string | null> {
  if (!existsSync(dirPath)) return null

  const files: Record<string, string> = {}
  await walkDir(dirPath, dirPath, files)

  if (Object.keys(files).length === 0) return null

  const json = JSON.stringify(files)
  const compressed = gzipSync(Buffer.from(json))
  return compressed.toString('base64')
}

/** Restore a directory from a gzipped, base64-encoded JSON bundle. */
export async function restoreDirectory(dirPath: string, archive: string): Promise<void> {
  const compressed = Buffer.from(archive, 'base64')
  const json = gunzipSync(compressed).toString()
  const files: Record<string, string> = JSON.parse(json)

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dirPath, relativePath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, Buffer.from(content, 'base64'))
  }
}

const SKIP_FILES = new Set(['LOCK', 'lock', '.lock'])

async function walkDir(dir: string, baseDir: string, files: Record<string, string>): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (SKIP_FILES.has(entry.name)) continue

    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(fullPath, baseDir, files)
    } else if (entry.isFile()) {
      try {
        const content = await readFile(fullPath)
        const relPath = relative(baseDir, fullPath).replace(/\\/g, '/')
        files[relPath] = content.toString('base64')
      } catch {

      }
    }
  }
}

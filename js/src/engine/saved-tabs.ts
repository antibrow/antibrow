import fs from 'node:fs'
import path from 'node:path'

/**
 * The tabs a profile reopens belong to the person who browses in it. A scripted
 * session would otherwise leave behind whatever it ended on (often one blank
 * tab), and the person finds their tabs gone. So a scripted session snapshots
 * them before the kernel starts and puts them back after it exits.
 *
 * The snapshot sits in the profile root, which is never packed. While it exists
 * a restore is owed, so a session that died before putting it back is settled
 * by the next launch of that profile, whoever runs it.
 */
export const SAVED_TABS_DIR = '.saved-tabs'

function sessionsDir(profileDir: string): string {
  return path.join(profileDir, 'user-data', 'Default', 'Sessions')
}

export function snapshotSavedTabs(profileDir: string): void {
  const snapshot = path.join(profileDir, SAVED_TABS_DIR)
  const staging = `${snapshot}.tmp`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  const sessions = sessionsDir(profileDir)
  if (fs.existsSync(sessions)) fs.cpSync(sessions, path.join(staging, 'Sessions'), { recursive: true })
  // Renamed into place only once complete: a half-copied snapshot must never
  // look like one that is owed back.
  fs.rmSync(snapshot, { recursive: true, force: true })
  fs.renameSync(staging, snapshot)
}

export function hasSavedTabsSnapshot(profileDir: string): boolean {
  return fs.existsSync(path.join(profileDir, SAVED_TABS_DIR))
}

/** Put a snapshot back; true when there was one. */
export function restoreSavedTabs(profileDir: string): boolean {
  const snapshot = path.join(profileDir, SAVED_TABS_DIR)
  if (!fs.existsSync(snapshot)) return false
  const sessions = sessionsDir(profileDir)
  fs.rmSync(sessions, { recursive: true, force: true })
  const saved = path.join(snapshot, 'Sessions')
  if (fs.existsSync(saved)) fs.cpSync(saved, sessions, { recursive: true })
  fs.rmSync(snapshot, { recursive: true, force: true })
  return true
}

/** For state replaced from elsewhere (cloud restore, import): an older snapshot must not overwrite it. */
export function dropSavedTabsSnapshot(profileDir: string): void {
  fs.rmSync(path.join(profileDir, SAVED_TABS_DIR), { recursive: true, force: true })
  fs.rmSync(path.join(profileDir, `${SAVED_TABS_DIR}.tmp`), { recursive: true, force: true })
}

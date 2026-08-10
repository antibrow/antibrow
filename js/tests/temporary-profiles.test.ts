import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearTemporaryProfiles } from '../src/temporary-profiles'
import { getProfileDir } from '../src/profile'

let cacheDir: string

function ageDir(dir: string, days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const userData = path.join(dir, 'user-data')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'Local State'), '{}')
  fs.utimesSync(userData, when, when)
}

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-clear-'))
})
afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

describe('clearTemporaryProfiles', () => {
  it('deletes every temporary profile when no age is given', () => {
    const a = getProfileDir('task-1', cacheDir, { temporary: true })
    const b = getProfileDir('task-2', cacheDir, { temporary: true })
    ageDir(a, 0)
    ageDir(b, 30)

    const cleared = clearTemporaryProfiles(cacheDir)

    expect(cleared.map((c) => c.name).sort()).toEqual(['task-1', 'task-2'])
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(false)
  })

  it('keeps profiles used more recently than olderThanDays', () => {
    const fresh = getProfileDir('fresh', cacheDir, { temporary: true })
    const stale = getProfileDir('stale', cacheDir, { temporary: true })
    ageDir(fresh, 2)
    ageDir(stale, 10)

    const cleared = clearTemporaryProfiles(cacheDir, { olderThanDays: 7 })

    expect(cleared.map((c) => c.name)).toEqual(['stale'])
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('reports without deleting in dryRun', () => {
    const dir = getProfileDir('task-1', cacheDir, { temporary: true })
    ageDir(dir, 30)

    const cleared = clearTemporaryProfiles(cacheDir, { dryRun: true })

    expect(cleared.map((c) => c.name)).toEqual(['task-1'])
    expect(cleared[0].bytes).toBeGreaterThan(0)
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('leaves skipped directories alone', () => {
    const live = getProfileDir('live', cacheDir, { temporary: true })
    const dead = getProfileDir('dead', cacheDir, { temporary: true })
    ageDir(live, 30)
    ageDir(dead, 30)

    const cleared = clearTemporaryProfiles(cacheDir, { skipDirs: [live] })

    expect(cleared.map((c) => c.name)).toEqual(['dead'])
    expect(fs.existsSync(live)).toBe(true)
  })

  it('never touches the managed tree', () => {
    const managed = getProfileDir('task-1', cacheDir)
    const temp = getProfileDir('task-1', cacheDir, { temporary: true })
    ageDir(managed, 999)
    ageDir(temp, 999)

    clearTemporaryProfiles(cacheDir)

    expect(fs.existsSync(managed)).toBe(true)
    expect(fs.existsSync(temp)).toBe(false)
  })

  it('returns an empty list when the temporary tree does not exist', () => {
    expect(clearTemporaryProfiles(cacheDir)).toEqual([])
  })

  it('deletes a profile aged exactly olderThanDays (boundary is strictly-newer-survives)', () => {
    const boundary = getProfileDir('boundary', cacheDir, { temporary: true })
    ageDir(boundary, 7)

    const cleared = clearTemporaryProfiles(cacheDir, { olderThanDays: 7 })

    expect(cleared.map((c) => c.name)).toEqual(['boundary'])
    expect(fs.existsSync(boundary)).toBe(false)
  })

  it('continues the sweep and does not report a profile it failed to remove', () => {
    const locked = getProfileDir('locked', cacheDir, { temporary: true })
    const removable = getProfileDir('removable', cacheDir, { temporary: true })
    ageDir(locked, 30)
    ageDir(removable, 30)

    const originalRmSync = fs.rmSync.bind(fs)
    const rmSync = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (path.resolve(target as string) === path.resolve(locked)) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return originalRmSync(target as fs.PathLike, options as fs.RmOptions)
    })

    let cleared: ReturnType<typeof clearTemporaryProfiles>
    expect(() => {
      cleared = clearTemporaryProfiles(cacheDir)
    }).not.toThrow()

    rmSync.mockRestore()

    expect(cleared!.map((c) => c.name)).toEqual(['removable'])
    expect(fs.existsSync(locked)).toBe(true)
    expect(fs.existsSync(removable)).toBe(false)
  })
})

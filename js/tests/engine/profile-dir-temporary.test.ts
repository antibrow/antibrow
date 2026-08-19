import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  profilesRoot,
  listProfileEntries,
  resolveProfileDirSync,
  resolveProfileDir,
  TEMPORARY_PROFILES_DIR,
} from '../../src/engine/profile-dir'

let cacheDir: string

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-temp-root-'))
})
afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

describe('temporary profile root', () => {
  it('defaults to the regular tree', () => {
    expect(profilesRoot(cacheDir)).toBe(path.join(cacheDir, 'profiles'))
    expect(profilesRoot(cacheDir, {})).toBe(path.join(cacheDir, 'profiles'))
    expect(profilesRoot(cacheDir, { temporary: false })).toBe(path.join(cacheDir, 'profiles'))
  })

  it('uses profiles-temp when asked', () => {
    expect(TEMPORARY_PROFILES_DIR).toBe('profiles-temp')
    expect(profilesRoot(cacheDir, { temporary: true })).toBe(path.join(cacheDir, TEMPORARY_PROFILES_DIR))
  })

  it('keeps the two trees as independent namespaces', () => {
    const normal = resolveProfileDirSync(cacheDir, 'gmail')
    const temp = resolveProfileDirSync(cacheDir, 'gmail', { temporary: true })

    expect(temp.dir).not.toBe(normal.dir)
    expect(temp.id).not.toBe(normal.id)
    expect(normal.dir.startsWith(path.join(cacheDir, 'profiles') + path.sep)).toBe(true)
    expect(temp.dir.startsWith(path.join(cacheDir, TEMPORARY_PROFILES_DIR) + path.sep)).toBe(true)
  })

  it('lists each tree separately', () => {
    resolveProfileDirSync(cacheDir, 'real-one')
    resolveProfileDirSync(cacheDir, 'temp-one', { temporary: true })

    expect(listProfileEntries(cacheDir).map((e) => e.name)).toEqual(['real-one'])
    expect(listProfileEntries(cacheDir, { temporary: true }).map((e) => e.name)).toEqual(['temp-one'])
  })

  it('reuses the same directory for a repeated temporary name', () => {
    const first = resolveProfileDirSync(cacheDir, 'task-1', { temporary: true })
    const second = resolveProfileDirSync(cacheDir, 'task-1', { temporary: true })
    expect(second.dir).toBe(first.dir)
    expect(second.id).toBe(first.id)
  })

  it('takes a caller-supplied server id instead of asking again', async () => {
    // launch() has already fetched the row to decide whether a cloud archive
    // exists; asking a second time inside one launch spent the per-profile
    // rate-limit budget twice and turned a normal start into a 429.
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const resolved = await resolveProfileDir({
        cacheDir,
        profileName: 'gmail',
        key: 'adb_test',
        server: 'https://example.invalid',
        serverId: 'cloud-id-1',
      })
      expect(calls).toEqual([])
      expect(resolved.id).toBe('cloud-id-1')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('never asks the server for a temporary profile', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const resolved = await resolveProfileDir({
        cacheDir,
        profileName: 'task-1',
        key: 'adb_test',
        server: 'https://example.invalid',
        temporary: true,
      })
      expect(calls).toEqual([])
      expect(resolved.dir.startsWith(path.join(cacheDir, TEMPORARY_PROFILES_DIR) + path.sep)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SAVED_TABS_DIR, restoreSavedTabs, snapshotSavedTabs } from '../../src/engine/saved-tabs'
import { packProfileCache, unpackProfileCache } from '../../src/engine/profile-cache'

let dir: string
const sessions = () => path.join(dir, 'user-data', 'Default', 'Sessions')
const write = (name: string, body: string) => {
  fs.mkdirSync(sessions(), { recursive: true })
  fs.writeFileSync(path.join(sessions(), name), body)
}
const listing = () => (fs.existsSync(sessions()) ? fs.readdirSync(sessions()).sort() : [])

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-tabs-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('saved tabs', () => {
  it('puts back the tabs a scripted session replaced', () => {
    write('Session_1', 'person')
    write('Tabs_1', 'person')
    snapshotSavedTabs(dir)
    // What the kernel does on exit: a newer session file outranks the old one.
    fs.rmSync(path.join(sessions(), 'Session_1'))
    write('Session_2', 'script')
    expect(restoreSavedTabs(dir)).toBe(true)
    expect(listing()).toEqual(['Session_1', 'Tabs_1'])
    expect(fs.readFileSync(path.join(sessions(), 'Session_1'), 'utf8')).toBe('person')
    expect(fs.existsSync(path.join(dir, SAVED_TABS_DIR))).toBe(false)
  })

  it('leaves a profile that had no saved tabs without any', () => {
    snapshotSavedTabs(dir)
    write('Session_2', 'script')
    restoreSavedTabs(dir)
    expect(listing()).toEqual([])
  })

  it('does nothing when no snapshot is owed', () => {
    write('Session_1', 'person')
    expect(restoreSavedTabs(dir)).toBe(false)
    expect(listing()).toEqual(['Session_1'])
  })

  it('never packs the snapshot, and a restored archive cancels it', () => {
    write('Session_1', 'person')
    snapshotSavedTabs(dir)
    const names = new AdmZip(packProfileCache(dir)).getEntries().map((e) => e.entryName)
    expect(names.some((n) => n.includes(SAVED_TABS_DIR))).toBe(false)

    const archive = new AdmZip()
    archive.addFile('user-data/Default/Sessions/Session_9', Buffer.from('cloud'))
    unpackProfileCache(archive.toBuffer(), dir)
    expect(restoreSavedTabs(dir)).toBe(false)
    expect(listing()).toEqual(['Session_9'])
  })
})

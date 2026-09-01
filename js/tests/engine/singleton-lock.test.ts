import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearSingletonLocks } from '../../src/engine/launcher'

function tmpUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'singleton-'))
}

describe('clearSingletonLocks', () => {
  it('removes a lock left behind by a host that no longer exists', () => {
    const dir = tmpUserDataDir()
    // Chromium writes SingletonLock as a symlink whose target is the literal
    // string <hostname>-<pid>; the target file is never created. A container
    // gets a fresh hostname every start, so the kernel reads a name it cannot
    // match and refuses the profile outright: "in use by another process on
    // another computer". Nothing on this machine can ever clear it.
    fs.symlinkSync('6c7045e44f1b-25', path.join(dir, 'SingletonLock'))
    fs.symlinkSync('6c7045e44f1b-25', path.join(dir, 'SingletonCookie'))
    fs.writeFileSync(path.join(dir, 'SingletonSocket'), '')

    clearSingletonLocks(dir)

    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('removes the lock even though its target is missing', () => {
    // fs.existsSync follows the link and reports false for a dangling one, so a
    // guard written that way deletes nothing and the bug survives the fix.
    const dir = tmpUserDataDir()
    const lock = path.join(dir, 'SingletonLock')
    fs.symlinkSync('nowhere-1', lock)
    expect(fs.existsSync(lock)).toBe(false)

    clearSingletonLocks(dir)

    expect(fs.lstatSync(lock, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('leaves the rest of the profile alone', () => {
    const dir = tmpUserDataDir()
    fs.writeFileSync(path.join(dir, 'SingletonLock'), 'host-1')
    fs.mkdirSync(path.join(dir, 'Default'))
    fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'sqlite')
    fs.writeFileSync(path.join(dir, 'Local State'), '{}')

    clearSingletonLocks(dir)

    expect(fs.readdirSync(dir).sort()).toEqual(['Default', 'Local State'])
    expect(fs.readFileSync(path.join(dir, 'Default', 'Cookies'), 'utf8')).toBe('sqlite')
  })

  it('does nothing when the profile has never been launched', () => {
    const dir = path.join(tmpUserDataDir(), 'user-data')
    expect(() => clearSingletonLocks(dir)).not.toThrow()
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearSingletonLocks, ProfileInUseError } from '../../src/engine/launcher'

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

describe.skipIf(process.platform === 'win32')('a lock held by a live kernel on this machine', () => {
  const children: ChildProcess[] = []
  afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL') })

  // Stands in for the kernel: a live process whose command line names the dir.
  async function holder(arg: string): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', arg], { stdio: 'ignore' })
    children.push(child)
    await new Promise((r) => setTimeout(r, 200))
    return child.pid!
  }

  it('refuses to launch and keeps the lock', async () => {
    // Two kernels on one dir: profile error dialogs, then a transparent window.
    const dir = tmpUserDataDir()
    const pid = await holder(`--user-data-dir=${dir}`)
    fs.symlinkSync(`${os.hostname()}-${pid}`, path.join(dir, 'SingletonLock'))

    expect(() => clearSingletonLocks(dir)).toThrow(ProfileInUseError)
    expect(fs.lstatSync(path.join(dir, 'SingletonLock')).isSymbolicLink()).toBe(true)
  })

  it('treats a reused pid as stale', async () => {
    const dir = tmpUserDataDir()
    const pid = await holder('--user-data-dir=/somewhere/else')
    fs.symlinkSync(`${os.hostname()}-${pid}`, path.join(dir, 'SingletonLock'))

    clearSingletonLocks(dir)

    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('treats a dead pid on this host as stale', () => {
    const dir = tmpUserDataDir()
    fs.symlinkSync(`${os.hostname()}-999999`, path.join(dir, 'SingletonLock'))

    clearSingletonLocks(dir)

    expect(fs.readdirSync(dir)).toEqual([])
  })
})

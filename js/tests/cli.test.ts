import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseClearTempArgs, resolveClearTempCacheDir, runCli, isDirectInvocation } from '../src/cli'

vi.mock('../src/temporary-profiles', () => ({
  clearTemporaryProfiles: vi.fn(() => []),
}))
vi.mock('../src/mcp', () => ({
  startMcpServer: vi.fn(() => Promise.resolve()),
}))

import { clearTemporaryProfiles } from '../src/temporary-profiles'

describe('parseClearTempArgs', () => {
  it('accepts --older-than=N', () => {
    expect(parseClearTempArgs(['--clear-temp', '--older-than=7'])).toEqual({ olderThanDays: 7, dryRun: false })
  })

  it('accepts --older-than N (space form)', () => {
    expect(parseClearTempArgs(['--clear-temp', '--older-than', '7'])).toEqual({ olderThanDays: 7, dryRun: false })
  })

  it('accepts 0', () => {
    expect(parseClearTempArgs(['--clear-temp', '--older-than=0'])).toEqual({ olderThanDays: 0, dryRun: false })
    expect(parseClearTempArgs(['--clear-temp', '--older-than', '0'])).toEqual({ olderThanDays: 0, dryRun: false })
  })

  it('treats an omitted flag as "delete everything"', () => {
    expect(parseClearTempArgs(['--clear-temp'])).toEqual({ olderThanDays: undefined, dryRun: false })
  })

  it('rejects a negative value, in either form', () => {
    expect(() => parseClearTempArgs(['--clear-temp', '--older-than=-1'])).toThrow(/Invalid --older-than/)
    expect(() => parseClearTempArgs(['--clear-temp', '--older-than', '-1'])).toThrow(/Invalid --older-than/)
  })

  it('rejects a non-finite value, in either form', () => {
    expect(() => parseClearTempArgs(['--clear-temp', '--older-than=abc'])).toThrow(/Invalid --older-than/)
    expect(() => parseClearTempArgs(['--clear-temp', '--older-than=Infinity'])).toThrow(/Invalid --older-than/)
    expect(() => parseClearTempArgs(['--clear-temp', '--older-than', 'abc'])).toThrow(/Invalid --older-than/)
  })

  it('rejects an unrecognized flag instead of silently ignoring it', () => {
    expect(() => parseClearTempArgs(['--clear-temp', '--dryrun'])).toThrow(/Unrecognized argument: --dryrun/)
  })

  it('rejects a dangling --older-than with no following value instead of sweeping everything', () => {
    expect(() => parseClearTempArgs(['--clear-temp', '--older-than'])).toThrow(/Missing value for --older-than/)
  })

  it('rejects an empty --older-than= value instead of treating it as 0', () => {
    expect(() => parseClearTempArgs(['--clear-temp', '--older-than='])).toThrow(/Missing value for --older-than/)
  })

  it('rejects a dangling --older-than even with --dry-run present', () => {
    expect(() => parseClearTempArgs(['--clear-temp', '--dry-run', '--older-than'])).toThrow(/Missing value for --older-than/)
  })

  it('composes --dry-run with the = form', () => {
    expect(parseClearTempArgs(['--clear-temp', '--older-than=7', '--dry-run'])).toEqual({ olderThanDays: 7, dryRun: true })
  })

  it('composes --dry-run with the space form', () => {
    expect(parseClearTempArgs(['--clear-temp', '--dry-run', '--older-than', '7'])).toEqual({ olderThanDays: 7, dryRun: true })
  })

  it('composes --dry-run with the omitted flag', () => {
    expect(parseClearTempArgs(['--clear-temp', '--dry-run'])).toEqual({ olderThanDays: undefined, dryRun: true })
  })

  it('rejects a negative value even with --dry-run present', () => {
    expect(() => parseClearTempArgs(['--clear-temp', '--dry-run', '--older-than=-1'])).toThrow(/Invalid --older-than/)
  })

  it('rejects an unknown flag even with --dry-run present', () => {
    expect(() => parseClearTempArgs(['--clear-temp', '--dry-run', '--dryrun'])).toThrow(/Unrecognized argument/)
  })
})

describe('resolveClearTempCacheDir', () => {
  it('prefers ANTIBROW_CACHE_DIR over the legacy var', () => {
    const env = { ANTIBROW_CACHE_DIR: '/a', ANTI_DETECT_BROWSER_CACHE_DIR: '/b' } as unknown as NodeJS.ProcessEnv
    expect(resolveClearTempCacheDir(env)).toBe('/a')
  })

  it('falls back to the legacy var', () => {
    const env = { ANTI_DETECT_BROWSER_CACHE_DIR: '/b' } as unknown as NodeJS.ProcessEnv
    expect(resolveClearTempCacheDir(env)).toBe('/b')
  })

  it('is undefined when neither is set', () => {
    expect(resolveClearTempCacheDir({} as NodeJS.ProcessEnv)).toBeUndefined()
  })
})

describe('runCli --clear-temp', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.mocked(clearTemporaryProfiles).mockClear()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects an unrecognized flag with a non-zero exit and never sweeps', () => {
    runCli(['--clear-temp', '--dryrun'], {} as NodeJS.ProcessEnv)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(clearTemporaryProfiles).not.toHaveBeenCalled()
  })

  it('rejects a negative --older-than with a non-zero exit and never sweeps', () => {
    runCli(['--clear-temp', '--older-than', '-1'], {} as NodeJS.ProcessEnv)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(clearTemporaryProfiles).not.toHaveBeenCalled()
  })

  it('rejects a dangling --older-than with a non-zero exit and never sweeps', () => {
    runCli(['--clear-temp', '--older-than'], {} as NodeJS.ProcessEnv)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(clearTemporaryProfiles).not.toHaveBeenCalled()
  })

  it('rejects an empty --older-than= with a non-zero exit and never sweeps', () => {
    runCli(['--clear-temp', '--older-than='], {} as NodeJS.ProcessEnv)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(clearTemporaryProfiles).not.toHaveBeenCalled()
  })

  it('sweeps with the parsed filter for the space form', () => {
    runCli(['--clear-temp', '--older-than', '7'], {} as NodeJS.ProcessEnv)
    expect(exitSpy).not.toHaveBeenCalled()
    expect(clearTemporaryProfiles).toHaveBeenCalledWith(undefined, { olderThanDays: 7, dryRun: false })
  })

  it('sweeps everything when the flag is omitted', () => {
    runCli(['--clear-temp'], {} as NodeJS.ProcessEnv)
    expect(clearTemporaryProfiles).toHaveBeenCalledWith(undefined, { olderThanDays: undefined, dryRun: false })
  })

  it('honors ANTIBROW_CACHE_DIR over the legacy var when sweeping', () => {
    const env = { ANTIBROW_CACHE_DIR: '/new', ANTI_DETECT_BROWSER_CACHE_DIR: '/old' } as unknown as NodeJS.ProcessEnv
    runCli(['--clear-temp'], env)
    expect(clearTemporaryProfiles).toHaveBeenCalledWith('/new', { olderThanDays: undefined, dryRun: false })
  })
})

describe('isDirectInvocation', () => {
  // node_modules/.bin/anti-detect-browser and the npx shim are both symlinks
  // on macOS/Linux - Node reports import.meta.url as the symlink's target,
  // so the guard has to resolve argv[1] through the real path too or every
  // symlinked launch (which is how the README tells MCP clients to run this)
  // silently does nothing.
  let dir: string
  let realFile: string
  let linkedFile: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-cli-link-'))
    realFile = path.join(dir, 'cli-real.js')
    linkedFile = path.join(dir, 'cli-link.js')
    fs.writeFileSync(realFile, '')
    fs.symlinkSync(realFile, linkedFile)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // What Node itself reports as import.meta.url: the realpath, not whatever
  // path (possibly itself under a symlinked tmpdir on macOS) created the file.
  const moduleUrl = () => pathToFileURL(fs.realpathSync(realFile)).href

  it('matches when argv[1] is the real path directly', () => {
    expect(isDirectInvocation(realFile, moduleUrl())).toBe(true)
  })

  it('matches when argv[1] is a symlink to the real path', () => {
    // This is the reported bug: a naive string comparison against the
    // symlink path (instead of resolving it first) used to fail here.
    expect(isDirectInvocation(linkedFile, moduleUrl())).toBe(true)
  })

  it('does not match an unrelated path', () => {
    expect(isDirectInvocation(path.join(dir, 'someone-else.js'), moduleUrl())).toBe(false)
  })

  it('is false, not throwing, when argv[1] is undefined', () => {
    expect(isDirectInvocation(undefined, moduleUrl())).toBe(false)
  })

  it('does not throw when argv[1] points at a nonexistent path', () => {
    const missing = path.join(dir, 'does-not-exist.js')
    expect(() => isDirectInvocation(missing, moduleUrl())).not.toThrow()
    expect(isDirectInvocation(missing, moduleUrl())).toBe(false)
  })
})

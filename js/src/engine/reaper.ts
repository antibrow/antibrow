import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Kernels whose owner died without closing them.
 *
 * The exit hooks cover every exit Node gets to see; SIGKILL, an OOM kill and a
 * power cut are not among them. Whatever those leak, the next launch reaps.
 *
 * `running-kernels.json` is shared with the Python SDK - same path, same shape,
 * same rule - because both can be pointed at one cache directory.
 */
export const REGISTRY_FILE = 'running-kernels.json'

export interface KernelRecord {
  kernelPid: number
  ownerPid: number
  profileDir: string
  cdpPort?: number
}

export function registryPath(cacheDir: string): string {
  return path.join(cacheDir, REGISTRY_FILE)
}

function read(cacheDir: string): KernelRecord[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(registryPath(cacheDir), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((e): e is KernelRecord => !!e && typeof (e as KernelRecord).kernelPid === 'number')
  } catch {
    return []
  }
}

function write(cacheDir: string, entries: KernelRecord[]): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(registryPath(cacheDir), JSON.stringify(entries))
  } catch {
    // Housekeeping never fails a launch.
  }
}

export function registerKernel(
  cacheDir: string,
  entry: { kernelPid: number; ownerPid?: number; profileDir: string; cdpPort?: number },
): void {
  const rest = read(cacheDir).filter((e) => e.kernelPid !== entry.kernelPid)
  rest.push({
    kernelPid: entry.kernelPid,
    ownerPid: entry.ownerPid ?? process.pid,
    profileDir: entry.profileDir,
    cdpPort: entry.cdpPort,
  })
  write(cacheDir, rest)
}

export function unregisterKernel(cacheDir: string, kernelPid: number): void {
  write(
    cacheDir,
    read(cacheDir).filter((e) => e.kernelPid !== kernelPid),
  )
}

export interface ReapHooks {
  isAlive?: (pid: number) => boolean
  commandLine?: (pid: number) => string | undefined
  kill?: (pid: number) => void
}

/** Kill every registered kernel whose owner is gone. Returns the pids killed. */
export function reapOrphans(cacheDir: string, hooks: ReapHooks = {}): number[] {
  const alive = hooks.isAlive ?? isAlive
  const describe = hooks.commandLine ?? commandLine
  const slay = hooks.kill ?? killPidTree

  const kept: KernelRecord[] = []
  const reaped: number[] = []
  for (const entry of read(cacheDir)) {
    if (!alive(entry.kernelPid)) continue // already gone; drop the row
    if (typeof entry.ownerPid === 'number' && alive(entry.ownerPid)) {
      kept.push(entry)
      continue
    }
    // Never kill on a pid alone: pids get reused, and the process wearing this
    // one now may be the user's editor. Only argv naming this very profile
    // directory proves the process is the kernel we started.
    const argv = entry.profileDir ? describe(entry.kernelPid) : undefined
    if (!argv || !argv.includes(entry.profileDir)) {
      kept.push(entry)
      continue
    }
    slay(entry.kernelPid)
    reaped.push(entry.kernelPid)
  }
  write(cacheDir, kept)
  return reaped
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours
  }
}

function commandLine(pid: number): string | undefined {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync(
            'powershell',
            ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
            { encoding: 'utf8', timeout: 10_000, windowsHide: true },
          )
        : execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
            timeout: 10_000,
          })
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * The kernel is spawned detached, so its pid is also its process-group id and
 * one signal takes the renderers and the GPU process with it. That is also why
 * an orphan outlives its owner in the first place.
 */
export function killPidTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      // already gone
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

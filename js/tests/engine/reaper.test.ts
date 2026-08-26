import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { reapOrphans, registerKernel, registryPath, unregisterKernel } from '../../src/engine/reaper'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-'))
}

describe('the orphan kernel registry', () => {
  it('lives at the path the Python SDK also writes', () => {
    const dir = tmp()
    expect(registryPath(dir)).toBe(path.join(dir, 'running-kernels.json'))
  })

  it('reaps a kernel whose owner process is gone', () => {
    const dir = tmp()
    const profileDir = path.join(dir, 'p')
    registerKernel(dir, { kernelPid: 4242, ownerPid: 999, profileDir, cdpPort: 51234 })

    const killed: number[] = []
    const reaped = reapOrphans(dir, {
      isAlive: (pid) => pid === 4242,
      commandLine: () => `/kernels/152/Chromium --fp-config=${profileDir}/fp-config.json`,
      kill: (pid) => killed.push(pid),
    })

    expect(killed).toEqual([4242])
    expect(reaped).toEqual([4242])
    expect(JSON.parse(fs.readFileSync(registryPath(dir), 'utf8'))).toEqual([])
  })

  it('spares a kernel whose owner is still running', () => {
    const dir = tmp()
    registerKernel(dir, { kernelPid: 4242, ownerPid: 999, profileDir: path.join(dir, 'p') })

    const killed: number[] = []
    const reaped = reapOrphans(dir, {
      isAlive: () => true,
      commandLine: () => dir,
      kill: (pid) => killed.push(pid),
    })

    expect(killed).toEqual([])
    expect(reaped).toEqual([])
    expect(JSON.parse(fs.readFileSync(registryPath(dir), 'utf8'))).toHaveLength(1)
  })

  it('refuses to kill a pid it cannot prove is the kernel', () => {
    const dir = tmp()
    registerKernel(dir, { kernelPid: 4242, ownerPid: 999, profileDir: path.join(dir, 'p') })

    const killed: number[] = []
    reapOrphans(dir, {
      isAlive: (pid) => pid === 4242,
      commandLine: () => '/usr/bin/vim notes.txt',
      kill: (pid) => killed.push(pid),
    })

    expect(killed).toEqual([])
  })

  it('refuses to kill when the command line cannot be read', () => {
    const dir = tmp()
    registerKernel(dir, { kernelPid: 4242, ownerPid: 999, profileDir: path.join(dir, 'p') })

    const killed: number[] = []
    reapOrphans(dir, {
      isAlive: (pid) => pid === 4242,
      commandLine: () => undefined,
      kill: (pid) => killed.push(pid),
    })

    expect(killed).toEqual([])
  })

  it('drops rows for kernels that already exited', () => {
    const dir = tmp()
    registerKernel(dir, { kernelPid: 4242, ownerPid: 999, profileDir: path.join(dir, 'p') })

    reapOrphans(dir, { isAlive: () => false, commandLine: () => undefined, kill: () => {} })

    expect(JSON.parse(fs.readFileSync(registryPath(dir), 'utf8'))).toEqual([])
  })

  it('unregisters only its own row', () => {
    const dir = tmp()
    registerKernel(dir, { kernelPid: 1, ownerPid: 999, profileDir: path.join(dir, 'a') })
    registerKernel(dir, { kernelPid: 2, ownerPid: 999, profileDir: path.join(dir, 'b') })

    unregisterKernel(dir, 1)

    const rows = JSON.parse(fs.readFileSync(registryPath(dir), 'utf8'))
    expect(rows.map((r: { kernelPid: number }) => r.kernelPid)).toEqual([2])
  })

  it('reads a row the Python SDK wrote', () => {
    const dir = tmp()
    const profileDir = path.join(dir, 'p')
    fs.writeFileSync(
      registryPath(dir),
      JSON.stringify([{ kernelPid: 7, ownerPid: 8, profileDir, cdpPort: 1 }]),
    )

    const killed: number[] = []
    reapOrphans(dir, {
      isAlive: (pid) => pid === 7,
      commandLine: () => `chrome --fp-config=${profileDir}/fp-config.json`,
      kill: (pid) => killed.push(pid),
    })

    expect(killed).toEqual([7])
  })
})

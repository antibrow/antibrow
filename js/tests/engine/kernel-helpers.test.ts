import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_KERNEL_VERSION,
  kernelDir,
  kernelExePath,
  isKernelInstalled,
  listInstalledKernels,
  kernelDirSize,
  deleteKernel,
} from '../../src/engine/downloader'

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('kernel helpers', () => {
  it('list/size/delete reflect installed state', () => {
    const cache = tmp('kern-')
    const v = DEFAULT_KERNEL_VERSION.version

    // nothing installed yet
    expect(listInstalledKernels(cache)).toEqual([])
    expect(kernelDirSize(cache, v)).toBe(0)
    expect(isKernelInstalled(cache, DEFAULT_KERNEL_VERSION)).toBe(false)

    // "install": create the platform exe + a sibling resource file
    const exe = kernelExePath(cache, DEFAULT_KERNEL_VERSION)
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, 'MZ') // 2 bytes
    fs.writeFileSync(path.join(kernelDir(cache, v), 'resources.pak'), 'abcdef') // 6 bytes

    expect(isKernelInstalled(cache, DEFAULT_KERNEL_VERSION)).toBe(true)
    expect(listInstalledKernels(cache)).toEqual([v])
    expect(kernelDirSize(cache, v)).toBe(8)

    // delete is idempotent and clears installed state
    deleteKernel(cache, v)
    deleteKernel(cache, v)
    expect(isKernelInstalled(cache, DEFAULT_KERNEL_VERSION)).toBe(false)
    expect(listInstalledKernels(cache)).toEqual([])
    expect(kernelDirSize(cache, v)).toBe(0)
  })
})

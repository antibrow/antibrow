import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// exportProfileArchiveAsync's own kernel lookup (resolveKernelExe, used when no
// `rekey` override is supplied) used to call the lenient findKernelVersion with
// no preceding refresh, so a profile pinned to a version that only exists in
// the runtime manifest silently converted on the compiled-in baseline instead -
// the same shape of bug the Android floor already guards against with
// findKernelVersionStrict. These tests pin down both halves of the fix: the
// catalogue is refreshed first, and the lookup after that refresh is strict.

const refreshSpy = vi.fn(async (_cacheDir: string) => undefined)
const strictSpy = vi.fn((v: string) => {
  if (v === '151') return { version: '151', label: 'Chrome 151', platforms: {} }
  throw new Error(
    `Kernel ${v} is not in the catalogue. Refresh the kernel list with an internet ` +
      'connection and retry; falling back to another version would change this profile\'s identity.',
  )
})
const ensureKernelSpy = vi.fn(async (_cacheDir: string, kv: { version: string }) => {
  throw new Error(`ENSURE_KERNEL_STUB:${kv.version}`)
})

vi.mock('../../src/engine/downloader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/downloader')>()),
  refreshKernelVersions: (cacheDir: string) => refreshSpy(cacheDir),
  findKernelVersionStrict: (v: string) => strictSpy(v),
  ensureKernel: (cacheDir: string, kv: { version: string }) => ensureKernelSpy(cacheDir, kv),
}))

import { exportProfileArchiveAsync } from '../../src/engine/crypt-rekey'
import { markProfileEncrypted } from '../../src/engine/profile-dir'

const KEY = 'a1'.repeat(32)
const META = { id: 'p-1', name: 'shop-01' }

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crypt-export-kernel-'))

function seed(dir: string, kernelVersion: string): void {
  fs.mkdirSync(path.join(dir, 'user-data', 'Default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ kernelVersion }))
  fs.writeFileSync(
    path.join(dir, 'user-data', 'Local State'),
    JSON.stringify({ fp_crypt: { key_check: 'KC' } }),
  )
  markProfileEncrypted(dir)
}

beforeEach(() => {
  refreshSpy.mockClear()
  strictSpy.mockClear()
  ensureKernelSpy.mockClear()
})

describe('exportProfileArchiveAsync kernel resolution', () => {
  it('refreshes the kernel catalogue before resolving the version', async () => {
    const src = tmp()
    seed(src, '151')

    await expect(
      exportProfileArchiveAsync(src, META, { cryptKey: KEY, cacheDir: '/cache', licenseToken: 'tok', tmpDir: tmp() }),
    ).rejects.toThrow('ENSURE_KERNEL_STUB:151')

    expect(refreshSpy).toHaveBeenCalledWith('/cache')
    expect(strictSpy).toHaveBeenCalledWith('151')
    // Not just that both ran - refresh has to run before the lookup, since the
    // lookup is what needs the freshly-registered manifest versions.
    expect(refreshSpy.mock.invocationCallOrder[0]).toBeLessThan(strictSpy.mock.invocationCallOrder[0])
  })

  it('fails fast, naming the version, for a profile pinned to a version absent from the catalogue', async () => {
    const src = tmp()
    seed(src, '152')

    await expect(
      exportProfileArchiveAsync(src, META, { cryptKey: KEY, cacheDir: '/cache', licenseToken: 'tok', tmpDir: tmp() }),
    ).rejects.toThrow(/152/)

    // Fails at resolution, never reaching for a kernel to convert on instead.
    expect(ensureKernelSpy).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  ensureKernel,
  kernelDir,
  kernelLockPath,
  currentPlatform,
  findKernelVersion,
  registerKernelVersions,
  writeInstalledKernelBuild,
  type KernelVersion,
} from '../../src/engine/downloader'

/**
 * ensureKernel picks its asset from currentPlatform(), and darwin would send
 * extraction through `ditto` plus a codesign check that a fake bundle cannot
 * pass. Pinning linux keeps these tests on the portable path.
 */
function withPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => Object.defineProperty(process, 'platform', original)
}

let restorePlatform: (() => void) | undefined
let server: http.Server
let base: string
let hits: string[] = []
let zipBytes: Buffer

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-lock-'))
}

/** Unique version per test: registerKernelVersions merges, it does not replace. */
function register(version: string): KernelVersion {
  const asset = { downloadUrl: `${base}/${version}.zip`, exeRelPath: 'chrome', build: 'b1' }
  registerKernelVersions([
    {
      version,
      label: `Chrome ${version} (test)`,
      platforms: { linux: { ...asset }, 'linux-arm64': { ...asset } },
    },
  ])
  return findKernelVersion(version)
}

beforeAll(async () => {
  const zip = new AdmZip()
  zip.addFile('chrome', Buffer.from('ELF-test-kernel'))
  zipBytes = zip.toBuffer()

  server = http.createServer((req, res) => {
    hits.push((req.url ?? '').split('?')[0])
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBytes.length) })
    // Dribbled out so a second caller is still queued while the first downloads.
    res.write(zipBytes.subarray(0, 8))
    setTimeout(() => res.end(zipBytes.subarray(8)), 200)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  hits = []
  restorePlatform = withPlatform('linux')
})

afterEach(() => {
  restorePlatform?.()
  restorePlatform = undefined
})

describe('kernel install lock', () => {
  it('serialises concurrent installs into a single download', async () => {
    const kv = register('910')
    const cache = tmp()

    const [a, b] = await Promise.all([ensureKernel(cache, kv), ensureKernel(cache, kv)])

    expect(a).toBe(b)
    expect(fs.readFileSync(a, 'utf8')).toBe('ELF-test-kernel')
    expect(hits.filter((u) => u === '/910.zip')).toHaveLength(1)
    expect(fs.existsSync(kernelLockPath(cache, '910', currentPlatform()))).toBe(false)
  })

  it('reports the wait instead of racing the other process', async () => {
    const kv = register('914')
    const cache = tmp()
    const messages: string[][] = [[], []]

    await Promise.all([
      ensureKernel(cache, kv, (m) => messages[0].push(m)),
      ensureKernel(cache, kv, (m) => messages[1].push(m)),
    ])

    const waited = messages.filter((m) => m.some((x) => x.startsWith('Waiting for another process')))
    expect(waited).toHaveLength(1)
  })

  it('takes over a lock whose owner stopped touching it', async () => {
    const kv = register('911')
    const cache = tmp()
    const lockPath = kernelLockPath(cache, '911', currentPlatform())
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, '999999\n')
    const stale = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(lockPath, stale, stale)

    const exe = await ensureKernel(cache, kv)

    expect(fs.existsSync(exe)).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('waits for the holder to finish before adopting its install', async () => {
    // The executable appears mid-extraction, so a waiter that trusted the exe
    // alone would hand out a half-unpacked kernel.
    const kv = register('912')
    const cache = tmp()
    const exe = path.join(kernelDir(cache, '912'), 'chrome')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, 'half a kernel')
    writeInstalledKernelBuild(cache, '912', 'b1')
    const lockPath = kernelLockPath(cache, '912', currentPlatform())
    fs.writeFileSync(lockPath, '1\n')

    let finishedAt = 0
    const holder = setTimeout(() => {
      fs.writeFileSync(exe, 'ELF-test-kernel')
      finishedAt = Date.now()
      fs.rmSync(lockPath, { force: true })
    }, 400)

    const got = await ensureKernel(cache, kv, undefined, { force: true })
    clearTimeout(holder)

    expect(got).toBe(exe)
    expect(finishedAt).toBeGreaterThan(0)
    expect(Date.now()).toBeGreaterThanOrEqual(finishedAt)
    expect(fs.readFileSync(got, 'utf8')).toBe('ELF-test-kernel')
    // The holder's build was the one this call wanted, so nothing was fetched.
    expect(hits).toEqual([])
  })

  it('does not launch from a kernel another process is re-extracting', async () => {
    const kv = register('915')
    const cache = tmp()
    const exe = path.join(kernelDir(cache, '915'), 'chrome')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, 'about to be deleted')
    const lockPath = kernelLockPath(cache, '915', currentPlatform())
    fs.writeFileSync(lockPath, '1\n')

    const holder = setTimeout(() => {
      fs.writeFileSync(exe, 'ELF-test-kernel')
      fs.rmSync(lockPath, { force: true })
    }, 400)

    // A plain (non-force) launch: the fast path used to return the doomed file.
    const got = await ensureKernel(cache, kv)
    clearTimeout(holder)

    expect(fs.readFileSync(got, 'utf8')).toBe('ELF-test-kernel')
    expect(hits).toEqual([])
  })

  it('sweeps an abandoned temp zip and keeps none of its own', async () => {
    const kv = register('913')
    const cache = tmp()
    const abandoned = path.join(cache, `kernel-913-${currentPlatform()}.zip`)
    fs.writeFileSync(abandoned, 'half a download')
    const old = new Date(Date.now() - 3 * 60 * 60_000)
    fs.utimesSync(abandoned, old, old)

    await ensureKernel(cache, kv)

    expect(fs.readdirSync(cache).filter((n) => n.startsWith('kernel-913'))).toEqual([])
  })
})

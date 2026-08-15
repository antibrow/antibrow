import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setProfileKernelVersion, shouldRestoreArchive } from '../../src/engine'
import { generatePersona, readPersona, type Persona } from '../../src/engine/persona'
import { DEFAULT_KERNEL_VERSION } from '../../src/engine/downloader'
import { resolveProfileDirSync } from '../../src/engine/profile-dir'
import { packProfileCache, unpackProfileCache, writeArchiveVersion } from '../../src/engine/profile-cache'

const NEW = '151'
const OLD = DEFAULT_KERNEL_VERSION.version

function manifest(): string {
  return JSON.stringify({
    versions: ['win64', 'linux64', 'linuxarm64', 'mac-universal'].map((platform) => ({
      version: `${NEW}.0.0.1`,
      label: `Chrome ${NEW}`,
      platform,
      download_url: `fp-chromium-${NEW}-${platform}.zip`,
      build: '2026-08-11 10:00',
    })),
  })
}

let cacheDir: string
let dir: string

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(manifest(), { status: 200 })))
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-setkv-'))
  dir = path.join(cacheDir, 'profile')
  fs.mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

function seed(persona: Persona = generatePersona(parseInt(OLD, 10), OLD), target = dir): Persona {
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'persona.json'), JSON.stringify(persona, null, 2), 'utf8')
  return persona
}

describe('setProfileKernelVersion', () => {
  it('rewrites the three version-derived fields and nothing else', async () => {
    const before = seed()

    const after = await setProfileKernelVersion({ profileDir: dir, version: NEW, cacheDir })

    expect(after.kernelVersion).toBe(NEW)
    expect(after.chromeMajor).toBe(151)
    expect(after.ua).toContain('Chrome/151.0.0.0')
    // The identity itself must survive: re-rolling seeds/GPU/screen on a profile
    // that already carries live cookies is a change sites can see.
    const strip = (p: Persona): Partial<Persona> => {
      const { kernelVersion, chromeMajor, ua, ...rest } = p
      return rest
    }
    expect(strip(after)).toEqual(strip(before))
  })

  it('persists the rewrite to persona.json', async () => {
    seed()
    await setProfileKernelVersion({ profileDir: dir, version: NEW, cacheDir })

    const onDisk = readPersona(dir)
    expect(onDisk?.kernelVersion).toBe(NEW)
    expect(onDisk?.chromeMajor).toBe(151)
  })

  it('accepts a legacy full version string', async () => {
    seed()
    const after = await setProfileKernelVersion({ profileDir: dir, version: `${NEW}.0.0.1`, cacheDir })
    expect(after.kernelVersion).toBe(NEW)
  })

  it('finds the profile by name, without the caller resolving a directory', async () => {
    const name = 'gmail-1'
    const resolved = resolveProfileDirSync(cacheDir, name)
    seed(generatePersona(parseInt(OLD, 10), OLD), resolved.dir)

    const after = await setProfileKernelVersion({ profileName: name, cacheDir, version: NEW })

    expect(after.kernelVersion).toBe(NEW)
    expect(readPersona(resolved.dir)?.kernelVersion).toBe(NEW)
  })

  it('refuses a version the catalogue does not know, leaving the profile untouched', async () => {
    seed()
    await expect(setProfileKernelVersion({ profileDir: dir, version: '900', cacheDir }))
      .rejects.toThrow(/not in the catalogue/)
    expect(readPersona(dir)?.kernelVersion).toBe(OLD)
  })

  it('refuses a kernel without the mobile patches for an Android profile', async () => {
    const android: Persona = {
      ...generatePersona(151, NEW),
      deviceType: 'android',
      androidModel: 'Pixel 8',
      ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    }
    seed(android)

    await expect(setProfileKernelVersion({ profileDir: dir, version: OLD, cacheDir }))
      .rejects.toThrow(/Android profiles need kernel/)
    expect(readPersona(dir)?.kernelVersion).toBe(NEW)
  })

  it('rewrites the Chrome major inside an Android UA too', async () => {
    const android: Persona = {
      ...generatePersona(parseInt(OLD, 10), OLD),
      deviceType: 'android',
      androidModel: 'Pixel 8',
      ua: `Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${OLD}.0.0.0 Mobile Safari/537.36`,
    }
    seed(android)

    const after = await setProfileKernelVersion({ profileDir: dir, version: NEW, cacheDir })

    expect(after.ua).toBe(
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    )
    expect(after.androidModel).toBe('Pixel 8')
  })

  it('refuses a profile that has no persona yet', async () => {
    await expect(setProfileKernelVersion({ profileDir: dir, version: NEW, cacheDir }))
      .rejects.toThrow(/has no persona/)
  })
})

// persona.json rides the cloud archive, and the restore runs before the persona
// is read - so whether a switch survives is entirely decided by the generation
// marker. These pin both sides of that.
describe('a switch against the cloud archive', () => {
  it('survives on the machine holding the current generation', () => {
    writeArchiveVersion(dir, 'etag-1')
    expect(shouldRestoreArchive('etag-1', 'etag-1')).toBe(false)
  })

  it('is restored over when the cloud holds a different or unnameable generation', () => {
    expect(shouldRestoreArchive(undefined, 'etag-1')).toBe(true)
    expect(shouldRestoreArchive('etag-1', 'etag-2')).toBe(true)
    // An older server, or an R2 object that does not exist yet: nothing to
    // compare, so the restore is unconditional.
    expect(shouldRestoreArchive('etag-1', undefined)).toBe(true)
  })

  it('loses the switch when a restore does run', async () => {
    seed()
    const cloud = packProfileCache(dir)   // packed while still on the old kernel

    // The switch happens after that upload...
    await setProfileKernelVersion({ profileDir: dir, version: NEW, cacheDir })
    // ...and a restore puts the old identity back, kernel version included.
    unpackProfileCache(cloud, dir)

    expect(readPersona(dir)?.kernelVersion).toBe(OLD)
  })
})

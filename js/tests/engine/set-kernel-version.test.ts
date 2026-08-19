import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setProfileKernelVersion, reconcileKernelVersion, reportRestoredKernelChange, shouldRestoreArchive } from '../../src/engine'
import { generatePersona, readPersona, type Persona } from '../../src/engine/persona'
import { DEFAULT_KERNEL_VERSION } from '../../src/engine/downloader'
import { resolveProfileDirSync } from '../../src/engine/profile-dir'
import { packProfileCache, unpackProfileCache, writeArchiveVersion, readArchiveVersion } from '../../src/engine/profile-cache'

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

  it('is carried by the archive itself once the switch is committed', async () => {
    // This is what makes a switch hold across cache directories and machines:
    // they all restore from the archive, and the archive now names the new
    // kernel. Nothing machine-local has to remember the switch.
    seed()
    writeArchiveVersion(dir, 'gen-1')
    let uploaded: Buffer | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { method?: string; body?: Uint8Array }) => {
      if (init?.method === 'PUT') {
        uploaded = Buffer.from(init.body!)
        return new Response('', { status: 200, headers: { etag: '"gen-2"' } })
      }
      return new Response(manifest(), { status: 200 })
    }))

    await setProfileKernelVersion({
      profileDir: dir, version: NEW, cacheDir,
      archive: { version: 'gen-1', getPutUrl: async () => 'https://r2/put' },
    })
    // A second cache directory restoring that archive lands on the new kernel.
    const elsewhere = path.join(cacheDir, 'other')
    unpackProfileCache(uploaded!, elsewhere)

    expect(readPersona(elsewhere)?.kernelVersion).toBe(NEW)
  })

  it('is replaced by a restore when the switch was never committed', async () => {
    // Not a regression - the reason `archive` exists. An uncommitted switch is
    // one machine's opinion, and the cloud copy is what everyone else reads.
    seed()
    const cloud = packProfileCache(dir)

    await setProfileKernelVersion({ profileDir: dir, version: NEW, cacheDir })
    unpackProfileCache(cloud, dir)

    expect(readPersona(dir)?.kernelVersion).toBe(OLD)
  })

  it('keeps the archived identity, moving only the kernel-derived fields', async () => {
    const before = seed()
    const after = await setProfileKernelVersion({ profileDir: dir, version: NEW, cacheDir })

    const strip = (p: Persona): Partial<Persona> => {
      const { kernelVersion, chromeMajor, ua, ...rest } = p
      return rest
    }
    expect(strip(after)).toEqual(strip(before))
    expect(after.ua).toContain('Chrome/151.0.0.0')
  })
})

// A launch is handed the caller's idea of the kernel (the desktop app passes its
// stored row on every launch) and the persona on disk. They disagree whenever
// the row moved without the persona - which cloud sync does routinely, since it
// copies the row field and never touches the profile directory. Dropping the
// caller's value silently is how a profile ends up displaying 152 while running
// 150, its UA two majors behind.
describe('reconcileKernelVersion', () => {
  it('moves the persona onto the requested version', async () => {
    const before = seed()
    const messages: string[] = []

    const after = await reconcileKernelVersion({
      profileDir: dir, persona: before, requested: NEW, cacheDir, onProgress: (m) => messages.push(m),
    })

    expect(after.kernelVersion).toBe(NEW)
    expect(readPersona(dir)?.kernelVersion).toBe(NEW)
    expect(after.seed).toBe(before.seed)
    expect(messages.join('\n')).toMatch(new RegExp(`${OLD}.*${NEW}`))
  })

  it('accepts a full four-segment version as the same major', async () => {
    const before = seed()
    const after = await reconcileKernelVersion({
      profileDir: dir, persona: before, requested: `${OLD}.0.7871.182`, cacheDir,
    })
    expect(after).toBe(before)
  })

  it('treats a legacy four-segment persona as its major', async () => {
    // Profiles created before the majors-only change still carry the full
    // string on disk, and it is never rewritten just for being read. Comparing
    // raw strings would call that a mismatch and rewrite + pin for nothing.
    const before = seed({ ...generatePersona(parseInt(OLD, 10), OLD), kernelVersion: `${OLD}.0.7871.182` })

    const after = await reconcileKernelVersion({ profileDir: dir, persona: before, requested: OLD, cacheDir })

    expect(after).toBe(before)
  })

  it('still moves a legacy four-segment persona to another major', async () => {
    const before = seed({ ...generatePersona(parseInt(OLD, 10), OLD), kernelVersion: `${OLD}.0.7871.182` })

    const after = await reconcileKernelVersion({ profileDir: dir, persona: before, requested: NEW, cacheDir })

    expect(after.kernelVersion).toBe(NEW)
  })

  it('leaves the profile alone when the caller named nothing', async () => {
    const before = seed()
    expect(await reconcileKernelVersion({ profileDir: dir, persona: before, cacheDir })).toBe(before)
  })

  it('keeps launching on the persona version when the move is refused, and says so', async () => {
    // An Android profile below the mobile-patch floor is the real case: the row
    // can name a kernel the profile may not use. Failing the launch outright
    // would break a profile that works today, but silence is what hid this.
    const android: Persona = {
      ...generatePersona(151, NEW),
      deviceType: 'android',
      androidModel: 'Pixel 8',
      ua: `Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${NEW}.0.0.0 Mobile Safari/537.36`,
    }
    seed(android)
    const messages: string[] = []

    const after = await reconcileKernelVersion({
      profileDir: dir, persona: android, requested: OLD, cacheDir, onProgress: (m) => messages.push(m),
    })

    expect(after.kernelVersion).toBe(NEW)
    expect(readPersona(dir)?.kernelVersion).toBe(NEW)
    expect(messages.join('\n')).toMatch(/Android profiles need kernel/)
  })

  it('reports a version the catalogue does not know instead of failing the launch', async () => {
    const before = seed()
    const messages: string[] = []

    const after = await reconcileKernelVersion({
      profileDir: dir, persona: before, requested: '900', cacheDir, onProgress: (m) => messages.push(m),
    })

    expect(after.kernelVersion).toBe(OLD)
    expect(messages.join('\n')).toMatch(/not in the catalogue/)
  })
})


// The switch is only real once the cloud copy carries it. Everything else - a
// second cache directory on this machine, another machine, the desktop app -
// restores from that archive, so a switch that never reaches it is a switch
// that gets undone the moment anyone else opens the profile.
describe('setProfileKernelVersion committed to the cloud', () => {
  /** A fetch that serves the manifest, one archive GET, and records the PUT. */
  function transport(archive: Buffer, opts: { putStatus?: number } = {}) {
    const puts: Buffer[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { method?: string; body?: Uint8Array }) => {
      const href = String(url)
      if (init?.method === 'PUT') {
        puts.push(Buffer.from(init.body!))
        return new Response('', { status: opts.putStatus ?? 200, headers: { etag: '"gen-2"' } })
      }
      if (href.includes('/archive')) return new Response(new Uint8Array(archive), { status: 200 })
      return new Response(manifest(), { status: 200 })
    }))
    return puts
  }

  /** The cloud copy: a profile still on OLD, packed as the archive would be. */
  function cloudArchive(): Buffer {
    const src = path.join(cacheDir, 'cloud')
    fs.mkdirSync(path.join(src, 'user-data', 'Default'), { recursive: true })
    fs.writeFileSync(path.join(src, 'user-data', 'Default', 'Cookies'), 'from-the-cloud', 'utf8')
    fs.writeFileSync(path.join(src, 'persona.json'), JSON.stringify(generatePersona(parseInt(OLD, 10), OLD)), 'utf8')
    return packProfileCache(src)
  }

  it('uploads the moved persona and records the new generation', async () => {
    seed()
    writeArchiveVersion(dir, 'gen-1')
    const puts = transport(cloudArchive())

    const after = await setProfileKernelVersion({
      profileDir: dir, version: NEW, cacheDir,
      archive: { getUrl: 'https://r2/archive', version: 'gen-1', getPutUrl: async () => 'https://r2/put' },
    })

    expect(after.kernelVersion).toBe(NEW)
    expect(puts).toHaveLength(1)
    const uploaded = new AdmZip(puts[0]!).getEntry('persona.json')!.getData().toString('utf8')
    expect(JSON.parse(uploaded).kernelVersion).toBe(NEW)
    expect(readArchiveVersion(dir)).toBe('gen-2')
  })

  it('starts from the cloud copy when this directory is behind', async () => {
    // Another machine may hold a newer archive; moving the local copy and
    // uploading it would silently discard whatever that machine saved.
    seed()
    writeArchiveVersion(dir, 'gen-0')
    const puts = transport(cloudArchive())

    await setProfileKernelVersion({
      profileDir: dir, version: NEW, cacheDir,
      archive: { getUrl: 'https://r2/archive', version: 'gen-1', getPutUrl: async () => 'https://r2/put' },
    })

    const cookies = new AdmZip(puts[0]!).getEntry('user-data/Default/Cookies')
    expect(cookies?.getData().toString('utf8')).toBe('from-the-cloud')
  })

  it('rolls the persona back when the upload fails', async () => {
    const before = seed()
    writeArchiveVersion(dir, 'gen-1')
    transport(cloudArchive(), { putStatus: 500 })

    await expect(setProfileKernelVersion({
      profileDir: dir, version: NEW, cacheDir,
      archive: { getUrl: 'https://r2/archive', version: 'gen-1', getPutUrl: async () => 'https://r2/put' },
    })).rejects.toThrow(/upload/i)

    // Half a switch is the drift this whole change removes: the row would say
    // NEW while every other machine still restores OLD.
    expect(readPersona(dir)?.kernelVersion).toBe(before.kernelVersion)
  })

  it('stays local when the profile has no cloud archive', async () => {
    seed()
    const puts = transport(Buffer.alloc(0))

    const after = await setProfileKernelVersion({ profileDir: dir, version: NEW, cacheDir })

    expect(after.kernelVersion).toBe(NEW)
    expect(puts).toHaveLength(0)
  })
})

// A restore replacing the local persona is the profile changing identity behind
// the caller's back. It is the correct outcome - the cloud copy is authoritative
// - but it used to happen in silence, which is what made "the row says 152 and
// it launched 150" take a day to explain.
describe('a restore that changes the kernel version', () => {
  it('names both sides of the swap', () => {
    seed()
    const cloud = (() => {
      const src = path.join(cacheDir, 'cloud')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'persona.json'), JSON.stringify(generatePersona(151, NEW)), 'utf8')
      return packProfileCache(src)
    })()
    const messages: string[] = []

    reportRestoredKernelChange(dir, OLD, (m) => messages.push(m))   // before: nothing changed yet
    unpackProfileCache(cloud, dir)
    reportRestoredKernelChange(dir, OLD, (m) => messages.push(m))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(OLD)
    expect(messages[0]).toContain(NEW)
  })

  it('says nothing when the restore left the version alone', () => {
    seed()
    const messages: string[] = []
    reportRestoredKernelChange(dir, OLD, (m) => messages.push(m))
    expect(messages).toEqual([])
  })
})

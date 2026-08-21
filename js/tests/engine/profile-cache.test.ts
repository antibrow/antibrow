import { describe, it, expect } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packProfileCache, unpackProfileCache, exportProfileArchive, importProfileArchive } from '../../src/engine/profile-cache'
import { generatePersona, personaToFpConfig, type Persona } from '../../src/engine/persona'
import { DEFAULT_KERNEL_VERSION, kernelsForPlatform, normalizeKernelVersion } from '../../src/engine/downloader'

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Mirrors the (unexported) rule in profile-cache.ts's
 * `resolveImportedKernelVersion`: normalize `wanted` to a Chrome major, exact
 * match on this platform's catalogue, else the default. Computed from the
 * same public building blocks the implementation uses, so this states the
 * real cross-platform rule instead of one platform's answer — e.g. 149 has
 * no darwin build, so on darwin this resolves to the default.
 */
function expectedResolvedKernelVersion(wanted: string): string {
  const known = kernelsForPlatform().map((kv) => kv.version)
  const want = normalizeKernelVersion(wanted)
  return known.includes(want) ? want : DEFAULT_KERNEL_VERSION.version
}

/** A persona as the launcher serializes it (snake_case). */
const LAUNCHER_PERSONA = {
  seed: '0123456789abcdef',
  canvas_seed: 'aaaaaaaaaaaaaaaa',
  audio_seed: 'bbbbbbbbbbbbbbbb',
  domrect_seed: 'cccccccccccccccc',
  chrome_major: 149,
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  hardware_concurrency: 12,
  device_memory: 16,
  screen_w: 1536,
  screen_h: 864,
  device_pixel_ratio: 1.25,
  gpu_vendor: 'Google Inc. (NVIDIA)',
  gpu_renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3699)',
  languages: ['de-DE', 'de', 'en'],
  timezone: 'Europe/Berlin',
}

/** Build a .fpprofile exactly as the launcher's portable.rs writes one. */
function launcherArchive(overrides: Record<string, unknown> = {}, files: Record<string, string> = {}): Buffer {
  const zip = new AdmZip()
  const manifest = {
    format: 'fp-launcher-profile',
    version: 1,
    profile: {
      id: 'a1b2c3d4e5f60718',
      name: 'Berlin-01',
      proxy: { raw: 'socks5://user:pa%40ss@1.2.3.4:1080' },
      kernel_version: '149.0.0.0',
      persona: LAUNCHER_PERSONA,
      api_log: 'off',
      canvas_noise: true,
      webauthn_capture: true,
      ...overrides,
    },
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  for (const [name, body] of Object.entries(files)) zip.addFile(name, Buffer.from(body))
  return zip.toBuffer()
}

describe('profile-cache', () => {
  it('packs persona.json + the user-data engine items and roundtrips, excluding everything else', () => {
    const src = tmp('pc-src-')
    const ud = path.join(src, 'user-data')
    // synced under user-data/: Default/ (dir), GrShaderCache/ (dir), Local State (file), Variations (file)
    fs.mkdirSync(path.join(ud, 'Default'), { recursive: true })
    fs.writeFileSync(path.join(ud, 'Default', 'Cookies'), 'cookie-data')
    fs.mkdirSync(path.join(ud, 'GrShaderCache'))
    fs.writeFileSync(path.join(ud, 'GrShaderCache', 'shader'), 'sh')
    fs.writeFileSync(path.join(ud, 'Local State'), 'local-state')
    fs.writeFileSync(path.join(ud, 'Variations'), 'variations-seed')
    // synced root item: persona.json (identity)
    fs.writeFileSync(path.join(src, 'persona.json'), '{"ua":"UA"}')
    // NOT synced: a big Cache dir + a lock file under user-data
    fs.mkdirSync(path.join(ud, 'Cache'))
    fs.writeFileSync(path.join(ud, 'Cache', 'data_0'), 'big-cache')
    fs.writeFileSync(path.join(ud, 'lockfile'), 'x')

    const buf = packProfileCache(src)
    const dst = tmp('pc-dst-')
    unpackProfileCache(buf, dst)

    expect(fs.readFileSync(path.join(dst, 'user-data', 'Default', 'Cookies'), 'utf8')).toBe('cookie-data')
    expect(fs.readFileSync(path.join(dst, 'user-data', 'GrShaderCache', 'shader'), 'utf8')).toBe('sh')
    expect(fs.readFileSync(path.join(dst, 'user-data', 'Local State'), 'utf8')).toBe('local-state')
    expect(fs.readFileSync(path.join(dst, 'user-data', 'Variations'), 'utf8')).toBe('variations-seed')
    expect(fs.readFileSync(path.join(dst, 'persona.json'), 'utf8')).toBe('{"ua":"UA"}')

    // excluded items must NOT be in the archive
    expect(fs.existsSync(path.join(dst, 'user-data', 'Cache'))).toBe(false)
    expect(fs.existsSync(path.join(dst, 'user-data', 'lockfile'))).toBe(false)
  })

  it('syncs passkeys.json: the kernel keeps passkeys outside user-data, so cloud sync must carry it', () => {
    const src = tmp('pc-pk-')
    fs.mkdirSync(path.join(src, 'user-data', 'Default'), { recursive: true })
    fs.writeFileSync(path.join(src, 'user-data', 'Default', 'Cookies'), 'ck')
    fs.writeFileSync(path.join(src, 'persona.json'), '{"ua":"UA"}')
    fs.writeFileSync(path.join(src, 'passkeys.json'), '[{"rpId":"google.com"}]')

    const buf = packProfileCache(src)
    const dst = tmp('pc-pk-dst-')
    unpackProfileCache(buf, dst)

    expect(fs.readFileSync(path.join(dst, 'passkeys.json'), 'utf8')).toBe('[{"rpId":"google.com"}]')
  })

  it('leaves a local passkeys.json alone when the archive predates passkey sync', () => {
    const src = tmp('pc-pk-old-')
    fs.mkdirSync(path.join(src, 'user-data'), { recursive: true })
    fs.writeFileSync(path.join(src, 'user-data', 'Local State'), 'ls')
    const buf = packProfileCache(src)

    const dst = tmp('pc-pk-old-dst-')
    fs.writeFileSync(path.join(dst, 'passkeys.json'), '[{"rpId":"local-only"}]')
    unpackProfileCache(buf, dst)

    expect(fs.readFileSync(path.join(dst, 'passkeys.json'), 'utf8')).toBe('[{"rpId":"local-only"}]')
  })

  it('skips missing items without throwing', () => {
    const src = tmp('pc-empty-')
    fs.mkdirSync(path.join(src, 'user-data'), { recursive: true })
    fs.writeFileSync(path.join(src, 'user-data', 'Local State'), 'only-this')
    const buf = packProfileCache(src)
    const dst = tmp('pc-empty-dst-')
    unpackProfileCache(buf, dst)
    expect(fs.readFileSync(path.join(dst, 'user-data', 'Local State'), 'utf8')).toBe('only-this')
    expect(fs.existsSync(path.join(dst, 'user-data', 'Default'))).toBe(false)
  })

  it('skips cache subdirs inside Default so a locked Cache DB never fails packing', () => {
    const src = tmp('pc-cache-')
    const ud = path.join(src, 'user-data')
    fs.mkdirSync(path.join(ud, 'Default', 'Cache', 'Cache_Data'), { recursive: true })
    fs.writeFileSync(path.join(ud, 'Default', 'Cache', 'Cache_Data', 'sqldb0'), 'cache-db')
    fs.mkdirSync(path.join(ud, 'Default', 'Code Cache'), { recursive: true })
    fs.writeFileSync(path.join(ud, 'Default', 'Code Cache', 'x'), 'cc')
    // real state that MUST survive:
    fs.writeFileSync(path.join(ud, 'Default', 'Cookies'), 'ck')

    const buf = packProfileCache(src)
    const dst = tmp('pc-cache-dst-')
    unpackProfileCache(buf, dst)

    expect(fs.readFileSync(path.join(dst, 'user-data', 'Default', 'Cookies'), 'utf8')).toBe('ck')
    expect(fs.existsSync(path.join(dst, 'user-data', 'Default', 'Cache'))).toBe(false)
    expect(fs.existsSync(path.join(dst, 'user-data', 'Default', 'Code Cache'))).toBe(false)
  })

  // Restoring used to merge into whatever was already on disk. Chromium picks
  // the session to restore by the timestamp in the file name, so a leftover
  // Sessions/Session_<newer> from this machine silently outranked the restored
  // one and the profile opened with the wrong machine's tabs - the "tabs are
  // sometimes there, sometimes not" report.
  it('replaces user-data state instead of merging, so stale local files cannot outrank the archive', () => {
    const src = tmp('pc-repl-src-')
    const srcUd = path.join(src, 'user-data')
    fs.mkdirSync(path.join(srcUd, 'Default', 'Sessions'), { recursive: true })
    fs.writeFileSync(path.join(srcUd, 'Default', 'Sessions', 'Session_100'), 'from-cloud')
    fs.writeFileSync(path.join(srcUd, 'Default', 'Cookies'), 'cloud-cookies')
    fs.writeFileSync(path.join(srcUd, 'Local State'), 'cloud-local-state')
    const buf = packProfileCache(src)

    const dst = tmp('pc-repl-dst-')
    const dstUd = path.join(dst, 'user-data')
    fs.mkdirSync(path.join(dstUd, 'Default', 'Sessions'), { recursive: true })
    // A newer session this machine wrote, absent from the archive.
    fs.writeFileSync(path.join(dstUd, 'Default', 'Sessions', 'Session_999'), 'stale-local')
    // A write-ahead log for a database the archive replaces: replaying it over
    // the restored Cookies is how a cross-machine profile half loses its logins.
    fs.writeFileSync(path.join(dstUd, 'Default', 'Cookies-wal'), 'stale-wal')
    fs.mkdirSync(path.join(dstUd, 'Default', 'Local Storage', 'leveldb'), { recursive: true })
    fs.writeFileSync(path.join(dstUd, 'Default', 'Local Storage', 'leveldb', '000009.log'), 'stale-ldb')
    // Disposable, and expensive to refetch: must survive.
    fs.mkdirSync(path.join(dstUd, 'Default', 'Cache'), { recursive: true })
    fs.writeFileSync(path.join(dstUd, 'Default', 'Cache', 'data_0'), 'keep-cache')

    unpackProfileCache(buf, dst)

    expect(fs.readFileSync(path.join(dstUd, 'Default', 'Sessions', 'Session_100'), 'utf8')).toBe('from-cloud')
    expect(fs.existsSync(path.join(dstUd, 'Default', 'Sessions', 'Session_999'))).toBe(false)
    expect(fs.existsSync(path.join(dstUd, 'Default', 'Cookies-wal'))).toBe(false)
    expect(fs.existsSync(path.join(dstUd, 'Default', 'Local Storage', 'leveldb', '000009.log'))).toBe(false)
    expect(fs.readFileSync(path.join(dstUd, 'Default', 'Cookies'), 'utf8')).toBe('cloud-cookies')
    expect(fs.readFileSync(path.join(dstUd, 'Default', 'Cache', 'data_0'), 'utf8')).toBe('keep-cache')
  })

  // A live Chromium can hold `Local State` open while the browser is killed
  // past its grace period, so `addDirSafe`/`zip.addFile` silently omit it from
  // the archive that still uploads fine. The old unconditional clear would then
  // delete the local copy on the next restore and put nothing back -
  // `os_crypt.encrypted_key` lives there, so every cookie/password becomes
  // undecryptable with no error anywhere.
  it('leaves a local item alone when the archive never mentions it at all, while still replacing items it does carry', () => {
    const src = tmp('pc-partial-src-')
    const srcUd = path.join(src, 'user-data')
    fs.mkdirSync(path.join(srcUd, 'Default'), { recursive: true })
    fs.writeFileSync(path.join(srcUd, 'Default', 'Cookies'), 'cloud-cookies')
    // Local State deliberately absent from the source, simulating a pack that
    // silently skipped it.
    const buf = packProfileCache(src)
    expect(new AdmZip(buf).getEntries().map((e) => e.entryName)).not.toContain('user-data/Local State')

    const dst = tmp('pc-partial-dst-')
    const dstUd = path.join(dst, 'user-data')
    fs.mkdirSync(path.join(dstUd, 'Default'), { recursive: true })
    fs.writeFileSync(path.join(dstUd, 'Default', 'Cookies'), 'stale-local-cookies')
    fs.writeFileSync(path.join(dstUd, 'Local State'), 'local-encrypted-key')

    unpackProfileCache(buf, dst)

    // Default was in the archive: replaced, not merged.
    expect(fs.readFileSync(path.join(dstUd, 'Default', 'Cookies'), 'utf8')).toBe('cloud-cookies')
    // Local State was not in the archive at all: left exactly as it was.
    expect(fs.readFileSync(path.join(dstUd, 'Local State'), 'utf8')).toBe('local-encrypted-key')
  })

  it('keeps the profile intact when the archive is unreadable', () => {
    const dst = tmp('pc-bad-')
    const ud = path.join(dst, 'user-data')
    fs.mkdirSync(path.join(ud, 'Default'), { recursive: true })
    fs.writeFileSync(path.join(ud, 'Default', 'Cookies'), 'local-cookies')

    expect(() => unpackProfileCache(Buffer.from('not a zip at all'), dst)).toThrow()
    expect(fs.readFileSync(path.join(ud, 'Default', 'Cookies'), 'utf8')).toBe('local-cookies')
  })

  // Device-bound session keys live in the OS keystore and cannot be exported.
  // Shipping the records only guarantees the next machine is refused.
  it('never carries device-bound session records, and drops any it finds on restore', () => {
    const src = tmp('pc-dbsc-src-')
    const srcNet = path.join(src, 'user-data', 'Default', 'Network')
    fs.mkdirSync(srcNet, { recursive: true })
    fs.writeFileSync(path.join(srcNet, 'Cookies'), 'ck')
    fs.writeFileSync(path.join(srcNet, 'Device Bound Sessions'), 'bound-to-machine-a')
    fs.writeFileSync(path.join(srcNet, 'Device Bound Sessions-journal'), '')

    const entries = new AdmZip(packProfileCache(src)).getEntries().map((e) => e.entryName)
    expect(entries).toContain('user-data/Default/Network/Cookies')
    expect(entries.some((n) => n.includes('Device Bound Sessions'))).toBe(false)

    const dst = tmp('pc-dbsc-dst-')
    const dstNet = path.join(dst, 'user-data', 'Default', 'Network')
    fs.mkdirSync(dstNet, { recursive: true })
    fs.writeFileSync(path.join(dstNet, 'Device Bound Sessions'), 'bound-to-machine-b')
    unpackProfileCache(packProfileCache(src), dst)

    expect(fs.existsSync(path.join(dstNet, 'Device Bound Sessions'))).toBe(false)
  })

  it('still imports the legacy AntiBrow .zip export (profile.json entry)', () => {
    const legacy = new AdmZip()
    legacy.addFile('profile.json', Buffer.from(JSON.stringify({
      name: 'Amazon US', group: 'Ecom', tags: ['a', 'b'], kernelVersion: '149.0.0.0',
    })))
    legacy.addFile('persona.json', Buffer.from('{"ua":"UA"}'))
    legacy.addFile('user-data/Local State', Buffer.from('ls'))

    const dst = tmp('legacy-dst-')
    const got = importProfileArchive(legacy.toBuffer(), dst)

    expect(got.source).toBe('legacy')
    expect(got.name).toBe('Amazon US')
    expect(got.kernelVersion).toBe('149')
    expect(got.extra).toEqual({ group: 'Ecom', tags: ['a', 'b'] })
    expect(fs.readFileSync(path.join(dst, 'persona.json'), 'utf8')).toBe('{"ua":"UA"}')
    expect(fs.readFileSync(path.join(dst, 'user-data', 'Local State'), 'utf8')).toBe('ls')
    // the metadata entry must not be left behind as a stray file in the profile dir
    expect(fs.existsSync(path.join(dst, 'profile.json'))).toBe(false)
  })

  it('keeps the directory identity record a legacy import would overwrite', () => {
    // The legacy export reused the identity record's filename, so importing on
    // top of a resolved directory must not leave it record-less: the profile
    // would resolve as a nameless legacy directory ever after.
    const dst = tmp('legacy-keep-')
    const record = JSON.stringify({ id: 'uuid-a', name: 'gmail', origin: 'server' })
    fs.writeFileSync(path.join(dst, 'profile.json'), record, 'utf8')

    const legacy = new AdmZip()
    legacy.addFile('profile.json', Buffer.from(JSON.stringify({ name: 'Amazon US', kernelVersion: '149.0.0.0' })))
    legacy.addFile('persona.json', Buffer.from('{"ua":"UA"}'))
    const got = importProfileArchive(legacy.toBuffer(), dst)

    expect(got.name).toBe('Amazon US')
    expect(fs.readFileSync(path.join(dst, 'profile.json'), 'utf8')).toBe(record)
  })

  it('never packs the identity record: it belongs to this machine only', () => {
    const dir = tmp('pc-meta-')
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id: 'uuid-a', name: 'gmail', origin: 'server' }), 'utf8')
    // Export no longer creates an identity, so this profile has to have one.
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(generatePersona(150, '150.0.0.0')), 'utf8')
    const zip = packProfileCache(dir)
    const names = new AdmZip(zip).getEntries().map((e) => e.entryName)
    expect(names).not.toContain('profile.json')
    const portable = exportProfileArchive(dir, { id: 'uuid-a', name: 'gmail', kernelVersion: '150.0.0.0' })
    expect(new AdmZip(portable).getEntries().map((e) => e.entryName)).not.toContain('profile.json')
  })
})

describe('exportProfileArchive — the portable .fpprofile format', () => {
  /** A profile dir with a persona, browser state, junk that must not travel, and a passkey store. */
  function seedProfile(): string {
    const src = tmp('exp-src-')
    const ud = path.join(src, 'user-data')
    const w = (rel: string, body: string) => {
      const p = path.join(ud, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body)
    }
    fs.mkdirSync(ud, { recursive: true })
    fs.writeFileSync(path.join(src, 'persona.json'), JSON.stringify({
      seed: LAUNCHER_PERSONA.seed, canvasSeed: LAUNCHER_PERSONA.canvas_seed,
      audioSeed: LAUNCHER_PERSONA.audio_seed, domrectSeed: LAUNCHER_PERSONA.domrect_seed,
      chromeMajor: 149, kernelVersion: '149.0.0.0', ua: LAUNCHER_PERSONA.ua,
      hardwareConcurrency: 12, deviceMemory: 16, screenW: 1536, screenH: 864,
      devicePixelRatio: 1.25, gpuVendor: LAUNCHER_PERSONA.gpu_vendor,
      gpuRenderer: LAUNCHER_PERSONA.gpu_renderer, languages: ['de-DE', 'de', 'en'],
      timezone: 'Europe/Berlin',
    }))
    fs.writeFileSync(path.join(src, 'passkeys.json'), '[{"rpId":"example.com"}]')
    w('Local State', 'ls')
    w('Default/Cookies', 'SQLITE')
    w('Default/Cookies-wal', 'WAL')            // SQLite sibling rides along
    w('Default/Network/Cookies', 'NETCOOKIE')
    w('Default/Local Storage/leveldb/CURRENT', 'MANIFEST')
    w('Default/Last Session', 'LASTSESSION')   // tab restore
    w('Default/Cache/data_0', 'CACHEJUNK')     // must NOT travel
    w('Default/GPUCache/data_1', 'GPUJUNK')    // must NOT travel
    return src
  }

  const META = {
    id: 'a1b2c3d4e5f60718',
    name: 'Berlin-01',
    kernelVersion: '149.0.0.0',
    proxyUrl: 'socks5://user:pass@1.2.3.4:1080',
    apiLog: 'curated' as const,
    canvasNoise: false,
    webauthnCapture: false,
    extra: { group: 'Ecom', tags: ['a', 'b'], note: 'keep' },
  }

  it('writes a manifest the launcher itself can deserialize', () => {
    const zip = new AdmZip(exportProfileArchive(seedProfile(), META))
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8')) as {
      format: string; version: number; profile: Record<string, unknown>; antibrow: Record<string, unknown>
    }
    expect(manifest.format).toBe('fp-launcher-profile')
    expect(manifest.version).toBe(1)
    // Every field the launcher's serde requires (no #[serde(default)] on these).
    expect(manifest.profile).toMatchObject({
      id: META.id,
      name: 'Berlin-01',
      proxy: { raw: META.proxyUrl },
      kernel_version: '149',
      api_log: 'curated',
      canvas_noise: false,
      webauthn_capture: false,
    })
    // Persona is written in the launcher's snake_case schema.
    expect(manifest.profile.persona).toMatchObject({
      seed: LAUNCHER_PERSONA.seed,
      canvas_seed: LAUNCHER_PERSONA.canvas_seed,
      audio_seed: LAUNCHER_PERSONA.audio_seed,
      domrect_seed: LAUNCHER_PERSONA.domrect_seed,
      chrome_major: 149,
      ua: LAUNCHER_PERSONA.ua,
      hardware_concurrency: 12,
      device_memory: 16,
      screen_w: 1536,
      screen_h: 864,
      device_pixel_ratio: 1.25,
      gpu_vendor: LAUNCHER_PERSONA.gpu_vendor,
      gpu_renderer: LAUNCHER_PERSONA.gpu_renderer,
      languages: ['de-DE', 'de', 'en'],
      timezone: 'Europe/Berlin',
    })
    // AntiBrow-only metadata sits outside `profile`, where the launcher ignores it.
    expect(manifest.antibrow).toEqual(META.extra)
    expect(manifest.profile).not.toHaveProperty('group')
  })

  it('packs the shared browser-state whitelist and leaves caches behind', () => {
    const zip = new AdmZip(exportProfileArchive(seedProfile(), META))
    const names = zip.getEntries().map((e) => e.entryName)
    expect(names).toEqual(expect.arrayContaining([
      'manifest.json',
      'passkeys.json',
      'user-data/Local State',
      'user-data/Default/Cookies',
      'user-data/Default/Cookies-wal',
      'user-data/Default/Network/Cookies',
      'user-data/Default/Local Storage/leveldb/CURRENT',
      'user-data/Default/Last Session',
    ]))
    expect(names.some((n) => n.includes('Cache'))).toBe(false)
  })

  it('round-trips identity, kernel switches and our extras', () => {
    const src = seedProfile()
    const dst = tmp('exp-dst-')
    const got = importProfileArchive(exportProfileArchive(src, META), dst)

    expect(got).toMatchObject({
      source: 'launcher',
      id: META.id,
      name: 'Berlin-01',
      kernelVersion: expectedResolvedKernelVersion('149.0.0.0'),
      proxyUrl: META.proxyUrl,
      apiLog: 'curated',
      canvasNoise: false,
      webauthnCapture: false,
      extra: META.extra,
    })
    // Identity is byte-identical across the trip, except chromeMajor/kernelVersion/ua,
    // which the implementation deliberately rewrites to whatever kernel this
    // platform can actually launch (see `launcherPersonaToPersona`'s "UA major
    // must match the kernel actually launched"). Derive the expected override
    // the same way the implementation resolves it, rather than assuming the
    // exact requested version is always available.
    const srcPersona = JSON.parse(fs.readFileSync(path.join(src, 'persona.json'), 'utf8')) as Persona
    const dstPersona = JSON.parse(fs.readFileSync(path.join(dst, 'persona.json'), 'utf8')) as Persona
    const resolvedKernelVersion = expectedResolvedKernelVersion(META.kernelVersion)
    const resolvedChromeMajor = parseInt(resolvedKernelVersion, 10)
    expect(dstPersona).toEqual({
      ...srcPersona,
      chromeMajor: resolvedChromeMajor,
      kernelVersion: resolvedKernelVersion,
      ua: srcPersona.ua.replace(/Chrome\/\d+/, `Chrome/${resolvedChromeMajor}`),
    })
    expect(fs.readFileSync(path.join(dst, 'user-data', 'Default', 'Network', 'Cookies'), 'utf8')).toBe('NETCOOKIE')
    expect(fs.readFileSync(path.join(dst, 'passkeys.json'), 'utf8')).toBe('[{"rpId":"example.com"}]')
    expect(fs.existsSync(path.join(dst, 'manifest.json'))).toBe(false)
  })

  it('defaults the kernel switches when the profile never set them', () => {
    const zip = new AdmZip(exportProfileArchive(seedProfile(), { name: 'Plain', kernelVersion: '149.0.0.0' }))
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8')) as { profile: Record<string, unknown> }
    expect(manifest.profile).toMatchObject({ api_log: 'off', canvas_noise: true, webauthn_capture: true, proxy: { raw: '' } })
  })
})

describe('importProfileArchive - launcher format (.fpprofile)', () => {
  it('translates the launcher manifest into persona.json and restores its browser state', () => {
    const buf = launcherArchive({}, {
      'user-data/Local State': 'ls',
      'user-data/Default/Network/Cookies': 'SQLITE',
      'user-data/Default/Local Storage/leveldb/CURRENT': 'MANIFEST',
      'passkeys.json': '[{"credentialId":"AAA","rpId":"example.com"}]',
    })
    const dst = tmp('fpp-')
    const meta = importProfileArchive(buf, dst)

    expect(meta).toMatchObject({
      source: 'launcher',
      name: 'Berlin-01',
      kernelVersion: expectedResolvedKernelVersion('149.0.0.0'),
      proxyUrl: 'socks5://user:pa%40ss@1.2.3.4:1080',
    })

    // Every fingerprint fact survives the snake_case → camelCase translation, so
    // the imported profile renders the identity it had in the launcher — except
    // chromeMajor/kernelVersion/ua, which the implementation deliberately
    // rewrites to whatever kernel this platform can actually launch (see
    // `launcherPersonaToPersona`'s "UA major must match the kernel actually
    // launched"). Derive the expected values the same way, so the assertion
    // states the real cross-platform rule rather than one platform's answer.
    const resolvedKernelVersion = expectedResolvedKernelVersion('149.0.0.0')
    const resolvedChromeMajor = parseInt(resolvedKernelVersion, 10)
    const persona = JSON.parse(fs.readFileSync(path.join(dst, 'persona.json'), 'utf8')) as Persona
    expect(persona).toMatchObject({
      seed: '0123456789abcdef',
      canvasSeed: 'aaaaaaaaaaaaaaaa',
      audioSeed: 'bbbbbbbbbbbbbbbb',
      domrectSeed: 'cccccccccccccccc',
      chromeMajor: resolvedChromeMajor,
      kernelVersion: resolvedKernelVersion,
      ua: LAUNCHER_PERSONA.ua.replace(/Chrome\/\d+/, `Chrome/${resolvedChromeMajor}`),
      hardwareConcurrency: 12,
      deviceMemory: 16,
      screenW: 1536,
      screenH: 864,
      devicePixelRatio: 1.25,
      gpuVendor: LAUNCHER_PERSONA.gpu_vendor,
      gpuRenderer: LAUNCHER_PERSONA.gpu_renderer,
      languages: ['de-DE', 'de', 'en'],
      timezone: 'Europe/Berlin',
    })

    // The launcher's user-data layout is ours, so cookies/storage land in place.
    expect(fs.readFileSync(path.join(dst, 'user-data', 'Local State'), 'utf8')).toBe('ls')
    expect(fs.readFileSync(path.join(dst, 'user-data', 'Default', 'Network', 'Cookies'), 'utf8')).toBe('SQLITE')
    expect(fs.readFileSync(path.join(dst, 'user-data', 'Default', 'Local Storage', 'leveldb', 'CURRENT'), 'utf8')).toBe('MANIFEST')
    expect(fs.existsSync(path.join(dst, 'passkeys.json'))).toBe(true)
    // manifest.json is translated, not copied — it must not litter the profile dir
    expect(fs.existsSync(path.join(dst, 'manifest.json'))).toBe(false)
  })

  it('replays a captured real-device WebGL report through to fp-config', () => {
    const captured = {
      UNMASKED_VENDOR: 'Google Inc. (NVIDIA)',
      VERSION: 'WebGL 2.0 (OpenGL ES 3.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)',
      params: { '3379': 16384, '34076': 16384 },
      shaderPrecision: { VERTEX_HIGH_FLOAT: [127, 127, 23], bogus: [1, 2] },
    }
    const buf = launcherArchive({ persona: { ...LAUNCHER_PERSONA, captured_webgl: captured } })
    const dst = tmp('fpp-webgl-')
    importProfileArchive(buf, dst)

    const persona = JSON.parse(fs.readFileSync(path.join(dst, 'persona.json'), 'utf8')) as Persona
    expect(persona.capturedWebgl).toEqual(captured)

    const cfg = personaToFpConfig(persona, { label: 'x', timezone: 'Europe/Berlin' })
    expect(cfg.webgl).toMatchObject({
      unmaskedVendor: LAUNCHER_PERSONA.gpu_vendor,
      unmaskedRenderer: LAUNCHER_PERSONA.gpu_renderer,
      version: captured.VERSION,
      shadingLanguageVersion: captured.SHADING_LANGUAGE_VERSION,
      params: captured.params,
      // triples become "min,max,precision"; malformed entries are dropped
      shaderPrecision: { VERTEX_HIGH_FLOAT: '127,127,23' },
    })
    // What the capture omits comes from the Windows baseline, never from the
    // host GPU: a half-replayed report is the contradiction to avoid.
    expect((cfg.webgl as Record<string, unknown>).version2).toBe('OpenGL ES 3.0 Chromium')
  })

  it('reads the profile switches (api log / canvas noise / passkey capture) off the manifest', () => {
    const custom = importProfileArchive(
      launcherArchive({ api_log: 'all', canvas_noise: false, webauthn_capture: false }), tmp('fpp-sw-'))
    expect(custom).toMatchObject({ apiLog: 'all', canvasNoise: false, webauthnCapture: false })

    const defaults = importProfileArchive(launcherArchive(), tmp('fpp-sw-def-'))
    expect(defaults).toMatchObject({ apiLog: 'off', canvasNoise: true, webauthnCapture: true })

    // An api_log value we don't know degrades to 'off' rather than reaching the kernel.
    const bogus = importProfileArchive(launcherArchive({ api_log: 'verbose' }), tmp('fpp-sw-bad-'))
    expect(bogus.apiLog).toBe('off')
  })

  it('turns those switches into the fp-config the kernel reads', () => {
    const persona = JSON.parse(
      fs.readFileSync(path.join((() => { const d = tmp('fpp-cfg-'); importProfileArchive(launcherArchive(), d); return d })(), 'persona.json'), 'utf8'),
    ) as Persona

    const off = personaToFpConfig(persona, { label: 'x', timezone: 'UTC', canvasNoise: false, apiLog: 'curated', apiLogPath: 'C:/p/fp-api-log.jsonl' })
    expect(off.canvas).toMatchObject({ mode: 'off' })
    expect(off.webgl).toMatchObject({ mode: 'off' })
    expect(off.apilog).toEqual({ enabled: true, mode: 'curated', path: 'C:/p/fp-api-log.jsonl' })

    // Defaults stay byte-identical to what we emitted before these options existed.
    const plain = personaToFpConfig(persona, { label: 'x', timezone: 'UTC' })
    expect(plain.canvas).not.toHaveProperty('mode')
    expect(plain.webgl).not.toHaveProperty('mode')
    expect(plain.apilog).toEqual({ enabled: false, mode: 'off', path: '' })
  })

  it('supplies the full UA-CH metadata group so nothing falls back to the real host', () => {
    const persona = generatePersona(150, '150.0.0.0')
    const cfg = personaToFpConfig(persona, { label: 'x', timezone: 'UTC' })
    // Any key missing here means the kernel falls back to the real host value
    // for that key - exactly the leak this test guards against.
    expect((cfg.navigator as Record<string, unknown>).uaData).toEqual({
      platform: 'Windows', // UA-CH naming, not navigator.platform's "Win32"
      platformVersion: '15.0.0',
      architecture: 'x86', // UA-CH reports x86 even on x64 hardware
      bitness: '64',
      wow64: false,
      model: '',
    })
  })

  it('derives the WebGPU identity from the WebGL renderer', () => {
    const dir = tmp('fpp-gpu-')
    importProfileArchive(launcherArchive(), dir)
    const persona = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8')) as Persona
    const webgpuFor = (gpuRenderer: string) =>
      personaToFpConfig({ ...persona, gpuRenderer }, { label: 'x', timezone: 'UTC' }).webgpu

    // The launcher's `webgpu_identity` mapping, so navigator.gpu names the same
    // GPU as WebGL instead of leaking the real adapter.
    expect(webgpuFor('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3699)'))
      .toEqual({ vendor: 'nvidia', architecture: '' }) // NVIDIA on D3D reports no architecture
    expect(webgpuFor('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.12027.9001)'))
      .toEqual({ vendor: 'amd', architecture: 'rdna-3' })
    expect(webgpuFor('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.4577)'))
      .toEqual({ vendor: 'intel', architecture: 'gen-12lp' })
    expect(webgpuFor('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.9316)'))
      .toEqual({ vendor: 'intel', architecture: 'gen-9' })
    expect(webgpuFor('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'))
      .toEqual({ vendor: 'intel', architecture: 'xe-lpg' })
    // Unknown vendor: say nothing rather than guess — the kernel keeps the real values.
    expect(webgpuFor('SwiftShader')).toEqual({})

    // Every GPU we can generate must resolve to a spoofed identity, or a persona
    // of ours would ship the mismatch this field exists to prevent.
    for (let i = 0; i < 40; i++) {
      expect(personaToFpConfig(generatePersona(150, '150.0.0.0'), { label: 'x', timezone: 'UTC' }).webgpu)
        .not.toEqual({})
    }
  })

  it('falls back to an installable kernel and restamps the UA major when the exported one is unknown', () => {
    const buf = launcherArchive({
      kernel_version: '77.0.1.1',
      persona: { ...LAUNCHER_PERSONA, chrome_major: 77, ua: LAUNCHER_PERSONA.ua.replace('Chrome/149', 'Chrome/77') },
    })
    const dst = tmp('fpp-kv-')
    const meta = importProfileArchive(buf, dst) as { kernelVersion: string }

    expect(meta.kernelVersion).toBe(DEFAULT_KERNEL_VERSION.version)
    const persona = JSON.parse(fs.readFileSync(path.join(dst, 'persona.json'), 'utf8')) as Persona
    const major = Number(DEFAULT_KERNEL_VERSION.version.split('.')[0])
    expect(persona.kernelVersion).toBe(DEFAULT_KERNEL_VERSION.version)
    expect(persona.chromeMajor).toBe(major)
    expect(persona.ua).toContain(`Chrome/${major}.0.0.0`)
    // identity facts are untouched by the kernel swap
    expect(persona.seed).toBe(LAUNCHER_PERSONA.seed)
  })

  it('rejects a foreign format and a format version it cannot read', () => {
    const foreign = new AdmZip()
    foreign.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'some-other-tool', version: 1 })))
    expect(() => importProfileArchive(foreign.toBuffer(), tmp('fpp-bad-'))).toThrow(/Unsupported profile archive format/)

    const newer = new AdmZip()
    newer.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'fp-launcher-profile', version: 99, profile: {} })))
    expect(() => importProfileArchive(newer.toBuffer(), tmp('fpp-new-'))).toThrow(/newer launcher/)
  })

  it('ignores entries that would escape the profile directory (zip slip)', () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      format: 'fp-launcher-profile', version: 1,
      profile: { name: 'Evil', kernel_version: '149.0.0.0', persona: LAUNCHER_PERSONA },
    })))
    zip.addFile('user-data/../../pwned.txt', Buffer.from('nope'))
    const parent = tmp('fpp-slip-')
    const dst = path.join(parent, 'profile')
    importProfileArchive(zip.toBuffer(), dst)

    expect(fs.existsSync(path.join(parent, '..', 'pwned.txt'))).toBe(false)
    expect(fs.existsSync(path.join(dst, 'persona.json'))).toBe(true)
  })
})

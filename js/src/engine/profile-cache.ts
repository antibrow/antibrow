import AdmZip from 'adm-zip'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_KERNEL_VERSION, kernelsForPlatform } from './downloader'
import { generatePersona, loadOrGeneratePersona, type ApiLogMode, type Persona } from './persona'

// Browser state items stored under <profileDir>/user-data/
const USER_DATA_ITEMS = ['Default', 'GrShaderCache', 'Local State', 'Variations'] as const

// The kernel's portable passkey store (`--fp-webauthn-store`), written at the
// profile root rather than inside user-data.
const PASSKEYS_ENTRY = 'passkeys.json'

// Root-level items (relative to profileDir). passkeys.json belongs here or a
// passkey registered on one machine never reaches the next one.
const ROOT_ITEMS = ['persona.json', PASSKEYS_ENTRY] as const

/**
 * Which generation of the cloud archive this machine holds. Machine-local: it is
 * not in ROOT_ITEMS, so it never gets packed, and an import clears it because
 * the generation of imported state is unknowable.
 */
export const ARCHIVE_VERSION_FILE = '.archive-version'

export function readArchiveVersion(profileDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(profileDir, ARCHIVE_VERSION_FILE), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

export function writeArchiveVersion(profileDir: string, version: string): void {
  try {
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(path.join(profileDir, ARCHIVE_VERSION_FILE), version)
  } catch { /* a lost marker only costs one redundant download */ }
}

export function clearArchiveVersion(profileDir: string): void {
  fs.rmSync(path.join(profileDir, ARCHIVE_VERSION_FILE), { force: true })
}

/** R2 hands back the ETag quoted; the marker stores it bare. */
export function normalizeArchiveVersion(etag: string | null | undefined): string | undefined {
  const v = (etag ?? '').trim().replace(/^"|"$/g, '')
  return v || undefined
}

// Lock files that are always in use while Chrome runs.
const SKIP_FILES = new Set(['LOCK', 'lock', '.lock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'])

// Device-bound session records. Their private keys live in the OS keystore
// (Secure Enclave / TPM) and cannot be exported, so carrying the records to
// another machine only makes Google refuse the session outright.
const DBSC_FILES = new Set(['Device Bound Sessions', 'Device Bound Sessions-journal'])

// Disposable cache dirs: big, often locked, and rebuilt by Chrome anyway.
const SKIP_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GraphiteDawnCache', 'ShaderCache', 'Service Worker', 'blob_storage', 'Application Cache',
  'File System', 'GCM Store', 'optimization_guide_model_store', 'component_crx_cache',
  'extensions_crx_cache', 'Crashpad', 'segmentation_platform',
])

/** Add a directory recursively, skipping cache dirs and unreadable files. */
function addDirSafe(zip: AdmZip, absDir: string, zipBase: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP_FILES.has(e.name) || DBSC_FILES.has(e.name)) continue
    const abs = path.join(absDir, e.name)
    const zipPath = zipBase ? `${zipBase}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      addDirSafe(zip, abs, zipPath)
    } else if (e.isFile()) {
      try {
        zip.addFile(zipPath, fs.readFileSync(abs))
      } catch { /* locked or unreadable: skip */ }
    }
  }
}

/**
 * Delete a directory's packable contents, keeping only what a pack skips.
 * Returns true when nothing was kept, so the caller can drop the directory too.
 */
function clearDirSafe(absDir: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return false
  }
  let kept = 0
  for (const e of entries) {
    const abs = path.join(absDir, e.name)
    if (SKIP_FILES.has(e.name)) { kept++; continue }
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
      if (clearDirSafe(abs)) {
        try { fs.rmdirSync(abs) } catch { kept++ }
      } else {
        kept++
      }
      continue
    }
    if (e.isDirectory()) { kept++; continue }
    try { fs.rmSync(abs, { force: true }) } catch { kept++ }
  }
  return kept === 0
}

/**
 * Which top-level USER_DATA_ITEMS a zip's entries actually carry. An item the
 * archive is silent about was never packed in the first place - a live
 * Chromium can hold `Local State` open, `addDirSafe`/`zip.addFile` swallow the
 * read error, and the resulting archive uploads fine with that item simply
 * missing. Clearing it anyway would delete the local copy and put nothing
 * back: for `Local State` that is `os_crypt.encrypted_key`, so every cookie
 * and saved password in the profile becomes undecryptable.
 */
function packedItems(entries: readonly { entryName: string }[]): Set<string> {
  const present = new Set<string>()
  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, '/')
    if (!name.startsWith('user-data/')) continue
    const item = name.slice('user-data/'.length).split('/')[0]
    if (item) present.add(item)
  }
  return present
}

/**
 * Wipe everything a pack would have carried, so restoring replaces the profile's
 * state instead of merging into it. Leftovers are not inert: Chromium picks the
 * session to restore by the timestamp in the file name, so a local
 * `Sessions/Session_<newer>` silently outranks the restored one and the profile
 * opens with the wrong machine's tabs. Same story for leveldb and the SQLite
 * -wal/-journal siblings of a database the archive replaced.
 *
 * Skipped cache dirs stay: they are disposable and re-downloading them buys
 * nothing. Files the pack refuses (device-bound sessions) are removed here,
 * which is the point -- nothing puts them back.
 *
 * ROOT_ITEMS are deliberately left alone. They are standalone JSON with no
 * cross-file state to tear, and an archive written before they were synced must
 * not delete them: persona.json IS the profile's identity, and losing it means
 * regenerating a different fingerprint.
 */
function clearPackedState(profileDir: string, entries: readonly { entryName: string }[]): void {
  const present = packedItems(entries)
  const udDir = path.join(profileDir, 'user-data')
  for (const item of USER_DATA_ITEMS) {
    if (!present.has(item)) continue
    const p = path.join(udDir, item)
    let stat: fs.Stats
    try { stat = fs.statSync(p) } catch { continue }
    if (stat.isDirectory()) clearDirSafe(p)
    else fs.rmSync(p, { force: true })
  }
}

/** Zip the profile's synced items. Locked files are skipped, never fatal. */
export function packProfileCache(profileDir: string): Buffer {
  const zip = new AdmZip()

  for (const item of ROOT_ITEMS) {
    const p = path.join(profileDir, item)
    try { if (fs.existsSync(p)) zip.addFile(item, fs.readFileSync(p)) } catch { /* skip */ }
  }

  const udDir = path.join(profileDir, 'user-data')
  for (const item of USER_DATA_ITEMS) {
    const p = path.join(udDir, item)
    if (!fs.existsSync(p)) continue
    if (fs.statSync(p).isDirectory()) {
      addDirSafe(zip, p, `user-data/${item}`)
    } else {
      try { zip.addFile(`user-data/${item}`, fs.readFileSync(p)) } catch { /* skip */ }
    }
  }

  return zip.toBuffer()
}

/** Replace the profile's synced state with the archive's. */
export function unpackProfileCache(buf: Buffer, profileDir: string): void {
  // Parse before deleting anything: a truncated download must leave the profile
  // as it was, not half-erased.
  const zip = new AdmZip(buf)
  const entries = zip.getEntries()
  fs.mkdirSync(profileDir, { recursive: true })
  clearPackedState(profileDir, entries)
  zip.extractAllTo(profileDir, /* overwrite */ true)
}

// Portable archive (.fpprofile): manifest.json + passkeys + whitelisted browser
// state. `manifest.profile` is the interchange snake_case schema; app-specific
// extras ride in a top-level `antibrow` key that other readers ignore.

/** Recommended file extension for a portable profile archive. */
export const PROFILE_ARCHIVE_EXT = 'fpprofile'

const LAUNCHER_MANIFEST_ENTRY = 'manifest.json'
const LAUNCHER_FORMAT_ID = 'fp-launcher-profile'
const LAUNCHER_FORMAT_VERSION = 1
/** Metadata entry of the legacy `.zip` export, still importable. */
const LEGACY_META_ENTRY = 'profile.json'

/**
 * The `user-data/` files a portable export carries: real browser state only, no
 * caches. A SQLite main file drags its -wal/-shm/-journal siblings along.
 */
const PORTABLE_USER_DATA: readonly string[] = [
  'Local State',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Bookmarks',
  'Default/Favicons',
  'Default/History',
  'Default/Web Data',
  'Default/Login Data',
  'Default/Cookies',
  'Default/Network/Cookies',
  'Default/Network/Trust Tokens',
  'Default/Network/TransportSecurity',
  'Default/Network/Network Persistent State',
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/IndexedDB',
  'Default/Local Extension Settings',
  // Session restore: without these the import opens with no tabs.
  'Default/Sessions',
  'Default/Current Session',
  'Default/Current Tabs',
  'Default/Last Session',
  'Default/Last Tabs',
]

const SQLITE_SIDES = ['-journal', '-wal', '-shm'] as const

/** What a portable archive records about a profile besides its identity. */
export interface PortableProfileMeta {
  /** Source profile id, kept for provenance. */
  id?: string
  name: string
  kernelVersion?: string
  /** Proxy as a single URL. */
  proxyUrl?: string
  apiLog?: ApiLogMode
  canvasNoise?: boolean
  webauthnCapture?: boolean
  /** App-specific extras. Other readers ignore them. */
  extra?: Record<string, unknown>
}

export interface ImportedProfileMeta extends PortableProfileMeta {
  source: 'launcher' | 'legacy'
}

function personaToLauncher(p: Persona): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seed: p.seed,
    canvas_seed: p.canvasSeed,
    audio_seed: p.audioSeed,
    domrect_seed: p.domrectSeed,
    chrome_major: p.chromeMajor,
    ua: p.ua,
    hardware_concurrency: p.hardwareConcurrency,
    device_memory: p.deviceMemory,
    screen_w: p.screenW,
    screen_h: p.screenH,
    device_pixel_ratio: p.devicePixelRatio,
    gpu_vendor: p.gpuVendor,
    gpu_renderer: p.gpuRenderer,
    languages: p.languages,
    timezone: p.timezone,
  }
  if (p.capturedWebgl) out.captured_webgl = p.capturedWebgl
  return out
}

/**
 * Build a portable `.fpprofile`. Export with the browser closed: a live Chrome
 * holds SQLite mid-write, and a torn copy loses cookies and tabs on import.
 */
export function exportProfileArchive(profileDir: string, meta: PortableProfileMeta): Buffer {
  const zip = new AdmZip()
  const persona = loadOrGeneratePersona(profileDir, meta.kernelVersion)
  const manifest = {
    format: LAUNCHER_FORMAT_ID,
    version: LAUNCHER_FORMAT_VERSION,
    profile: {
      id: meta.id ?? path.basename(profileDir),
      name: meta.name,
      proxy: { raw: meta.proxyUrl ?? '' },
      kernel_version: meta.kernelVersion ?? persona.kernelVersion,
      persona: personaToLauncher(persona),
      api_log: meta.apiLog ?? 'off',
      canvas_noise: meta.canvasNoise ?? true,
      webauthn_capture: meta.webauthnCapture ?? true,
    },
    ...(meta.extra && Object.keys(meta.extra).length > 0 ? { antibrow: meta.extra } : {}),
  }
  zip.addFile(LAUNCHER_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2)))

  const passkeys = path.join(profileDir, PASSKEYS_ENTRY)
  try {
    if (fs.existsSync(passkeys)) zip.addFile(PASSKEYS_ENTRY, fs.readFileSync(passkeys))
  } catch { /* unreadable — skip, best-effort */ }

  const userData = path.join(profileDir, 'user-data')
  for (const rel of PORTABLE_USER_DATA) {
    const src = path.join(userData, rel)
    let stat: fs.Stats
    try { stat = fs.statSync(src) } catch { continue }
    if (stat.isDirectory()) {
      addDirSafe(zip, src, `user-data/${rel.replace(/\\/g, '/')}`)
    } else if (stat.isFile()) {
      addPortableFile(zip, userData, src)
      for (const side of SQLITE_SIDES) addPortableFile(zip, userData, src + side)
    }
  }
  return zip.toBuffer()
}

function addPortableFile(zip: AdmZip, userData: string, abs: string): void {
  try {
    if (!fs.statSync(abs).isFile()) return
    const rel = path.relative(userData, abs).split(path.sep).join('/')
    zip.addFile(`user-data/${rel}`, fs.readFileSync(abs))
  } catch { /* missing or locked — best-effort */ }
}

/**
 * Restore a portable archive and return its metadata. Reads `.fpprofile` and the
 * legacy `.zip`; neither metadata entry is left behind in the profile directory.
 */
export function importProfileArchive(buf: Buffer, profileDir: string): ImportedProfileMeta {
  const zip = new AdmZip(buf)
  const launcherEntry = zip.getEntry(LAUNCHER_MANIFEST_ENTRY)
  if (launcherEntry && !zip.getEntry(LEGACY_META_ENTRY)) {
    return importLauncherArchive(zip, parseLauncherManifest(launcherEntry.getData()), profileDir)
  }
  const entry = zip.getEntry(LEGACY_META_ENTRY)
  const legacy = entry ? (JSON.parse(entry.getData().toString('utf8')) as Record<string, unknown>) : {}
  fs.mkdirSync(profileDir, { recursive: true })
  // The legacy export reused the filename the directory's identity record uses,
  // so extracting would overwrite it and the cleanup below would then delete it,
  // leaving a directory that no name resolves to.
  const metaPath = path.join(profileDir, LEGACY_META_ENTRY)
  let identity: Buffer | undefined
  try { identity = fs.readFileSync(metaPath) } catch { /* no record yet */ }
  zip.extractAllTo(profileDir, /* overwrite */ true)
  if (identity) fs.writeFileSync(metaPath, identity)
  else fs.rmSync(metaPath, { force: true })
  clearArchiveVersion(profileDir)
  const { name, kernelVersion, ...rest } = legacy as { name?: string; kernelVersion?: string }
  return {
    source: 'legacy',
    name: typeof name === 'string' ? name : '',
    kernelVersion: typeof kernelVersion === 'string' ? kernelVersion : undefined,
    extra: rest as Record<string, unknown>,
  }
}

/** Manifest persona, snake_case. Every field is optional. */
interface LauncherPersona {
  seed?: string
  canvas_seed?: string
  audio_seed?: string
  domrect_seed?: string
  chrome_major?: number
  ua?: string
  hardware_concurrency?: number
  device_memory?: number
  screen_w?: number
  screen_h?: number
  device_pixel_ratio?: number
  gpu_vendor?: string
  gpu_renderer?: string
  languages?: string[]
  timezone?: string
  captured_webgl?: Record<string, unknown>
}

interface LauncherManifest {
  format?: string
  version?: number
  profile?: {
    id?: string
    name?: string
    proxy?: { raw?: string }
    kernel_version?: string
    persona?: LauncherPersona
    api_log?: string
    canvas_noise?: boolean
    webauthn_capture?: boolean
  }
  antibrow?: Record<string, unknown>
}

function asApiLogMode(value: unknown): ApiLogMode {
  return value === 'curated' || value === 'all' ? value : 'off'
}

function parseLauncherManifest(raw: Buffer): LauncherManifest {
  let manifest: LauncherManifest
  try {
    manifest = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')) as LauncherManifest
  } catch {
    throw new Error('Unreadable profile archive: manifest.json is not valid JSON')
  }
  if (manifest?.format !== LAUNCHER_FORMAT_ID) {
    throw new Error(`Unsupported profile archive format: ${manifest?.format ?? 'unknown'}`)
  }
  if ((manifest.version ?? 1) > LAUNCHER_FORMAT_VERSION) {
    throw new Error(`This profile was exported by a newer launcher (format v${manifest.version}); update the app to import it`)
  }
  return manifest
}

/**
 * The kernel an imported profile can actually launch here: the exact version,
 * else the newest known build of the same Chrome major, else the default.
 */
function resolveImportedKernelVersion(wanted: string): string {
  let known: string[]
  try {
    known = kernelsForPlatform().map((kv) => kv.version)
  } catch {
    known = []
  }
  if (known.includes(wanted)) return wanted
  const major = wanted.split('.')[0]
  return known.find((v) => v.split('.')[0] === major) ?? DEFAULT_KERNEL_VERSION.version
}

/** Keep every seed and hardware fact so the import renders the same
 *  fingerprint; omitted fields fall back to freshly generated values. */
function launcherPersonaToPersona(lp: LauncherPersona, kernelVersion: string): Persona {
  const chromeMajor = parseInt(kernelVersion.split('.')[0] ?? '', 10) || lp.chrome_major || 149
  const base = generatePersona(chromeMajor, kernelVersion)
  const persona: Persona = {
    ...base,
    seed: lp.seed || base.seed,
    canvasSeed: lp.canvas_seed || base.canvasSeed,
    audioSeed: lp.audio_seed || base.audioSeed,
    domrectSeed: lp.domrect_seed || base.domrectSeed,
    chromeMajor,
    kernelVersion,
    // The UA major must match the kernel actually launched.
    ua: lp.ua ? lp.ua.replace(/Chrome\/\d+/, `Chrome/${chromeMajor}`) : base.ua,
    hardwareConcurrency: lp.hardware_concurrency ?? base.hardwareConcurrency,
    deviceMemory: lp.device_memory ?? base.deviceMemory,
    screenW: lp.screen_w ?? base.screenW,
    screenH: lp.screen_h ?? base.screenH,
    devicePixelRatio: lp.device_pixel_ratio ?? base.devicePixelRatio,
    gpuVendor: lp.gpu_vendor || base.gpuVendor,
    gpuRenderer: lp.gpu_renderer || base.gpuRenderer,
    languages: lp.languages?.length ? lp.languages : base.languages,
    timezone: lp.timezone || base.timezone,
  }
  if (lp.captured_webgl) persona.capturedWebgl = lp.captured_webgl
  return persona
}

/** Resolve a zip entry under `root`, or null when it escapes (zip slip). */
function safeJoin(root: string, entryName: string): string | null {
  const base = path.resolve(root)
  const dest = path.resolve(base, entryName)
  return dest.startsWith(base + path.sep) ? dest : null
}

/**
 * Restore a `.fpprofile`: state and passkeys land as-is, the manifest identity
 * becomes persona.json, and the settings go back to the caller.
 */
function importLauncherArchive(zip: AdmZip, manifest: LauncherManifest, profileDir: string): ImportedProfileMeta {
  const lp = manifest.profile ?? {}
  fs.mkdirSync(profileDir, { recursive: true })

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (name !== PASSKEYS_ENTRY && !name.startsWith('user-data/')) continue
    const dest = safeJoin(profileDir, name)
    if (!dest) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, entry.getData())
  }

  const kernelVersion = resolveImportedKernelVersion(lp.kernel_version || DEFAULT_KERNEL_VERSION.version)
  const persona = launcherPersonaToPersona(lp.persona ?? {}, kernelVersion)
  fs.writeFileSync(path.join(profileDir, 'persona.json'), JSON.stringify(persona, null, 2))
  clearArchiveVersion(profileDir)

  return {
    source: 'launcher',
    id: lp.id,
    name: lp.name ?? '',
    kernelVersion,
    proxyUrl: lp.proxy?.raw?.trim() || undefined,
    apiLog: asApiLogMode(lp.api_log),
    canvasNoise: lp.canvas_noise !== false,
    webauthnCapture: lp.webauthn_capture !== false,
    extra: manifest.antibrow,
  }
}

/** Download from a presigned GET URL and unpack. False when there was nothing
 *  to restore, so the caller knows not to record a generation. */
export async function downloadProfileCache(getUrl: string, profileDir: string): Promise<boolean> {
  const res = await fetch(getUrl)
  if (res.status === 404 || res.status === 403) return false
  if (!res.ok) throw new Error(`Failed to download profile cache: HTTP ${res.status}`)
  unpackProfileCache(Buffer.from(await res.arrayBuffer()), profileDir)
  return true
}

/** Pack and upload to a presigned PUT URL. Returns the new generation (the
 *  object's ETag), or undefined when R2 did not name one. */
export async function uploadProfileCache(profileDir: string, putUrl: string): Promise<string | undefined> {
  const buf = packProfileCache(profileDir)
  const res = await fetch(putUrl, {
    method: 'PUT',
    body: buf,
    headers: { 'Content-Type': 'application/zip' },
  })
  if (!res.ok) throw new Error(`Failed to upload profile cache: HTTP ${res.status}`)
  return normalizeArchiveVersion(res.headers.get('etag'))
}

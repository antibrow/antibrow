import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { execFile, spawnSync } from 'node:child_process'

/** Only linux is split by arch: mac is universal, windows is x64 only. */
export type SupportedPlatform = 'win32' | 'linux' | 'linux-arm64' | 'darwin'

function isLinuxAsset(platform: SupportedPlatform): boolean {
  return platform === 'linux' || platform === 'linux-arm64'
}

export interface KernelPlatformAsset {
  downloadUrl: string
  /** Path to the browser executable relative to the extracted kernel directory. */
  exeRelPath: string
  /** Opaque freshness marker; a rebuilt same-version zip bumps it. */
  build?: string
}

export interface KernelVersion {
  version: string
  label: string
  /** Only the platforms this version was built for. */
  platforms: Partial<Record<SupportedPlatform, KernelPlatformAsset>>
}

/**
 * The one version compiled in: what new profiles get. Every other kernel comes
 * from the manifest at runtime, so the default moves only with a release.
 */
export const KERNEL_VERSIONS: KernelVersion[] = [
  {
    version: '150.0.7871.182',
    label: 'Chrome 150',
    platforms: {
      win32: {
        downloadUrl: 'https://download.antibrow.com/fp-chromium-150-win64.zip',
        exeRelPath: 'chrome.exe',
      },
      linux: {
        downloadUrl: 'https://download.antibrow.com/fp-chromium-150-linux64.zip',
        exeRelPath: 'chrome',
      },
      'linux-arm64': {
        downloadUrl: 'https://download.antibrow.com/fp-chromium-150-linuxarm64.zip',
        exeRelPath: 'chrome',
      },
      darwin: {
        downloadUrl: 'https://download.antibrow.com/fp-chromium-150-mac-universal.zip',
        exeRelPath: 'Chromium.app/Contents/MacOS/Chromium',
      },
    },
  },
]

export const DEFAULT_KERNEL_VERSION: KernelVersion = pickDefaultKernel()

function pickDefaultKernel(): KernelVersion {
  let platform: SupportedPlatform | null = null
  try {
    platform = currentPlatform()
  } catch {
    platform = null
  }
  if (platform) {
    const match = KERNEL_VERSIONS.find((kv) => kv.platforms[platform as SupportedPlatform])
    if (match) return match
  }
  return KERNEL_VERSIONS[0]
}

export const KERNEL_MANIFEST_URL = 'https://download.antibrow.com/fp-browser-versions.json'

interface RemoteKernelEntry {
  version: string
  label?: string
  platform: string
  download_url: string
  exe_rel_path?: string
  build?: string
}

const MANIFEST_PLATFORM: Record<string, SupportedPlatform> = {
  win64: 'win32',
  linux64: 'linux',
  linuxarm64: 'linux-arm64',
  'mac-universal': 'darwin',
}

function defaultExeRelPath(platform: SupportedPlatform): string {
  if (platform === 'win32') return 'chrome.exe'
  if (platform === 'darwin') return 'Chromium.app/Contents/MacOS/Chromium'
  return 'chrome'
}

let registeredKernelVersions: KernelVersion[] = []

function copyPlatforms(platforms: KernelVersion['platforms']): KernelVersion['platforms'] {
  const out: KernelVersion['platforms'] = {}
  for (const key of Object.keys(platforms) as SupportedPlatform[]) {
    const a = platforms[key]
    if (a) out[key] = { ...a }
  }
  return out
}

function mergePlatformsInto(target: KernelVersion, platforms: KernelVersion['platforms']): void {
  for (const key of Object.keys(platforms) as SupportedPlatform[]) {
    const incoming = platforms[key]
    if (!incoming) continue
    const existing = target.platforms[key]
    if (!existing) {
      // Baseline URLs win over remote ones; only `build` tracks the latest seen.
      target.platforms[key] = { ...incoming }
      continue
    }
    if (incoming.build && existing.build !== incoming.build) existing.build = incoming.build
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Baseline merged with runtime-registered versions, newest first. */
export function allKernelVersions(): KernelVersion[] {
  const byVersion = new Map<string, KernelVersion>()
  const add = (kv: KernelVersion): void => {
    const existing = byVersion.get(kv.version)
    if (!existing) byVersion.set(kv.version, { version: kv.version, label: kv.label, platforms: copyPlatforms(kv.platforms) })
    else mergePlatformsInto(existing, kv.platforms)
  }
  KERNEL_VERSIONS.forEach(add)
  registeredKernelVersions.forEach(add)
  return [...byVersion.values()].sort((a, b) => compareVersionsDesc(a.version, b.version))
}

/** Register manifest-discovered versions (idempotent; augments only). */
export function registerKernelVersions(versions: KernelVersion[]): void {
  for (const v of versions) {
    if (!v?.version || !v.platforms) continue
    const existing = registeredKernelVersions.find((k) => k.version === v.version)
    if (!existing) registeredKernelVersions.push({ version: v.version, label: v.label, platforms: copyPlatforms(v.platforms) })
    else mergePlatformsInto(existing, v.platforms)
  }
}

/**
 * Relative `download_url`s resolve against the manifest origin, so a mirrored
 * manifest works unchanged. Throws on network/parse failure.
 */
export async function fetchRemoteKernelVersions(manifestUrl: string = KERNEL_MANIFEST_URL): Promise<KernelVersion[]> {
  const res = await fetch(cacheBustUrl(manifestUrl), { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } })
  if (!res.ok) throw new Error(`kernel manifest HTTP ${res.status}`)
  const text = await res.text()
  const json = JSON.parse(text.replace(/^﻿/, '')) as { versions?: RemoteKernelEntry[] }
  const rows = Array.isArray(json.versions) ? json.versions : []
  const byVersion = new Map<string, KernelVersion>()
  for (const r of rows) {
    const plat = MANIFEST_PLATFORM[r.platform]
    if (!plat || !r.version || !r.download_url) continue
    const downloadUrl = /^https?:\/\//i.test(r.download_url) ? r.download_url : new URL(r.download_url, manifestUrl).toString()
    let kv = byVersion.get(r.version)
    if (!kv) {
      kv = { version: r.version, label: r.label ?? r.version, platforms: {} }
      byVersion.set(r.version, kv)
    }
    if (!kv.platforms[plat]) {
      kv.platforms[plat] = { downloadUrl, exeRelPath: r.exe_rel_path ?? defaultExeRelPath(plat), build: r.build }
    }
  }
  return [...byVersion.values()]
}

/** Bare `KernelVersion[]`, shared with other clients in the same cache dir. */
export const KERNEL_VERSION_CACHE_FILE = 'kernel-versions-cache.json'

export const KERNEL_MANIFEST_TTL_MS = 60 * 60 * 1000

function kernelVersionCachePath(cacheDir: string): string {
  return path.join(cacheDir, KERNEL_VERSION_CACHE_FILE)
}

/** Versions saved by a previous fetch. */
export function loadCachedKernelVersions(cacheDir: string): KernelVersion[] {
  try {
    const cached = JSON.parse(fs.readFileSync(kernelVersionCachePath(cacheDir), 'utf8')) as KernelVersion[]
    return Array.isArray(cached) ? cached : []
  } catch {
    return []
  }
}

function cachedKernelVersionsAge(cacheDir: string): number {
  try {
    return Date.now() - fs.statSync(kernelVersionCachePath(cacheDir)).mtimeMs
  } catch {
    return Infinity
  }
}

function writeCachedKernelVersions(cacheDir: string, versions: KernelVersion[]): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(kernelVersionCachePath(cacheDir), JSON.stringify(versions), 'utf8')
  } catch {
    /* best-effort */
  }
}

/**
 * Register the cached catalogue, then re-fetch the manifest once that cache is
 * older than `ttlMs`. Never throws: offline leaves baseline + cache in place.
 */
export async function refreshKernelVersions(
  cacheDir: string,
  opts?: { force?: boolean; ttlMs?: number; manifestUrl?: string },
): Promise<void> {
  const cached = loadCachedKernelVersions(cacheDir)
  if (cached.length) registerKernelVersions(cached)

  const ttl = opts?.ttlMs ?? KERNEL_MANIFEST_TTL_MS
  if (!opts?.force && cached.length && cachedKernelVersionsAge(cacheDir) < ttl) return

  try {
    const remote = await fetchRemoteKernelVersions(opts?.manifestUrl)
    registerKernelVersions(remote)
    writeCachedKernelVersions(cacheDir, remote)
  } catch {
    /* offline: baseline + cache still resolve */
  }
}

/** Look up a version string, falling back to DEFAULT_KERNEL_VERSION. */
export function findKernelVersion(version: string): KernelVersion {
  return allKernelVersions().find((kv) => kv.version === version) ?? DEFAULT_KERNEL_VERSION
}

/**
 * Look up a version that the caller cannot substitute. Versions published after
 * this release exist only in the manifest, so an offline or stale catalogue
 * would otherwise hand back the compiled-in default - a silent downgrade for
 * anything pinned to a specific kernel.
 */
export function findKernelVersionStrict(version: string): KernelVersion {
  const kv = allKernelVersions().find((k) => k.version === version)
  if (kv) return kv
  throw new Error(
    `Kernel ${version} is not in the catalogue. Refresh the kernel list with an internet ` +
      'connection and retry; falling back to another version would change this profile\'s identity.',
  )
}

/** Resolve the current process platform to a SupportedPlatform key. */
export function currentPlatform(): SupportedPlatform {
  if (process.platform === 'win32') return 'win32'
  // arm64 linux needs its own build; x64/x86 both take the linux64 asset.
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux'
  if (process.platform === 'darwin') return 'darwin'
  throw new Error(`Unsupported platform: ${process.platform}. The kernel ships for win32, linux and darwin.`)
}

export function kernelAsset(kv: KernelVersion, platform?: SupportedPlatform): KernelPlatformAsset {
  const p = platform ?? currentPlatform()
  const asset = kv.platforms[p]
  if (!asset) throw new Error(`Kernel ${kv.version} has no asset for platform "${p}"`)
  return asset
}

export function kernelAvailableOnPlatform(kv: KernelVersion, platform?: SupportedPlatform): boolean {
  const p = platform ?? currentPlatform()
  return Boolean(kv.platforms[p])
}

/** Versions with a build for this platform, newest first. */
export function kernelsForPlatform(platform?: SupportedPlatform): KernelVersion[] {
  return allKernelVersions().filter((kv) => kernelAvailableOnPlatform(kv, platform))
}

export function kernelDir(cacheDir: string, version: string): string {
  return path.join(cacheDir, 'kernels', version)
}

const KERNEL_BUILD_MARKER = '.fp-build'

/** Build recorded at download time; unknown counts as up to date. */
export function installedKernelBuild(cacheDir: string, version: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(kernelDir(cacheDir, version), KERNEL_BUILD_MARKER), 'utf8').trim()
    return raw || undefined
  } catch {
    return undefined
  }
}

export function writeInstalledKernelBuild(cacheDir: string, version: string, build: string): void {
  try {
    fs.mkdirSync(kernelDir(cacheDir, version), { recursive: true })
    fs.writeFileSync(path.join(kernelDir(cacheDir, version), KERNEL_BUILD_MARKER), build, 'utf8')
  } catch {
    /* best-effort */
  }
}

export const ANDROID_MIN_KERNEL_VERSION = '151.0.7922.72'
/** Build stamp of the first kernel carrying the mobile device patches. */
export const ANDROID_MIN_KERNEL_BUILD = '2026-08-07 05:17'

/** True when `version` is at or above `min`, comparing numerically per segment. */
export function kernelVersionAtLeast(version: string | undefined, min: string): boolean {
  if (!version) return false
  // compareVersionsDesc sorts newest first, so <= 0 means version >= min.
  return compareVersionsDesc(version, min) <= 0
}

/**
 * Both halves are load-bearing. The version alone cannot answer it: the same
 * version shipped twice, once before the mobile patches and once after. The
 * build date alone cannot either: every kernel version gets rebuilt on the same
 * day when the whole set is republished, so a date-only rule lets a kernel with
 * none of the mobile patches through. An older binary handed an Android config
 * produces a profile whose UA says Android while its client hints say desktop -
 * worse than no Android at all.
 */
/** First kernel that reads the macOS application locale out of fp-config. */
export const APP_LOCALE_MIN_KERNEL_VERSION = '151.0.7922.72'
export const APP_LOCALE_MIN_KERNEL_BUILD = '2026-08-10'

/**
 * Whether the kernel takes the macOS application locale from fp-config, which
 * decides whether the launcher still has to pass `-AppleLanguages`. Same two
 * halves as the Android gate, and getting it wrong is worse than the stray tab
 * the pair causes: dropping the argv on a kernel that still needs it leaves
 * navigator.language spoofed while Intl reports the host locale, which is a
 * contradiction any script can read.
 */
export function kernelReadsAppLocaleFromConfig(version: string | undefined, build: string | undefined): boolean {
  if (!kernelVersionAtLeast(version, APP_LOCALE_MIN_KERNEL_VERSION)) return false
  if (!build || build.length < 10) return false
  const date = build.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  return date >= APP_LOCALE_MIN_KERNEL_BUILD
}

export function kernelSupportsAndroid(version: string | undefined, build: string | undefined): boolean {
  if (!kernelVersionAtLeast(version, ANDROID_MIN_KERNEL_VERSION)) return false
  if (!build || build.length < 10) return false
  const date = build.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  return date >= ANDROID_MIN_KERNEL_BUILD.slice(0, 10)
}

export function kernelExePath(cacheDir: string, kv: KernelVersion, platform?: SupportedPlatform): string {
  return path.join(kernelDir(cacheDir, kv.version), kernelAsset(kv, platform).exeRelPath)
}

export function isKernelInstalled(cacheDir: string, kv: KernelVersion, platform?: SupportedPlatform): boolean {
  if (!kernelAvailableOnPlatform(kv, platform)) return false
  return fs.existsSync(kernelExePath(cacheDir, kv, platform))
}

export function listInstalledKernels(cacheDir: string, platform?: SupportedPlatform): string[] {
  return allKernelVersions().filter((kv) => isKernelInstalled(cacheDir, kv, platform)).map((kv) => kv.version)
}

export interface KernelUpdateStatus {
  version: string
  label: string
  installed: boolean
  installedBuild?: string
  /** Published build for this platform; undefined offline. */
  availableBuild?: string
  updateAvailable: boolean
}

/**
 * Null when not installed here. Purely local, so it is only meaningful after a
 * refresh; an install with no recorded build adopts the current one instead of
 * reporting a drift it cannot verify.
 */
export function kernelUpdateStatus(
  cacheDir: string,
  version: string,
  platform?: SupportedPlatform,
): KernelUpdateStatus | null {
  const plat = platform ?? currentPlatform()
  const kv = findKernelVersion(version)
  if (!isKernelInstalled(cacheDir, kv, plat)) return null
  const availableBuild = kv.platforms[plat]?.build
  const have = installedKernelBuild(cacheDir, kv.version)
  if (have == null) {
    if (availableBuild) writeInstalledKernelBuild(cacheDir, kv.version, availableBuild)
    return { version: kv.version, label: kv.label, installed: true, installedBuild: availableBuild, availableBuild, updateAvailable: false }
  }
  return {
    version: kv.version,
    label: kv.label,
    installed: true,
    installedBuild: have,
    availableBuild,
    updateAvailable: Boolean(availableBuild && have !== availableBuild),
  }
}

export function installedKernelUpdates(cacheDir: string, platform?: SupportedPlatform): KernelUpdateStatus[] {
  const plat = platform ?? currentPlatform()
  return kernelsForPlatform(plat)
    .map((kv) => kernelUpdateStatus(cacheDir, kv.version, plat))
    .filter((s): s is KernelUpdateStatus => s != null)
}

export function kernelDirSize(cacheDir: string, version: string): number {
  const dir = kernelDir(cacheDir, version)
  let total = 0
  const walk = (p: string): void => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(p)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      let entries: string[]
      try {
        entries = fs.readdirSync(p)
      } catch {
        return
      }
      for (const e of entries) walk(path.join(p, e))
    } else {
      total += stat.size
    }
  }
  walk(dir)
  return total
}

export function deleteKernel(cacheDir: string, version: string): void {
  fs.rmSync(kernelDir(cacheDir, version), { recursive: true, force: true })
}

/**
 * Download + extract if needed; returns the executable path. `force` re-downloads
 * a rebuilt kernel published under the same version number.
 */
export async function ensureKernel(
  cacheDir: string,
  kv: KernelVersion = DEFAULT_KERNEL_VERSION,
  onProgress?: (message: string) => void,
  opts?: { force?: boolean },
): Promise<string> {
  const platform = currentPlatform()
  const asset = kernelAsset(kv, platform)
  const exePath = path.join(kernelDir(cacheDir, kv.version), asset.exeRelPath)

  if (!opts?.force && fs.existsSync(exePath)) {
    if (isLinuxAsset(platform)) chmodKernelBinaries(path.dirname(exePath))
    return exePath
  }

  onProgress?.(`Downloading kernel ${kv.label} (${platform})`)
  const kDir = kernelDir(cacheDir, kv.version)
  const zipPath = path.join(cacheDir, `kernel-${kv.version}-${platform}.zip`)

  try {
    // In place, not temp-dir-then-rename: on Windows the rename hits EPERM while
    // antivirus holds a lock on the fresh binaries.
    fs.rmSync(kDir, { recursive: true, force: true })
    fs.mkdirSync(kDir, { recursive: true })

    await downloadFile(cacheBustUrl(asset.downloadUrl), zipPath, onProgress)
    onProgress?.('Extracting kernel')
    await extractKernelZip(zipPath, kDir, onProgress)

    if (!fs.existsSync(exePath)) {
      // Extracted but the exe is gone: on Windows this is antivirus quarantine.
      // Say so rather than re-downloading forever.
      throw new Error(
        `Kernel downloaded but ${asset.exeRelPath} is missing after extraction. ` +
        `This usually means antivirus/Windows Defender quarantined the kernel — ` +
        `add an exclusion for "${kDir}" (and your temp folder) and try again.`,
      )
    }

    // Helper binaries need +x or the browser aborts on posix_spawn EPERM.
    if (isLinuxAsset(platform)) chmodKernelBinaries(path.dirname(exePath))

    // A broken seal means the extraction mangled the bundle (see
    // extractKernelZip). Catch it here, not at launch.
    if (platform === 'darwin') {
      onProgress?.('Verifying kernel signature')
      verifyDarwinBundleSignature(path.join(kDir, asset.exeRelPath.split('/')[0]))
    }

    if (asset.build) writeInstalledKernelBuild(cacheDir, kv.version, asset.build)
  } catch (e) {
    // A half-installed dir would look ready to the next launch.
    try { fs.rmSync(kDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw e
  } finally {
    fs.rmSync(zipPath, { force: true })
  }

  onProgress?.(`Kernel ready: ${kv.version}`)
  return exePath
}

function chmodKernelBinaries(dir: string): void {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (path.extname(f) === '') {
        try { fs.chmodSync(path.join(dir, f), 0o755) } catch {}
      }
    }
  } catch {}
}

/** Kernels keep a fixed filename, so a rebuild can sit in a CDN edge cache. */
function cacheBustUrl(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    let downloaded = 0

    const noCache = { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    const doGet = (targetUrl: string) => {
      const mod = targetUrl.startsWith('https://') ? https : http
      mod.get(targetUrl, { headers: noCache }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close()
          doGet(res.headers.location)
          return
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          file.close()
          fs.rmSync(destPath, { force: true })
          reject(new Error(`Download failed: HTTP ${res.statusCode} from ${targetUrl}`))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total > 0) {
            onProgress?.(`Downloading ${Math.round((downloaded / total) * 100)}%`)
          }
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', (err) => {
          fs.rmSync(destPath, { force: true })
          reject(err)
        })
      }).on('error', (err) => {
        file.close()
        fs.rmSync(destPath, { force: true })
        reject(err)
      })
    }

    doGet(url)
  })
}

/**
 * macOS must go through `ditto`: the .app has symlinked framework dirs and is
 * packed with `ditto -c -k`, so a plain zip reader writes those symlinks out as
 * regular files and breaks the code signature (the app then dies silently).
 */
export async function extractKernelZip(
  zipPath: string,
  destDir: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  if (process.platform === 'darwin') return extractZipWithDitto(zipPath, destDir, onProgress)

  const { open } = await import('yauzl')
  let count = 0
  await new Promise<void>((resolve, reject) => {
    open(zipPath, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(openErr ?? new Error(`Could not open kernel archive ${zipPath}`))
        return
      }

      // yauzl fails on several channels (archive, each read/write stream) and
      // auto-closes on 'end'; one flag keeps a late error from double-settling.
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        zip.close()
        reject(err)
      }
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }

      zip.on('error', fail)
      zip.on('end', done)
      zip.on('entry', (entry) => {
        if (settled) return
        let target: string
        try {
          target = resolveEntryPath(destDir, entry.fileName)
        } catch (err) {
          fail(err as Error)
          return
        }

        // Directory entries are the only ones yauzl marks by a trailing slash.
        if (entry.fileName.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true })
          zip.readEntry()
          return
        }

        fs.mkdirSync(path.dirname(target), { recursive: true })
        zip.openReadStream(entry, (readErr, stream) => {
          if (readErr || !stream) {
            fail(readErr ?? new Error(`Could not read ${entry.fileName} from ${zipPath}`))
            return
          }
          const out = fs.createWriteStream(target)
          stream.on('error', fail)
          out.on('error', fail)
          // Advance only once the file is on disk: sequential extraction means a
          // truncated write cannot be masked by the next entry.
          out.on('close', () => {
            if (settled) return
            count++
            if (count % 50 === 0) onProgress?.(`Extracting ${count} files...`)
            zip.readEntry()
          })
          stream.pipe(out)
        })
      })

      zip.readEntry()
    })
  })
  onProgress?.(`Extracted ${count} files`)
}

/**
 * Zip Slip guard: entries named `../../x` or `/etc/x` would otherwise be written
 * outside `destDir`. Archives arrive over the network, so they are not trusted.
 */
export function resolveEntryPath(destDir: string, entryName: string): string {
  // Zip also stores backslash names; normalise so `..\..\x` cannot slip past
  // the prefix check on POSIX.
  const normalized = entryName.replace(/\\/g, '/')
  const root = path.resolve(destDir)
  const target = path.resolve(root, normalized)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Refusing to extract "${entryName}": the entry resolves outside the kernel directory. ` +
      'The archive is malformed or tampered with - delete the kernel and try again.',
    )
  }
  return target
}

function extractZipWithDitto(
  zipPath: string,
  destDir: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  // ensureKernel already reported 'Extracting kernel'; ditto has no progress.
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zipPath, destDir], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`Failed to extract the kernel with ditto: ${stderr.trim() || err.message}`))
        return
      }
      onProgress?.('Extracted kernel bundle')
      resolve()
    })
  })
}

/**
 * A broken seal is fatal at launch with no diagnosable error, so fail here while
 * we still know a download just happened.
 */
export function verifyDarwinBundleSignature(appPath: string): void {
  const res = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    encoding: 'utf8',
  })
  if (res.status === 0) return
  const detail = (res.stderr || res.stdout || '').trim()
  throw new Error(
    `Kernel signature verification failed for ${appPath}: ${detail || `codesign exited ${res.status}`}. ` +
    'The download is corrupt — delete the kernel and try again.',
  )
}

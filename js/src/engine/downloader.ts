import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { execFile, spawnSync } from 'node:child_process'

export type SupportedPlatform = 'win32' | 'linux' | 'darwin'

export interface KernelPlatformAsset {
  downloadUrl: string
  /** Path to the browser executable relative to the extracted kernel directory. */
  exeRelPath: string
  /**
   * Opaque build identifier for this (version x platform). A rebuilt same-version
   * zip keeps `version`/`downloadUrl` but bumps `build`, which is how an already
   * installed kernel is detected as out of date. Undefined for the compiled-in
   * baseline, which carries no build metadata.
   */
  build?: string
}

export interface KernelVersion {
  version: string
  label: string
  /**
   * Download assets per platform. A version only carries the platforms it was
   * actually built for; enumerate with `kernelAvailableOnPlatform` /
   * `kernelsForPlatform` rather than indexing blindly.
   */
  platforms: Partial<Record<SupportedPlatform, KernelPlatformAsset>>
}

// Newest first. Versions coexist and are selectable per profile; existing
// profiles keep whatever version they were created with.
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
      // macOS ships one universal (x86_64 + arm64) bundle, so there is a single
      // darwin asset rather than one per arch. The executable lives inside the
      // .app, hence the nested exeRelPath.
      darwin: {
        downloadUrl: 'https://download.antibrow.com/fp-chromium-150-mac-universal.zip',
        exeRelPath: 'Chromium.app/Contents/MacOS/Chromium',
      },
    },
  },
  {
    version: '149.0.7827.201',
    label: 'Chrome 149',
    platforms: {
      win32: {
        downloadUrl: 'https://download.antibrow.com/fp-chromium-149-win64.zip',
        exeRelPath: 'chrome.exe',
      },
      linux: {
        downloadUrl: 'https://download.antibrow.com/fp-chromium-149-linux64.zip',
        exeRelPath: 'chrome',
      },
    },
  },
]

/** The kernel new profiles get: newest version built for the current platform. */
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

/** Default location of the remote kernel manifest. */
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
  'mac-universal': 'darwin',
}

/** Fallback when a manifest row omits exe_rel_path. */
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
      // First writer wins for the asset: baseline over remote.
      target.platforms[key] = { ...incoming }
      continue
    }
    // `build` is a freshness signal rather than an identifier, so the latest
    // one seen wins while the URL stays first-writer-wins.
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

/** Compiled-in versions merged with runtime-registered ones, newest first. */
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

/** Register runtime-discovered kernel versions (idempotent; augments only). */
export function registerKernelVersions(versions: KernelVersion[]): void {
  for (const v of versions) {
    if (!v?.version || !v.platforms) continue
    const existing = registeredKernelVersions.find((k) => k.version === v.version)
    if (!existing) registeredKernelVersions.push({ version: v.version, label: v.label, platforms: copyPlatforms(v.platforms) })
    else mergePlatformsInto(existing, v.platforms)
  }
}

/**
 * Fetch and parse the remote kernel manifest. Relative `download_url` values are
 * resolved against the manifest origin, so the same manifest works from a mirror.
 * Throws on network/parse failure; treat that as "no remote".
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

/** Look up a version string, falling back to DEFAULT_KERNEL_VERSION. */
export function findKernelVersion(version: string): KernelVersion {
  return allKernelVersions().find((kv) => kv.version === version) ?? DEFAULT_KERNEL_VERSION
}

/** Resolve the current process platform to a SupportedPlatform key. */
export function currentPlatform(): SupportedPlatform {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'darwin') return 'darwin'
  throw new Error(`Unsupported platform: ${process.platform}. The kernel ships for win32, linux and darwin.`)
}

/** Get the platform-specific asset for a kernel version. */
export function kernelAsset(kv: KernelVersion, platform?: SupportedPlatform): KernelPlatformAsset {
  const p = platform ?? currentPlatform()
  const asset = kv.platforms[p]
  if (!asset) throw new Error(`Kernel ${kv.version} has no asset for platform "${p}"`)
  return asset
}

/** Whether this kernel version was built for the given platform (default: current). */
export function kernelAvailableOnPlatform(kv: KernelVersion, platform?: SupportedPlatform): boolean {
  const p = platform ?? currentPlatform()
  return Boolean(kv.platforms[p])
}

/** Versions that have a build for the given platform (newest first). */
export function kernelsForPlatform(platform?: SupportedPlatform): KernelVersion[] {
  return allKernelVersions().filter((kv) => kernelAvailableOnPlatform(kv, platform))
}

export function kernelDir(cacheDir: string, version: string): string {
  return path.join(cacheDir, 'kernels', version)
}

const KERNEL_BUILD_MARKER = '.fp-build'

/**
 * The build recorded when this kernel was downloaded, or undefined when unknown.
 * Unknown should be treated as up to date rather than as a pending update.
 */
export function installedKernelBuild(cacheDir: string, version: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(kernelDir(cacheDir, version), KERNEL_BUILD_MARKER), 'utf8').trim()
    return raw || undefined
  } catch {
    return undefined
  }
}

/** Record the build string for an installed kernel version (best-effort). */
export function writeInstalledKernelBuild(cacheDir: string, version: string, build: string): void {
  try {
    fs.mkdirSync(kernelDir(cacheDir, version), { recursive: true })
    fs.writeFileSync(path.join(kernelDir(cacheDir, version), KERNEL_BUILD_MARKER), build, 'utf8')
  } catch {
    /* best-effort */
  }
}

export function kernelExePath(cacheDir: string, kv: KernelVersion, platform?: SupportedPlatform): string {
  return path.join(kernelDir(cacheDir, kv.version), kernelAsset(kv, platform).exeRelPath)
}

export function isKernelInstalled(cacheDir: string, kv: KernelVersion, platform?: SupportedPlatform): boolean {
  if (!kernelAvailableOnPlatform(kv, platform)) return false
  return fs.existsSync(kernelExePath(cacheDir, kv, platform))
}

/** Versions currently installed for this platform. */
export function listInstalledKernels(cacheDir: string, platform?: SupportedPlatform): string[] {
  return allKernelVersions().filter((kv) => isKernelInstalled(cacheDir, kv, platform)).map((kv) => kv.version)
}

export interface KernelUpdateStatus {
  version: string
  label: string
  installed: boolean
  /** Build recorded when this kernel was installed (undefined if unknown). */
  installedBuild?: string
  /** Build currently published for this platform (undefined offline). */
  availableBuild?: string
  /** True when a newer build than the installed one is published. */
  updateAvailable: boolean
}

/**
 * Update status for one installed kernel version, or null when it isn't installed
 * for this platform. This is offline: the comparison is only meaningful after
 * `registerKernelVersions(await fetchRemoteKernelVersions())` has merged the
 * published builds. An install with no recorded build adopts the current one, so
 * an unverifiable drift is never reported as an update.
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

/** Update status for every installed kernel on this platform. */
export function installedKernelUpdates(cacheDir: string, platform?: SupportedPlatform): KernelUpdateStatus[] {
  const plat = platform ?? currentPlatform()
  return kernelsForPlatform(plat)
    .map((kv) => kernelUpdateStatus(cacheDir, kv.version, plat))
    .filter((s): s is KernelUpdateStatus => s != null)
}

/** Total on-disk size (bytes) of an installed kernel directory. */
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

/** Remove an installed kernel directory. Idempotent. */
export function deleteKernel(cacheDir: string, version: string): void {
  fs.rmSync(kernelDir(cacheDir, version), { recursive: true, force: true })
}

/**
 * Ensure the kernel for the current platform is downloaded and extracted, and
 * return the path to the browser executable. Idempotent unless `force` is set,
 * which re-downloads a rebuilt kernel published under the same version number.
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
    if (platform === 'linux') chmodKernelBinaries(path.dirname(exePath))
    return exePath
  }

  onProgress?.(`Downloading kernel ${kv.label} (${platform})`)
  const kDir = kernelDir(cacheDir, kv.version)
  const zipPath = path.join(cacheDir, `kernel-${kv.version}-${platform}.zip`)

  try {
    // Extract in place rather than into a temp dir and rename: on Windows the
    // rename fails with EPERM while antivirus holds a lock on fresh binaries.
    fs.rmSync(kDir, { recursive: true, force: true })
    fs.mkdirSync(kDir, { recursive: true })

    await downloadFile(cacheBustUrl(asset.downloadUrl), zipPath, onProgress)
    onProgress?.('Extracting kernel')
    await extractKernelZip(zipPath, kDir, onProgress)

    if (!fs.existsSync(exePath)) {
      // Downloaded and extracted, yet the exe is gone: on Windows this is nearly
      // always antivirus quarantining the unsigned binary. Say so, instead of
      // re-downloading forever on every launch.
      throw new Error(
        `Kernel downloaded but ${asset.exeRelPath} is missing after extraction. ` +
        `This usually means antivirus/Windows Defender quarantined the kernel — ` +
        `add an exclusion for "${kDir}" (and your temp folder) and try again.`,
      )
    }

    // Helper binaries need +x or Chrome aborts on posix_spawn EPERM.
    if (platform === 'linux') chmodKernelBinaries(path.dirname(exePath))

    // The mac kernel is a signed .app; a broken seal here means the extraction
    // mangled the bundle (see extractKernelZip). Catch it now, not at launch.
    if (platform === 'darwin') {
      onProgress?.('Verifying kernel signature')
      verifyDarwinBundleSignature(path.join(kDir, asset.exeRelPath.split('/')[0]))
    }

    if (asset.build) writeInstalledKernelBuild(cacheDir, kv.version, asset.build)
  } catch (e) {
    // Never leave a half-installed dir: the next launch would treat it as ready.
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

/**
 * Kernels are published under a fixed filename, so a rebuild can still be served
 * from a CDN edge cache. A random query param keeps the cache key unique.
 */
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
 * Extract a kernel zip. Exported for tests.
 *
 * macOS goes through `ditto` rather than the JS unzip path: the mac kernel is a
 * .app bundle whose framework directories are symlinks, and it is published with
 * `ditto -c -k`. A plain zip reader writes those symlink entries out as regular
 * files containing the target path, which breaks the bundle's code signature —
 * the app then dies on launch with no usable error. `ditto -x -k` is the exact
 * inverse of how it was packed, so symlinks, permission bits and xattrs survive.
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

      // yauzl reports failures on several channels (the archive, each read
      // stream, each write stream) and auto-closes on 'end'. Funnel everything
      // through one settled flag so a late error cannot double-settle or
      // double-close.
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
          // Advance only once the file is fully on disk: lazyEntries keeps the
          // extraction sequential, so a truncated write can never be masked by
          // the next entry starting early.
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
 * Resolve a zip entry name against `destDir`, refusing anything that escapes it.
 *
 * Zip Slip: a hostile archive can carry entries named `../../x` or `/etc/x`, and
 * a plain `path.join(destDir, entry)` happily writes them outside the kernel
 * directory. Kernel zips are fetched over the network, so the archive is not
 * trusted input no matter how the download went. Exported for tests.
 */
export function resolveEntryPath(destDir: string, entryName: string): string {
  // Zip stores backslash-separated names too; normalise before resolving so a
  // `..\..\x` entry cannot slip past the prefix check on POSIX.
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
  // No 'Extracting kernel' message here: ensureKernel already emits it right
  // before calling us, and ditto reports no incremental progress.
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
 * Verify an extracted .app bundle still satisfies its own code signature.
 *
 * Worth the extra seconds on a fresh download: a bundle whose seal is broken is
 * killed by the OS at launch with no diagnosable error, so failing loudly here —
 * while we still know a download just happened — is the difference between
 * "re-download the kernel" and an unexplained crash. Exported for tests.
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

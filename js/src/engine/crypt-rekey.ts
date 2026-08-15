import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureKernel, findKernelVersionStrict, normalizeKernelVersion, refreshKernelVersions } from './downloader'
import { getLicenseToken } from './license'
import { fetchProfileCryptKey } from './crypt-key'
import { isProfileEncrypted, profileCryptMarker } from './profile-dir'

export { profileCryptMarker }
import {
  copyPortableProfileFiles,
  exportProfileArchive,
  readExportablePersona,
  type PortableProfileMeta,
} from './profile-cache'

/** The kernel's own name for its built-in key (ciphertext tag `fp1`). */
export const NO_CRYPT_KEY = 'none'

const CRYPT_KEY_PATTERN = /^[0-9a-f]{64}$/

/**
 * A real conversion is a handful of SQLite rows and finishes in well under a
 * second (measured end to end, kernel spawn included). The old ten-minute
 * bound existed to cover a kernel refusing outright, but a refusal exits
 * immediately with a code - it never needed ten minutes either. What ten
 * minutes actually protected against is a kernel that does not understand
 * `--fp-crypt-rekey-*` at all: Chromium ignores unknown switches, so it opens
 * a full browser on the temporary copy instead of converting, and the bound is
 * what stands between that and hanging forever. 60s keeps two orders of
 * magnitude of headroom over an observed real conversion while cutting the
 * worst case from ten minutes (and a held licence slot for all of it) to one.
 */
const DEFAULT_REKEY_TIMEOUT_MS = 60_000

export interface RekeyArgsOptions {
  userDataDir: string
  /** 64 hex chars, or `none` for the built-in key. */
  from: string
  to: string
  licenseToken: string
  platform?: NodeJS.Platform
}

/**
 * The conversion runs a kernel that opens no window and exits when it is done.
 * `--fp-crypt-key` is deliberately absent: passing it alongside these two is a
 * parameter error, because then nothing says which key wins.
 */
export function buildRekeyArgs(opts: RekeyArgsOptions): string[] {
  const platform = opts.platform ?? process.platform
  return [
    `--fp-license=${opts.licenseToken}`,
    `--user-data-dir=${opts.userDataDir}`,
    `--fp-crypt-rekey-from=${opts.from}`,
    `--fp-crypt-rekey-to=${opts.to}`,
    ...(platform === 'linux'
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
      : []),
  ]
}

/**
 * The machine-readable token every kernel refusal carries (`FROM_MISMATCH`,
 * `REKEY_PENDING`, `LICENSE`, ...). Match on this, never on the prose: the
 * wording has already changed once between builds.
 */
export function parseRekeyCode(output: string): string | undefined {
  return /fp-crypt-(?:rekey|key):\s*([A-Z][A-Z0-9_]{2,})\b/.exec(output)?.[1]
}

/**
 * The conversion runs a kernel, so it takes a licence slot like a launch does.
 * `LICENSE` therefore also means "every slot on this machine is taken", whose
 * fix - close a browser - is the opposite of the licence problems it names.
 */
const CODE_HINTS: Record<string, string> = {
  LICENSE: 'If the licence itself is fine, this means the machine is already running as many browsers as the plan allows: close one and export again.',
  IN_USE: 'Close this profile\'s browser and export again.',
  REKEY_PENDING: 'A previous conversion of this profile was interrupted. Open the profile once to finish it, then export again.',
}

export class CryptRekeyError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super(message)
    this.name = 'CryptRekeyError'
  }
}

/** The code on a `CryptRekeyError` produced by our own timeout, not a kernel refusal. */
export const REKEY_TIMEOUT_CODE = 'TIMEOUT'

export interface CryptRekeyOptions extends Omit<RekeyArgsOptions, 'platform'> {
  exePath: string
  timeoutMs?: number
  onProgress?: (message: string) => void
}

/** Convert a profile directory from one encryption scheme to another. */
export function runCryptRekey(opts: CryptRekeyOptions): Promise<string> {
  const args = buildRekeyArgs(opts)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REKEY_TIMEOUT_MS
  opts.onProgress?.('Converting the profile encryption')
  return new Promise((resolve, reject) => {
    execFile(
      opts.exePath,
      args,
      { timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim()
        if (!err) return resolve(output)
        // Node kills the child itself when `timeout` elapses (default signal
        // SIGTERM) and marks the error `killed`; a kernel refusal instead exits
        // on its own with a code and is never `killed`. That flag is the only
        // reliable way to tell "we gave up waiting" from "the kernel said no" -
        // both can otherwise show up as "no code, exit code unknown".
        if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          const label = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
          reject(new CryptRekeyError(
            `Profile encryption conversion did not finish within ${label} and was stopped. ` +
              'A real conversion finishes in under a second, so this almost always means the kernel does not ' +
              'support --fp-crypt-rekey and opened a full browser on the temporary copy instead of converting it. ' +
              'Update the kernel and export again.' + (output ? ` Output so far: ${output.slice(-500)}` : ''),
            REKEY_TIMEOUT_CODE,
            null,
            output,
          ))
          return
        }
        const raw = (err as NodeJS.ErrnoException & { code?: number | string }).code
        const exitCode = typeof raw === 'number' ? raw : null
        const code = parseRekeyCode(output)
        const hint = code ? CODE_HINTS[code] : undefined
        reject(new CryptRekeyError(
          `Profile encryption conversion failed (${code ?? 'no code'}, exit code ${exitCode ?? raw ?? 'unknown'})` +
            (output ? `: ${output.slice(-500)}` : '') + (hint ? ` ${hint}` : ''),
          code,
          exitCode,
          output,
        ))
      },
    )
  })
}

/** What the export hands the conversion step. */
export interface RekeyRequest {
  userDataDir: string
  from: string
  to: string
}

export type RekeyRunner = (req: RekeyRequest) => Promise<void>

export interface ExportProfileArchiveOptions {
  /** The profile's own key. Fetched with `key`/`server` when not supplied. */
  cryptKey?: string
  getCryptKey?: () => Promise<string | undefined>
  key?: string
  server?: string
  /** Where kernels are installed; needed unless `exePath` is given. */
  cacheDir?: string
  exePath?: string
  licenseToken?: string
  /** Parent for the temporary copy. Defaults to the OS temp directory. */
  tmpDir?: string
  timeoutMs?: number
  onProgress?: (message: string) => void
  /** Replace the conversion step (tests, or a caller that runs its own kernel). */
  rekey?: RekeyRunner
}

/**
 * Build a portable `.fpprofile` from any profile, encrypted or not.
 *
 * An encrypted profile's key never enters its directory, so packing the
 * directory would hand the recipient ciphertext and nothing to open it with.
 * Such a profile is copied to a temporary directory, converted there to the
 * kernel's built-in key, and packed from the copy. The profile itself is never
 * touched, and the archive opens anywhere - which is what export means.
 */
export async function exportProfileArchiveAsync(
  profileDir: string,
  meta: PortableProfileMeta,
  options: ExportProfileArchiveOptions = {},
): Promise<Buffer> {
  const persona = readExportablePersona(profileDir, meta)
  if (!isProfileEncrypted(profileDir)) return exportProfileArchive(profileDir, meta)

  const userDataDir = path.join(profileDir, 'user-data')
  // Refuse before copying anything. Both branches mean the directory's own
  // records disagree with its data, and converting on a guess would either
  // destroy the copy or produce an archive that only looks converted.
  const before = profileCryptMarker(userDataDir)
  if (before !== 'key-bound') {
    throw new Error(
      `This profile is recorded as encrypted, but its browser data carries no encryption verifier ` +
        `(${before}). Open it once and export again; exporting now could produce an unusable file.`,
    )
  }

  const cryptKey = options.cryptKey ?? (await resolveCryptKeyForExport(meta, options))
  if (!cryptKey || !CRYPT_KEY_PATTERN.test(cryptKey)) {
    throw new Error(
      'This profile is encrypted and its encryption key could not be obtained, so it cannot be ' +
        'exported. Sign in to the account that owns it and try again.',
    )
  }

  const rekey = options.rekey ?? defaultRekeyRunner(persona.kernelVersion ?? meta.kernelVersion, options)
  const staging = fs.mkdtempSync(path.join(options.tmpDir ?? os.tmpdir(), 'antibrow-export-'))
  try {
    const copy = path.join(staging, 'profile')
    options.onProgress?.('Preparing a decrypted copy for export')
    // crypt-state.json is deliberately not copied: the copy is on its way to
    // being unencrypted, and the marker is what tells the pack below to refuse.
    copyPortableProfileFiles(profileDir, copy)
    await rekey({ userDataDir: path.join(copy, 'user-data'), from: cryptKey, to: NO_CRYPT_KEY })

    // Chromium ignores switches it does not know, so a kernel without this
    // feature starts, converts nothing and exits successfully. Verify the
    // outcome rather than the kernel's version: the verifier below is written
    // by the kernel when the key is bound and removed only by the conversion,
    // so an untouched copy still carries it.
    const after = profileCryptMarker(path.join(copy, 'user-data'))
    if (after !== 'plain') {
      throw new Error(
        `The kernel did not convert this profile (its data is still ${after === 'key-bound' ? 'encrypted' : 'unreadable'}). ` +
          'This kernel build has no --fp-crypt-rekey support; update it and export again. ' +
          'No file was written.',
      )
    }
    // The id defaults to the directory's own name, and the copy's name is not
    // the profile's - pin it before packing from somewhere else.
    return exportProfileArchive(copy, { ...meta, id: meta.id ?? path.basename(profileDir) })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

async function resolveCryptKeyForExport(
  meta: PortableProfileMeta,
  options: ExportProfileArchiveOptions,
): Promise<string | undefined> {
  if (options.getCryptKey) return options.getCryptKey()
  if (!options.key) return undefined
  return fetchProfileCryptKey({ key: options.key, server: options.server, name: meta.name })
}

/** Resolves the kernel and the licence lazily, so a supplied runner needs neither. */
function defaultRekeyRunner(kernelVersion: string | undefined, options: ExportProfileArchiveOptions): RekeyRunner {
  return async (req) => {
    const exePath = options.exePath ?? (await resolveKernelExe(kernelVersion, options))
    // The conversion mode verifies the licence before it parses anything else,
    // and holds a concurrency slot while it runs, same as a launch.
    const licenseToken = options.licenseToken
      ?? (await getLicenseToken({ key: options.key, server: options.server })).token
    await runCryptRekey({
      ...req, exePath, licenseToken, timeoutMs: options.timeoutMs, onProgress: options.onProgress,
    })
  }
}

async function resolveKernelExe(
  kernelVersion: string | undefined,
  options: ExportProfileArchiveOptions,
): Promise<string> {
  if (!options.cacheDir) {
    throw new Error('Cannot locate the browser kernel for the export: pass cacheDir or exePath.')
  }
  // Versions published after this release exist only in the manifest, so the
  // catalogue has to be refreshed before the lookup - exactly the reasoning
  // behind the Android floor's strict resolution. A lenient lookup on a stale
  // catalogue would silently convert on whatever kernel happens to be
  // compiled in, rather than the one this profile is actually pinned to.
  await refreshKernelVersions(options.cacheDir)
  const kv = findKernelVersionStrict(normalizeKernelVersion(kernelVersion))
  return ensureKernel(options.cacheDir, kv, options.onProgress)
}

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProxyBinding } from '../proxy-binding'
import { encodePathSegment } from '../url-path'

const META_FILE = 'profile.json'

/** Travels in the cloud archive: `{ "encrypted": boolean }`, no key material. */
export const CRYPT_STATE_FILE = 'crypt-state.json'

/**
 * Machine-local, never packed: this directory has a key waiting for it and the
 * next launch is the one that offers it. Only the kernel can turn that into an
 * answer, so the marker survives until the directory's data can be read.
 */
export const CRYPT_PENDING_FILE = '.crypt-pending'

/**
 * A profile's identity, stored inside its own directory. `id` is authoritative
 * (the server's stable id when known); the directory name is normally the same
 * string but may lag when a rename could not be performed.
 *
 * Never packed into the cloud archive: restoring an archive into a different
 * directory would write a contradicting id there.
 */
export interface ProfileMeta {
  id: string
  name: string
  origin: 'server' | 'local'
  serverCheckedAt?: string
  /** This directory's browser data was created under an external crypt key. */
  encrypted?: true
  /** Machine-local proxy binding. Never packed into the cloud archive, so a
   *  synced profile keeps its binding server-side instead. */
  proxy?: ProxyBinding
  /** Machine-local group/tags for a profile with no cloud counterpart. A
   *  synced profile keeps these server-side instead (config.group, top-level tags). */
  group?: string
  tags?: string[]
}

/** `legacy` = a directory with no record yet, named after the profile. */
export interface ProfileEntry {
  id: string
  name: string
  origin: 'server' | 'local' | 'legacy'
  serverCheckedAt?: string
  dir: string
}

/** Kept out of `profiles/` so tools that enumerate managed profiles never see throwaway automation runs. */
export const TEMPORARY_PROFILES_DIR = 'profiles-temp'

export interface ProfileRootOptions {
  /** Resolve against the temporary tree instead of the managed one. */
  temporary?: boolean
}

export function profilesRoot(cacheDir: string, opts?: ProfileRootOptions): string {
  return path.join(cacheDir, opts?.temporary ? TEMPORARY_PROFILES_DIR : 'profiles')
}

/** Directory-safe form of a name. Kept identical in the Python SDK. */
export function sanitizeProfileName(name: string): string {
  if (!name) throw new Error('Profile name is required')
  const sanitized = name.replace(/[<>:"/\\|?*]/g, '_').replace(/\.\./g, '_').trim()
  if (!sanitized) throw new Error('Invalid profile name after sanitization')
  return sanitized
}

function parseBinding(raw: unknown): ProxyBinding | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const b = raw as Record<string, unknown>
  if (b.kind === 'managed' && typeof b.managedProxyId === 'string') {
    return { kind: 'managed', managedProxyId: b.managedProxyId }
  }
  if (b.kind === 'local' && typeof b.localProxyId === 'string') {
    return { kind: 'local', localProxyId: b.localProxyId }
  }
  if (b.kind === 'url' && typeof b.url === 'string') return { kind: 'url', url: b.url }
  return undefined
}

function parseTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.every((t): t is string => typeof t === 'string') ? raw : undefined
}

export function readProfileMeta(dir: string): ProfileMeta | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as Partial<ProfileMeta>
    if (typeof raw.id !== 'string' || !raw.id) return undefined
    if (typeof raw.name !== 'string' || !raw.name) return undefined
    return {
      id: raw.id,
      name: raw.name,
      origin: raw.origin === 'server' ? 'server' : 'local',
      serverCheckedAt: typeof raw.serverCheckedAt === 'string' ? raw.serverCheckedAt : undefined,
      encrypted: raw.encrypted === true ? true : undefined,
      proxy: parseBinding((raw as { proxy?: unknown }).proxy),
      group: typeof raw.group === 'string' ? raw.group : undefined,
      tags: parseTags((raw as { tags?: unknown }).tags),
    }
  } catch {
    return undefined
  }
}

export function writeProfileMeta(dir: string, meta: ProfileMeta): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8')
}

/**
 * Applies `patch` on top of whatever is already recorded instead of replacing
 * the file outright, so a write that only names a few fields (e.g. the
 * server-check stamp) cannot silently erase the ones it left out - `proxy`,
 * `group`, `tags`, `encrypted`. A key the caller does include - even set to
 * `undefined`, such as clearing `serverCheckedAt` on promotion to a server id -
 * still overwrites, same as plain object spread.
 */
function patchProfileMeta(dir: string, patch: Partial<ProfileMeta> & Pick<ProfileMeta, 'id' | 'name' | 'origin'>): void {
  writeProfileMeta(dir, { ...readProfileMeta(dir), ...patch })
}

/**
 * Whether this profile's data is encrypted, as the profile directory itself
 * reports it. Encryption is a property of the DATA, so the answer travels with
 * the data: `crypt-state.json` is packed into the cloud archive, which is what
 * makes a directory restored on a second machine come out right.
 *
 * The identity record's own `encrypted` flag is machine-local (profile.json is
 * never packed - it carries the guest marker, which must not travel). It is the
 * creation-time writer and the fallback for directories predating the state
 * file; the state file wins whenever both are present, because it is the one
 * that was restored alongside the data it describes.
 */
export function isProfileEncrypted(dir: string): boolean {
  const fromState = readCryptState(dir)
  if (fromState !== undefined) return fromState
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as { encrypted?: unknown }
    return raw.encrypted === true
  } catch {
    return false
  }
}

/** Undefined when the directory says nothing, which is not the same as "no". */
export function readCryptState(dir: string): boolean | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CRYPT_STATE_FILE), 'utf8')) as { encrypted?: unknown }
    return raw.encrypted === true
  } catch {
    return undefined
  }
}

export function writeCryptState(dir: string, encrypted: boolean): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, CRYPT_STATE_FILE), JSON.stringify({ encrypted }, null, 2), 'utf8')
}

/**
 * Record that this profile's data is encrypted, in both places: the archived
 * state file (so every machine that restores this profile agrees) and the local
 * identity record (so a directory whose archive predates the state file still
 * has an answer). No key material, nothing secret - one boolean.
 */
export function markProfileEncrypted(dir: string): void {
  writeCryptState(dir, true)
  const file = path.join(dir, META_FILE)
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch {
    // No record yet, or an unreadable one: the state file is what must land.
  }
  fs.writeFileSync(file, JSON.stringify({ ...raw, encrypted: true }, null, 2), 'utf8')
}

/** Undo a mark the data contradicts. Never called on "cannot tell". */
export function unmarkProfileEncrypted(dir: string): void {
  writeCryptState(dir, false)
  const file = path.join(dir, META_FILE)
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return
    raw = parsed as Record<string, unknown>
  } catch {
    return
  }
  if (!('encrypted' in raw)) return
  delete raw.encrypted
  fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
}

export function isCryptKeyPending(dir: string): boolean {
  return fs.existsSync(path.join(dir, CRYPT_PENDING_FILE))
}

/** Record that the next launch has a key to offer this directory. */
export function markCryptKeyPending(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, CRYPT_PENDING_FILE), '', 'utf8')
}

export function clearCryptKeyPending(dir: string): void {
  fs.rmSync(path.join(dir, CRYPT_PENDING_FILE), { force: true })
}

/**
 * Whether this user-data directory's data is bound to an external key, read
 * from the verifier the kernel keeps in `Local State`.
 *
 * `unreadable` is its own answer on purpose. "Cannot tell" must never collapse
 * into "no key": that is the answer that ships an archive nobody can open.
 */
export function profileCryptMarker(userDataDir: string): 'key-bound' | 'plain' | 'unreadable' {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'))
  } catch {
    return 'unreadable'
  }
  if (!parsed || typeof parsed !== 'object') return 'unreadable'
  const marker = (parsed as { fp_crypt?: unknown }).fp_crypt
  // A pending conversion counts as key-bound: the kernel refuses to open a
  // half-converted profile, with the key and without it alike.
  return marker && typeof marker === 'object' ? 'key-bound' : 'plain'
}

export type CryptSettlement = 'bound' | 'plain' | 'unknown'

/**
 * Make the mark say what the kernel did rather than what we asked for. Chromium
 * ignores switches it does not understand, so `--fp-crypt-key` may have been
 * dropped on the floor and the profile created plain; the verifier the kernel
 * writes is the only witness either way.
 *
 * `unknown` writes nothing at all - a directory that cannot answer keeps
 * whatever it already claims, so a genuinely key-bound profile with an
 * unreadable `Local State` still refuses to launch without its key. Clearing a
 * mark therefore needs positive evidence: readable data carrying no verifier,
 * which is data under the kernel's built-in key with no protection to drop.
 */
export function settleCryptState(profileDir: string): CryptSettlement {
  const marker = profileCryptMarker(path.join(profileDir, 'user-data'))
  if (marker === 'unreadable') return 'unknown'
  if (marker === 'key-bound') {
    if (!isProfileEncrypted(profileDir)) markProfileEncrypted(profileDir)
  } else if (isProfileEncrypted(profileDir)) {
    unmarkProfileEncrypted(profileDir)
  }
  clearCryptKeyPending(profileDir)
  return marker === 'key-bound' ? 'bound' : 'plain'
}

export function listProfileEntries(cacheDir: string, opts?: ProfileRootOptions): ProfileEntry[] {
  const root = profilesRoot(cacheDir, opts)
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const entries: ProfileEntry[] = []
  for (const name of names) {
    const dir = path.join(root, name)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const meta = readProfileMeta(dir)
    entries.push(meta ? { ...meta, dir } : { id: name, name, origin: 'legacy', dir })
  }
  return entries
}

/** How long a "not on the server" answer is trusted before re-asking. */
export const SERVER_RECHECK_MS = 24 * 60 * 60 * 1000

export interface ResolvedProfile {
  dir: string
  id: string
  name: string
}

function findByName(entries: ProfileEntry[], name: string): ProfileEntry | undefined {
  // Exact match, case included: the server is case-sensitive, so folding case
  // here would merge two distinct cloud profiles into one directory.
  const hits = entries.filter((e) => e.name === name)
  if (hits.length === 1) return hits[0]
  // Duplicates can only come from hand-edited records. Newest wins.
  if (hits.length > 1) return hits.sort((a, b) => mtime(b.dir) - mtime(a.dir))[0]
  // Directories predating the identity record were named after the sanitized
  // name, so `acct:1` has to recognise its own `acct_1` or the upgrade mints a
  // second profile and abandons the first one's persona.
  const sanitized = sanitizeProfileName(name)
  if (sanitized === name) return undefined
  return entries.find((e) => e.origin === 'legacy' && e.name === sanitized)
}

function mtime(dir: string): number {
  try {
    return fs.statSync(path.join(dir, META_FILE)).mtimeMs
  } catch {
    return 0
  }
}

/** Move `dir` to `<root>/<id>`; returns the directory actually in use. */
function renameToId(dir: string, id: string): string {
  const target = path.join(path.dirname(dir), id)
  if (target === dir) return dir
  if (fs.existsSync(target)) return dir
  try {
    fs.renameSync(dir, target)
    return target
  } catch {
    // Windows file locks and permission errors land here. Nothing depends on the
    // directory name - the record inside it is what identifies the profile.
    return dir
  }
}

function createProfileDir(cacheDir: string, meta: ProfileMeta, opts?: ProfileRootOptions): ResolvedProfile {
  const dir = path.join(profilesRoot(cacheDir, opts), meta.id)
  writeProfileMeta(dir, meta)
  return { dir, id: meta.id, name: meta.name }
}

function adopt(entry: ProfileEntry, id: string, name: string, origin: ProfileMeta['origin'], serverCheckedAt?: string): ResolvedProfile {
  const dir = renameToId(entry.dir, id)
  patchProfileMeta(dir, { id, name, origin, serverCheckedAt })
  return { dir, id, name }
}

/** Take over the directory that owns a server id, creating it when there is none. */
function claim(dir: string, id: string, name: string): ResolvedProfile {
  patchProfileMeta(dir, { id, name, origin: 'server' })
  return { dir, id, name }
}

/**
 * The directory already holding `id`, by record or by name. A failed rename
 * leaves the two disagreeing, so checking `<root>/<id>` alone is not enough.
 */
function holderOf(entries: ProfileEntry[], root: string, id: string, exclude: string): string | undefined {
  const byRecord = entries.find((e) => e.id === id && e.dir !== exclude)
  if (byRecord) return byRecord.dir
  const byName = path.join(root, id)
  return byName !== exclude && fs.existsSync(byName) ? byName : undefined
}

/** Stop answering to `name` without moving or deleting anything. */
function shadow(entry: ProfileEntry, name: string): void {
  const meta = readProfileMeta(entry.dir)
  patchProfileMeta(entry.dir, meta
    ? { id: meta.id, name: `${meta.name} (local)`, origin: meta.origin }
    // A record-less directory gets one now, so it stays listable and stops
    // shadowing a name that belongs to another directory.
    : { id: randomUUID(), name: `${name} (local)`, origin: 'local' })
}

/** Directory for a name without consulting the server. */
export function resolveProfileDirSync(
  cacheDir: string,
  profileName: string,
  opts?: ProfileRootOptions,
): ResolvedProfile {
  const name = profileName
  sanitizeProfileName(name)   // reject names that cannot become a directory
  const found = findByName(listProfileEntries(cacheDir, opts), name)
  if (found && found.origin !== 'legacy') return { dir: found.dir, id: found.id, name }
  const id = randomUUID()
  if (found) return adopt(found, id, name, 'local')
  return createProfileDir(cacheDir, { id, name, origin: 'local' }, opts)
}

interface ServerLookup {
  id?: string
  /** True when the server answered; false when it could not be reached. */
  checked: boolean
}

async function lookupServerId(name: string, key: string, server: string): Promise<ServerLookup> {
  try {
    const url = new URL(`/api/v1/profiles/${encodePathSegment(name)}`, server)
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    // 403 is the free-plan answer to this route. It is an answer - treating it
    // as an outage would re-ask on every single launch, forever.
    if (res.status === 404 || res.status === 403) return { checked: true }
    if (!res.ok) return { checked: false }
    const body = (await res.json()) as { id?: unknown }
    return typeof body.id === 'string' && body.id ? { id: body.id, checked: true } : { checked: true }
  } catch {
    return { checked: false }
  }
}

function needsLookup(found: ProfileEntry | undefined): boolean {
  if (!found) return true
  if (found.origin === 'legacy') return true
  if (found.origin === 'server') return false
  // A locally minted id may still be waiting for the cloud profile it belongs to.
  const last = found.serverCheckedAt ? Date.parse(found.serverCheckedAt) : 0
  return !(last > 0 && Date.now() - last < SERVER_RECHECK_MS)
}

/**
 * The directory holding `profileName`, taking the server's stable id when one is
 * available so the SDK and the desktop app land on the same directory. Every
 * failure degrades to a local id; resolution never blocks a launch.
 */
export async function resolveProfileDir(opts: {
  cacheDir: string
  profileName: string
  key?: string
  server?: string
  /** Skips the server entirely: a temporary profile has no cloud counterpart. */
  temporary?: boolean
  onProgress?: (message: string) => void
}): Promise<ResolvedProfile> {
  const name = opts.profileName
  sanitizeProfileName(name)
  const root = profilesRoot(opts.cacheDir, opts)
  const entries = listProfileEntries(opts.cacheDir, opts)
  const found = findByName(entries, name)
  const lookup: ServerLookup =
    !opts.temporary && opts.key && opts.server && needsLookup(found)
      ? await lookupServerId(name, opts.key, opts.server)
      : { checked: false }
  const checkedAt = lookup.checked ? new Date().toISOString() : undefined

  if (!found) {
    if (lookup.id) return claim(holderOf(entries, root, lookup.id, '') ?? path.join(root, lookup.id), lookup.id, name)
    return createProfileDir(
      opts.cacheDir,
      { id: randomUUID(), name, origin: 'local', serverCheckedAt: checkedAt },
      opts,
    )
  }

  if (!lookup.id && found.origin !== 'legacy') {
    // Nothing to align; only the negative-cache stamp can have changed.
    if (checkedAt) patchProfileMeta(found.dir, { id: found.id, name, origin: found.origin, serverCheckedAt: checkedAt })
    return { dir: found.dir, id: found.id, name }
  }

  // A record that already carried a server id and now gets a different one is
  // the only real namesake: some other machine's cloud profile under this name.
  const foreign = found.origin === 'server' && !!lookup.id && lookup.id !== found.id
  const id = lookup.id ?? randomUUID()
  const holder = holderOf(entries, root, id, found.dir)
  if (foreign || holder) {
    // Two directories carrying one id make every lookup by id a coin flip, so
    // the directory already holding it keeps it and this one steps aside with
    // its data.
    opts.onProgress?.(`Another profile already uses the name "${name}"; keeping it as "${name} (local)"`)
    shadow(found, name)
    return claim(holder ?? path.join(root, id), id, name)
  }
  // A locally minted id is not a claim on the name: when the server finally
  // names this profile, that is this directory being adopted, not replaced.
  return adopt(found, id, name, lookup.id ? 'server' : 'local', lookup.id ? undefined : checkedAt)
}

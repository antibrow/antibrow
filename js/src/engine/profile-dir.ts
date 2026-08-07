import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { encodePathSegment } from '../url-path'

const META_FILE = 'profile.json'

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
}

/** `legacy` = a directory with no record yet, named after the profile. */
export interface ProfileEntry {
  id: string
  name: string
  origin: 'server' | 'local' | 'legacy'
  serverCheckedAt?: string
  dir: string
}

export function profilesRoot(cacheDir: string): string {
  return path.join(cacheDir, 'profiles')
}

/** Directory-safe form of a name. Kept identical in the Python SDK. */
export function sanitizeProfileName(name: string): string {
  if (!name) throw new Error('Profile name is required')
  const sanitized = name.replace(/[<>:"/\\|?*]/g, '_').replace(/\.\./g, '_').trim()
  if (!sanitized) throw new Error('Invalid profile name after sanitization')
  return sanitized
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
    }
  } catch {
    return undefined
  }
}

export function writeProfileMeta(dir: string, meta: ProfileMeta): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8')
}

export function listProfileEntries(cacheDir: string): ProfileEntry[] {
  let names: string[]
  try {
    names = fs.readdirSync(profilesRoot(cacheDir))
  } catch {
    return []
  }
  const entries: ProfileEntry[] = []
  for (const name of names) {
    const dir = path.join(profilesRoot(cacheDir), name)
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

function createProfileDir(cacheDir: string, meta: ProfileMeta): ResolvedProfile {
  const dir = path.join(profilesRoot(cacheDir), meta.id)
  writeProfileMeta(dir, meta)
  return { dir, id: meta.id, name: meta.name }
}

function adopt(entry: ProfileEntry, id: string, name: string, origin: ProfileMeta['origin'], serverCheckedAt?: string): ResolvedProfile {
  const dir = renameToId(entry.dir, id)
  writeProfileMeta(dir, { id, name, origin, serverCheckedAt })
  return { dir, id, name }
}

/** Take over the directory that owns a server id, creating it when there is none. */
function claim(dir: string, id: string, name: string): ResolvedProfile {
  writeProfileMeta(dir, { id, name, origin: 'server' })
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
  writeProfileMeta(entry.dir, meta
    ? { ...meta, name: `${meta.name} (local)` }
    // A record-less directory gets one now, so it stays listable and stops
    // shadowing a name that belongs to another directory.
    : { id: randomUUID(), name: `${name} (local)`, origin: 'local' })
}

/** Directory for a name without consulting the server. */
export function resolveProfileDirSync(cacheDir: string, profileName: string): ResolvedProfile {
  const name = profileName
  sanitizeProfileName(name)   // reject names that cannot become a directory
  const found = findByName(listProfileEntries(cacheDir), name)
  if (found && found.origin !== 'legacy') return { dir: found.dir, id: found.id, name }
  const id = randomUUID()
  if (found) return adopt(found, id, name, 'local')
  return createProfileDir(cacheDir, { id, name, origin: 'local' })
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
  onProgress?: (message: string) => void
}): Promise<ResolvedProfile> {
  const name = opts.profileName
  sanitizeProfileName(name)
  const root = profilesRoot(opts.cacheDir)
  const entries = listProfileEntries(opts.cacheDir)
  const found = findByName(entries, name)
  const lookup: ServerLookup =
    opts.key && opts.server && needsLookup(found)
      ? await lookupServerId(name, opts.key, opts.server)
      : { checked: false }
  const checkedAt = lookup.checked ? new Date().toISOString() : undefined

  if (!found) {
    if (lookup.id) return claim(holderOf(entries, root, lookup.id, '') ?? path.join(root, lookup.id), lookup.id, name)
    return createProfileDir(opts.cacheDir, { id: randomUUID(), name, origin: 'local', serverCheckedAt: checkedAt })
  }

  if (!lookup.id && found.origin !== 'legacy') {
    // Nothing to align; only the negative-cache stamp can have changed.
    if (checkedAt) writeProfileMeta(found.dir, { id: found.id, name, origin: found.origin, serverCheckedAt: checkedAt })
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

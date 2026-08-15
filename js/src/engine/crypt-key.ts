import { isCryptKeyPending, isProfileEncrypted } from './profile-dir'
import { encodePathSegment } from '../url-path'

const DEFAULT_SERVER = 'https://antibrow.com'

/** 32 bytes as lowercase hex, the form the kernel's --fp-crypt-key takes. */
const CRYPT_KEY_PATTERN = /^[0-9a-f]{64}$/

/**
 * `{ cryptKey: null }` is the server saying this profile has no key, which is a
 * usable answer. Anything else unexpected is an error: reporting a malformed
 * body as "no key" would launch an encrypted profile without its key.
 */
export function parseCryptKeyBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') throw new Error('Encryption key response was not an object')
  const key = (body as { cryptKey?: unknown }).cryptKey
  if (key === null || key === undefined) return undefined
  if (typeof key !== 'string' || !CRYPT_KEY_PATTERN.test(key)) {
    throw new Error('Encryption key response carried a malformed key')
  }
  return key
}

/** The owner's own key. Guests use the shared endpoint instead. */
export async function fetchProfileCryptKey(opts: {
  key: string
  server?: string
  name: string
}): Promise<string | undefined> {
  const url = new URL(
    `/api/v1/profiles/${encodePathSegment(opts.name)}/crypt-key`,
    opts.server || DEFAULT_SERVER,
  )
  // An encrypted profile cannot launch without this key, so a transport
  // failure here (offline, DNS, connection refused) must not reach the caller
  // as a bare `fetch failed` - it needs to name the profile and say that the
  // key is what could not be reached, or the resulting refusal reads as
  // unexplainable instead of "no network, by design".
  let res: Response
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${opts.key}`, Accept: 'application/json' },
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Could not reach the server to fetch the encryption key for profile "${opts.name}" (${reason}). ` +
        'This profile is encrypted and cannot launch without its key.',
    )
  }
  if (!res.ok) throw new Error(`Failed to fetch the encryption key for profile "${opts.name}": HTTP ${res.status}`)
  const body = await res.json().catch(() => {
    throw new Error(`Encryption key response for profile "${opts.name}" was unreadable`)
  })
  return parseCryptKeyBody(body)
}

/**
 * The key this launch must pass, if any. The profile directory's own state
 * decides - never whether the server happens to hold a key: the kernel binds the
 * key when the profile is created, so a key handed to a directory made without
 * one, and a key withheld from one made with it, both leave it unlaunchable.
 *
 * Two states call for the key. A directory already marked encrypted is bound to
 * one. A directory with a pending marker is not bound yet and is asking to be:
 * binding happens on the profile's first launch, which is therefore the launch
 * that has to carry the flag - the mark cannot be its precondition, because the
 * mark is what that launch produces. Call `settleCryptState` first so a marker
 * the data has already answered is gone by now.
 */
export async function resolveCryptKey(opts: {
  profileDir: string
  cryptKey?: string
  getCryptKey?: () => Promise<string | undefined>
}): Promise<string | undefined> {
  const pending = isCryptKeyPending(opts.profileDir)
  if (!pending && !isProfileEncrypted(opts.profileDir)) return undefined
  // Any failure below propagates. Launching without the flag is never the
  // fallback: the current kernel refuses to start, and older ones silently
  // destroy the profile's cookies and saved passwords. A pending directory is
  // no softer a case - it may already be bound and simply unable to say so.
  const key = opts.cryptKey ?? (opts.getCryptKey ? await opts.getCryptKey() : undefined)
  if (!key) {
    throw new Error(
      `Profile at ${opts.profileDir} ${pending ? 'is being created under' : 'was created with'} an external encryption key, but none could be obtained. Refusing to launch.`,
    )
  }
  if (!CRYPT_KEY_PATTERN.test(key)) throw new Error('Refusing to launch with a malformed encryption key')
  return key
}

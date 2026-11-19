export const API_KEY_PREFIX = 'adb_'
const API_KEY_LENGTH = 32
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
// Largest multiple of CHARS.length below 256, so rejection sampling stays unbiased.
const LIMIT = 256 - (256 % CHARS.length)

export function generateApiKey(): string {
  let key = API_KEY_PREFIX
  const buf = new Uint8Array(64)
  while (key.length < API_KEY_PREFIX.length + API_KEY_LENGTH) {
    crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b >= LIMIT) continue
      key += CHARS.charAt(b % CHARS.length)
      if (key.length === API_KEY_PREFIX.length + API_KEY_LENGTH) break
    }
  }
  return key
}

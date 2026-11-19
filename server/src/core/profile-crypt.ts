// The kernel's crypt key is 32 bytes (64 lowercase hex). It is generated when the
// profile row is created and never changes: the kernel binds it into the profile's
// Local State check bits, so it cannot be added or rotated afterwards.
const CRYPT_KEY_BYTES = 32

export function generateProfileCryptKey(): string {
  const bytes = new Uint8Array(CRYPT_KEY_BYTES)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type CryptKeyResponse = { cryptKey: string } | { cryptKey: null; reason: 'no_key' }

/** Older profiles have no key; the client must tell that apart from an error to launch without one. */
export function cryptKeyResponse(cryptKey: string | null): CryptKeyResponse {
  return cryptKey ? { cryptKey } : { cryptKey: null, reason: 'no_key' }
}

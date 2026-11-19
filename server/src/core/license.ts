import nacl from 'tweetnacl'

const TOKEN_TTL_SECONDS = 86400

function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim()
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * Sign a daily kernel license token: base64(payload_json) + "." + base64(Ed25519 signature).
 * `privKeyHex` is the 32-byte seed as 64 hex chars; `mi` is the concurrency cap
 * the kernel enforces (anything below 1 or non-finite becomes 1).
 */
export function mintLicenseToken(privKeyHex: string, mi: number, now: number = Date.now()): { token: string; exp: number } {
  if (!privKeyHex) throw new Error('License private key is not configured')
  const instances = Number.isFinite(mi) && mi >= 1 ? Math.floor(mi) : 1
  const { secretKey } = nacl.sign.keyPair.fromSeed(hexToBytes(privKeyHex))

  const iat = Math.floor(now / 1000)
  const exp = iat + TOKEN_TTL_SECONDS
  // Built by hand so the key order the kernel parses is fixed.
  const payload = `{"v":1,"iat":${iat},"exp":${exp},"mi":${instances}}`
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), secretKey)
  return { token: `${btoa(payload)}.${bytesToB64(sig)}`, exp }
}

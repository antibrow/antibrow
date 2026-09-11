import crypto from 'node:crypto'
import WebSocket from 'ws'

// fp-relay/1 client, enough of it to make one HTTP request through the tunnel.
// The strings below are cryptographic inputs, not labels: a single changed byte
// derives different keys and the relay drops the connection without a word.
const AAD = Buffer.from('fp-relay/1')
const INFO_C2S = 'fp-relay/1 c2s'
const INFO_S2C = 'fp-relay/1 s2c'
const SALT_LEN = 32
const PSK_LEN = 32
const STATUS_OK = 0x00

function hkdf(psk: Uint8Array, salt: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', psk, salt, Buffer.from(info), 32))
}

function nonce(counter: bigint): Buffer {
  const n = Buffer.alloc(12) // 0x00000000 || uint64be(counter)
  n.writeBigUInt64BE(counter, 4)
  return n
}

function seal(key: Buffer, counter: bigint, plaintext: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce(counter))
  c.setAAD(AAD)
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
}

function openFrame(key: Buffer, counter: bigint, frame: Buffer): Buffer {
  if (frame.length < 16) throw new Error('relay frame too short')
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(counter))
  d.setAAD(AAD)
  d.setAuthTag(frame.subarray(frame.length - 16))
  return Buffer.concat([d.update(frame.subarray(0, frame.length - 16)), d.final()])
}

/** ver:u8 | hostLen:u8 | host | port:u16be | credLen:u16be | cred */
function encodeInit(host: string, port: number, cred: string): Buffer {
  const h = Buffer.from(host)
  const c = Buffer.from(cred)
  if (h.length > 255) throw new Error('relay target host too long')
  const out = Buffer.alloc(1 + 1 + h.length + 2 + 2 + c.length)
  let o = 0
  out.writeUInt8(1, o++)
  out.writeUInt8(h.length, o++)
  h.copy(out, o); o += h.length
  out.writeUInt16BE(port, o); o += 2
  out.writeUInt16BE(c.length, o); o += 2
  c.copy(out, o)
  return out
}

/**
 * The pre-shared key rides on the proxy URL (`relay://user:pass@host?key=…`),
 * which is also how the kernel picks encrypted mode. A malformed key throws
 * rather than returning null: the caller asked for encryption, and quietly
 * falling back to the plaintext protocol is the one outcome nobody wants.
 */
export function relayKeyFromUrl(relay: URL): Uint8Array | null {
  const raw = relay.searchParams.get('key')
  if (!raw) return null
  const key = Buffer.from(raw, 'base64url')
  if (key.length !== PSK_LEN) {
    throw new Error(`relay key must decode to ${PSK_LEN} bytes, got ${key.length}`)
  }
  return key
}

export interface RelayFetchOptions {
  relay: URL
  key: Uint8Array
  host: string
  port: number
  path: string
  timeoutMs: number
  /** Tests only: speak ws:// to a local relay instead of wss://. */
  insecure?: boolean
}

/** One plaintext-HTTP request through an fp-relay/1 tunnel; returns the body. */
export function relayFetch(opts: RelayFetchOptions): Promise<string> {
  const { relay, key, host, port, path, timeoutMs } = opts
  const scheme = opts.insecure ? 'ws' : 'wss'
  const ws = new WebSocket(`${scheme}://${relay.host}${relay.pathname === '/' ? '' : relay.pathname}`)
  ws.binaryType = 'nodebuffer'

  const salt = crypto.randomBytes(SALT_LEN)
  const c2s = hkdf(key, salt, INFO_C2S)
  const s2c = hkdf(key, salt, INFO_S2C)
  const cred = relay.username
    ? `${decodeURIComponent(relay.username)}:${decodeURIComponent(relay.password ?? '')}`
    : ''

  return new Promise<string>((resolve, reject) => {
    let sendCtr = 1n
    let recvCtr = 0n
    let accepted = false
    let raw = ''
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* already closing */ }
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`relay did not respond within ${timeoutMs}ms`))),
      timeoutMs,
    )

    ws.on('open', () => {
      const init = seal(c2s, 0n, encodeInit(host, port, cred))
      ws.send(Buffer.concat([salt, init]))
      ws.send(seal(c2s, sendCtr++, Buffer.from(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: application/json\r\n`
        + 'Accept-Encoding: identity\r\nConnection: close\r\n\r\n',
      )))
    })

    ws.on('message', (data: Buffer) => {
      try {
        const pt = openFrame(s2c, recvCtr++, data)
        if (!accepted) {
          accepted = true
          // Every rejection closes the socket silently instead - a status byte
          // here that is not OK means a future protocol revision, not a refusal.
          if (pt[0] !== STATUS_OK) throw new Error(`relay refused the tunnel, status ${pt[0]}`)
          return
        }
        raw += pt.toString('latin1')
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))))
      }
    })

    ws.on('error', (e: Error) => finish(() => reject(e)))

    ws.on('close', () => finish(() => {
      // A relay that rejects the credential, the key or the upstream dial says
      // nothing at all - so silence here has to be reported as the failure it is.
      if (!accepted) {
        reject(new Error('relay closed the connection before the tunnel opened (key, credential or upstream refused)'))
        return
      }
      try { resolve(parseHttpBody(raw)) } catch (e) { reject(e instanceof Error ? e : new Error(String(e))) }
    }))
  })
}

function parseHttpBody(raw: string): string {
  const sep = raw.indexOf('\r\n\r\n')
  if (sep < 0) throw new Error('relay tunnel closed without a complete HTTP response')
  const head = raw.slice(0, sep)
  const body = raw.slice(sep + 4)
  if (/transfer-encoding:\s*chunked/i.test(head)) return dechunk(body)
  const declared = /content-length:\s*(\d+)/i.exec(head)?.[1]
  if (declared !== undefined && body.length !== Number(declared)) {
    throw new Error(`relay response truncated: declared ${declared} bytes, got ${body.length}`)
  }
  return body
}

function dechunk(input: string): string {
  let out = ''
  let rest = input
  for (;;) {
    const at = rest.indexOf('\r\n')
    if (at < 0) break
    const size = parseInt(rest.slice(0, at).split(';')[0] ?? '', 16)
    if (!Number.isFinite(size) || size === 0) break
    out += rest.slice(at + 2, at + 2 + size)
    rest = rest.slice(at + 2 + size + 2)
  }
  return out
}

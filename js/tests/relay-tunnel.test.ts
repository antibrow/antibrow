import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { relayFetch, relayKeyFromUrl } from '../src/engine/relay-tunnel'

// The server half of fp-relay/1, written against the protocol spec rather than
// against our client, so a client that drifts from the wire format fails here.
const AAD = Buffer.from('fp-relay/1')
const hkdf = (psk: Buffer, salt: Buffer, info: string) =>
  Buffer.from(crypto.hkdfSync('sha256', psk, salt, Buffer.from(info), 32))
const nonce = (counter: bigint) => {
  const n = Buffer.alloc(12)
  n.writeBigUInt64BE(counter, 4)
  return n
}
function seal(key: Buffer, counter: bigint, plaintext: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce(counter))
  c.setAAD(AAD)
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
}
function open(key: Buffer, counter: bigint, frame: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(counter))
  d.setAAD(AAD)
  d.setAuthTag(frame.subarray(frame.length - 16))
  return Buffer.concat([d.update(frame.subarray(0, frame.length - 16)), d.final()])
}

interface Capture { host: string; port: number; cred: string; request: string }

/** A relay that dials a canned "upstream" instead of the network. */
async function startFakeRelay(psk: Buffer, reply: string, cap: Capture[]) {
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => session(ws))
  })
  const session = (ws: WebSocket) => {
    let keys: { c2s: Buffer; s2c: Buffer } | undefined
    let recv = 0n
    let send = 1n
    let entry: Capture | undefined
    ws.binaryType = 'nodebuffer'
    ws.on('message', (data: Buffer) => {
      if (!keys) {
        const salt = data.subarray(0, 32)
        keys = { c2s: hkdf(psk, salt, 'fp-relay/1 c2s'), s2c: hkdf(psk, salt, 'fp-relay/1 s2c') }
        const init = open(keys.c2s, recv++, data.subarray(32))
        const hostLen = init[1]!
        const host = init.subarray(2, 2 + hostLen).toString()
        const port = init.readUInt16BE(2 + hostLen)
        const credLen = init.readUInt16BE(4 + hostLen)
        const cred = init.subarray(6 + hostLen, 6 + hostLen + credLen).toString()
        entry = { host, port, cred, request: '' }
        cap.push(entry)
        ws.send(seal(keys.s2c, 0n, Buffer.from([0x00])))
        return
      }
      entry!.request += open(keys.c2s, recv++, data).toString()
      if (entry!.request.includes('\r\n\r\n')) {
        ws.send(seal(keys.s2c, send++, Buffer.from(reply)))
        ws.close()
      }
    })
  }
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as net.AddressInfo).port
  return { port, close: () => new Promise<void>((r) => { wss.close(); server.close(() => r()) }) }
}

const BODY = '{"status":"success","query":"203.0.113.7"}'
const OK = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

describe('relayKeyFromUrl', () => {
  it('decodes a base64url 32-byte key off the query string', () => {
    const key = crypto.randomBytes(32)
    const url = new URL(`relay://u:p@host/?key=${key.toString('base64url')}`)
    expect(Buffer.from(relayKeyFromUrl(url)!)).toEqual(key)
  })

  it('returns null when there is no key, so managed relays keep the old path', () => {
    expect(relayKeyFromUrl(new URL('relay://u:p@host/'))).toBeNull()
  })

  it('throws on a malformed key rather than downgrading to plaintext', () => {
    expect(() => relayKeyFromUrl(new URL('relay://u:p@host/?key=tooshort'))).toThrow(/32 bytes/)
  })
})

describe('relayFetch', () => {
  it('carries the target, port and credential inside the sealed init frame', async () => {
    const psk = crypto.randomBytes(32)
    const cap: Capture[] = []
    const relay = await startFakeRelay(psk, OK, cap)
    stop = relay.close

    const body = await relayFetch({
      relay: new URL(`relay://alice:s3cret@127.0.0.1:${relay.port}/?key=${psk.toString('base64url')}`),
      key: psk,
      host: 'ip-api.com',
      port: 80,
      path: '/json',
      timeoutMs: 5000,
      insecure: true,
    })

    expect(body).toBe(BODY)
    expect(cap[0]!.host).toBe('ip-api.com')
    expect(cap[0]!.port).toBe(80)
    expect(cap[0]!.cred).toBe('alice:s3cret')
    expect(cap[0]!.request).toContain('GET /json HTTP/1.1')
  })

  it('fails instead of hanging when the relay never answers', async () => {
    const psk = crypto.randomBytes(32)
    const server = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, () => {}) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    stop = () => new Promise<void>((r) => { wss.close(); server.close(() => r()) })

    await expect(relayFetch({
      relay: new URL(`relay://u:p@127.0.0.1:${port}/?key=${psk.toString('base64url')}`),
      key: psk,
      host: 'ip-api.com',
      port: 80,
      path: '/json',
      timeoutMs: 300,
      insecure: true,
    })).rejects.toThrow(/did not respond/)
  })

  it('reports a refused tunnel instead of returning an empty body', async () => {
    const psk = crypto.randomBytes(32)
    const server = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    // The relay closes without a reply on every failure path - that silence is
    // the protocol's anti-probe property, so the client has to name it itself.
    server.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, (ws) => ws.close()) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    stop = () => new Promise<void>((r) => { wss.close(); server.close(() => r()) })

    await expect(relayFetch({
      relay: new URL(`relay://u:p@127.0.0.1:${port}/?key=${psk.toString('base64url')}`),
      key: psk,
      host: 'ip-api.com',
      port: 80,
      path: '/json',
      timeoutMs: 3000,
      insecure: true,
    })).rejects.toThrow(/closed the connection/)
  })
})

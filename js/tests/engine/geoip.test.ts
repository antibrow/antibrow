import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import { probeProxyExit } from '../../src/engine/geoip'

const GEO_BODY = JSON.stringify({
  status: 'success', country: 'Germany', countryCode: 'DE', city: 'Berlin',
  timezone: 'Europe/Berlin', query: '5.6.7.8',
})

const servers: Array<{ close: () => void }> = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

function httpResponse(body: string, status = '200 OK'): string {
  return `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
}

/** A forward proxy that answers every absolute-URI GET itself. */
async function startHttpProxy(reply: (req: http.IncomingMessage) => { status: number; body: string }): Promise<number> {
  const server = http.createServer((req, res) => {
    const { status, body } = reply(req)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as net.AddressInfo).port
}

/**
 * Minimal SOCKS5 server (RFC 1928 + 1929). It never dials the destination: it
 * plays the destination itself, which is exactly what the probe needs to prove:
 * that the bytes it read came back out of the tunnel.
 */
async function startSocks5(opts: {
  requireAuth?: boolean
  /** Non-zero = refuse the CONNECT with that SOCKS reply code. */
  replyCode?: number
  respondWith?: string
  onAuth?: (user: string, pass: string) => void
} = {}): Promise<number> {
  const server = net.createServer((sock) => {
    let stage: 'greet' | 'auth' | 'request' | 'tunnel' = 'greet'
    sock.on('data', (buf) => {
      if (stage === 'greet') {
        const methods = [...buf.subarray(2, 2 + buf[1])]
        const useAuth = opts.requireAuth && methods.includes(0x02)
        if (opts.requireAuth && !useAuth) { sock.end(Buffer.from([0x05, 0xff])); return }
        sock.write(Buffer.from([0x05, useAuth ? 0x02 : 0x00]))
        stage = useAuth ? 'auth' : 'request'
        return
      }
      if (stage === 'auth') {
        const ulen = buf[1]
        const user = buf.subarray(2, 2 + ulen).toString()
        const plen = buf[2 + ulen]
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString()
        opts.onAuth?.(user, pass)
        sock.write(Buffer.from([0x01, 0x00]))
        stage = 'request'
        return
      }
      if (stage === 'request') {
        const code = opts.replyCode ?? 0x00
        sock.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        if (code !== 0x00) { sock.end(); return }
        stage = 'tunnel'
        return
      }
      // tunnel: the client's HTTP GET arrives here
      sock.end(opts.respondWith ?? httpResponse(GEO_BODY))
    })
    sock.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as net.AddressInfo).port
}

/** A port with nothing behind it: the shape of a proxy that has gone away. */
async function deadPort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

describe('probeProxyExit: HTTP proxy', () => {
  it('reports the exit ip, country and city the proxy returned', async () => {
    const port = await startHttpProxy(() => ({ status: 200, body: GEO_BODY }))
    const r = await probeProxyExit(`http://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(true)
    expect(r.geo).toMatchObject({ ip: '5.6.7.8', countryCode: 'DE', country: 'Germany', city: 'Berlin', timezone: 'Europe/Berlin' })
  })

  it('forwards credentials as Proxy-Authorization', async () => {
    let auth = ''
    const port = await startHttpProxy((req) => {
      auth = String(req.headers['proxy-authorization'] ?? '')
      return { status: 200, body: GEO_BODY }
    })
    await probeProxyExit(`http://u%40x:p%2F1@127.0.0.1:${port}`, 4000)
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('u@x:p/1')
  })

  it('calls a 407 what it is instead of a working proxy', async () => {
    const port = await startHttpProxy(() => ({ status: 407, body: '' }))
    const r = await probeProxyExit(`http://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/407/)
    expect(r.error).toMatch(/authentication/)
  })

  it('rejects a body that is not a geo answer', async () => {
    const port = await startHttpProxy(() => ({ status: 200, body: '<html>blocked by upstream</html>' }))
    const r = await probeProxyExit(`http://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/non-JSON/)
  })

  it('surfaces the geo service\'s own refusal', async () => {
    const port = await startHttpProxy(() => ({ status: 200, body: JSON.stringify({ status: 'fail', message: 'reserved range' }) }))
    const r = await probeProxyExit(`http://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/reserved range/)
  })
})

describe('probeProxyExit: SOCKS5', () => {
  it('tunnels through the proxy and reads the exit node', async () => {
    const port = await startSocks5()
    const r = await probeProxyExit(`socks5://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(true)
    expect(r.geo).toMatchObject({ ip: '5.6.7.8', countryCode: 'DE', city: 'Berlin' })
  })

  it('negotiates username/password auth (RFC 1929)', async () => {
    let seen: [string, string] | null = null
    const port = await startSocks5({ requireAuth: true, onAuth: (u, p) => { seen = [u, p] } })
    const r = await probeProxyExit(`socks5://user:pa%3Ass@127.0.0.1:${port}`, 4000)
    expect(seen).toEqual(['user', 'pa:ss'])
    expect(r.ok).toBe(true)
  })

  it('decodes a chunked response from the tunnel', async () => {
    const chunked = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${GEO_BODY.length.toString(16)}\r\n${GEO_BODY}\r\n0\r\n\r\n`
    const port = await startSocks5({ respondWith: chunked })
    const r = await probeProxyExit(`socks5://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(true)
    expect(r.geo?.countryCode).toBe('DE')
  })

  it('reports a refused CONNECT rather than a country', async () => {
    const port = await startSocks5({ replyCode: 0x05 }) // connection refused
    const r = await probeProxyExit(`socks5://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(false)
    expect(r.geo).toBeUndefined()
    expect(r.error).toBeTruthy()
  })

  it('reports rejected credentials rather than a country', async () => {
    const port = await startSocks5({ requireAuth: true }) // client offers no auth method
    const r = await probeProxyExit(`socks5://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(false)
  })

  /**
   * The regression. `socks5://9.ssuperproxy1.mundossp.com:19288` was reported
   * live with a country and a latency while the proxy was dead, because the geo
   * lookup had no SOCKS5 branch and quietly fell back to geo-locating the
   * gateway's DNS record: an answer a dead proxy resolves just as well.
   */
  it('never invents a country for a socks5 endpoint that is not there', async () => {
    const port = await deadPort()
    const r = await probeProxyExit(`socks5://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(false)
    expect(r.geo).toBeUndefined()
    expect(r.error).toBeTruthy()
  })

  it('times out instead of hanging', async () => {
    // Accepts the TCP connection, then says nothing at all.
    const server = net.createServer(() => {})
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    const r = await probeProxyExit(`socks5://127.0.0.1:${port}`, 300)
    expect(r.ok).toBe(false)
    expect(r.latencyMs).toBeLessThan(3000)
  })
})

describe('probeProxyExit: input handling', () => {
  it('refuses a scheme it cannot actually traverse', async () => {
    const r = await probeProxyExit('ssh://127.0.0.1:22', 1000)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unsupported proxy scheme: ssh/)
  })

  it('refuses a malformed url', async () => {
    const r = await probeProxyExit('not a url', 1000)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid proxy url/)
  })

  it('reports a connection refused by the proxy host', async () => {
    const port = await deadPort()
    const r = await probeProxyExit(`http://127.0.0.1:${port}`, 4000)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ECONNREFUSED|connect/i)
  })
})

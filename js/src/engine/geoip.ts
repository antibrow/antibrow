import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { SocksClient } from 'socks'

export interface ProxyGeo {
  ip: string
  /** Full country name, e.g. "United States". */
  country: string
  /** ISO 3166-1 alpha-2 code, e.g. "US". This is what UIs label an exit node with. */
  countryCode: string
  /** Exit city, e.g. "Los Angeles". Empty string when the geo API omits it. */
  city: string
  timezone: string
  /** Round-trip of the probe request that produced this geo, in ms. Absent when
   *  the caller built a ProxyGeo without probing. */
  rttMs?: number
}

/** Probe outcome. `ok` means the request really came back through the proxy. */
export interface ProxyProbeResult {
  ok: boolean
  geo?: ProxyGeo
  error?: string
  latencyMs: number
}

const GEO_FIELDS = 'status,message,country,countryCode,city,timezone,query'
const GEO_API_HOST = 'ip-api.com'
const GEO_API_PATH = `/json/?fields=${GEO_FIELDS}`
const GEO_API_URL = `http://${GEO_API_HOST}${GEO_API_PATH}`

function preview(s: string): string {
  const line = s.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function parseGeoOrThrow(data: string): ProxyGeo {
  let json: { status?: string; message?: string; query?: string; country?: string; countryCode?: string; city?: string; timezone?: string }
  try {
    json = JSON.parse(data)
  } catch {
    throw new Error(data.trim() ? `geo endpoint returned a non-JSON body: ${preview(data)}` : 'proxy returned an empty response')
  }
  if (json.status !== 'success') {
    throw new Error(`geo lookup failed: ${json.message ?? json.status ?? 'unknown'}`)
  }
  return {
    ip: json.query ?? '',
    country: json.country ?? '',
    countryCode: json.countryCode ?? '',
    city: json.city ?? '',
    timezone: json.timezone ?? '',
  }
}

/** Read an HTTP/1.1 response off a raw socket, undoing chunked framing. */
function parseRawHttpResponse(raw: string): string {
  const sep = raw.indexOf('\r\n\r\n')
  if (sep < 0) throw new Error(raw.trim() ? `malformed HTTP response: ${preview(raw)}` : 'proxy closed the connection without a response')
  const head = raw.slice(0, sep)
  let body = raw.slice(sep + 4)

  const status = parseInt(head.split('\r\n')[0]?.split(' ')[1] ?? '', 10)
  if (status !== 200) throw new Error(`geo endpoint returned HTTP ${Number.isNaN(status) ? preview(head) : status}`)

  if (/^transfer-encoding:\s*chunked/im.test(head)) {
    let out = ''
    while (body.length) {
      const nl = body.indexOf('\r\n')
      if (nl < 0) break
      const size = parseInt(body.slice(0, nl), 16)
      if (!Number.isFinite(size) || size <= 0) break
      out += body.slice(nl + 2, nl + 2 + size)
      body = body.slice(nl + 2 + size + 2)
    }
    return out
  }
  return body
}

function readResponse(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    res.on('data', (chunk: Buffer) => { data += chunk.toString() })
    res.on('end', () => {
      if (res.statusCode !== 200) {
        reject(new Error(`proxy returned HTTP ${res.statusCode}${res.statusCode === 407 ? ' (proxy authentication failed)' : ''}`))
        return
      }
      resolve(data)
    })
    res.on('error', reject)
  })
}

/** HTTP(S) forward proxy: absolute-URL GET sent to the proxy itself. */
function lookupViaHttpProxy(parsed: URL, timeoutMs: number): Promise<ProxyGeo> {
  const secure = parsed.protocol === 'https:'
  const port = parseInt(parsed.port || (secure ? '443' : '80'), 10)
  const headers: Record<string, string> = { Host: GEO_API_HOST }
  if (parsed.username) {
    const creds = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password ?? '')}`
    headers['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`
  }

  return new Promise((resolve, reject) => {
    const mod = secure ? https : http
    const req = mod.request(
      // `agent: false`: a pooled socket left dead by the proxy would make the
      // next probe fail with "socket hang up".
      { host: parsed.hostname, port, path: GEO_API_URL, method: 'GET', headers, agent: false },
      (res) => { readResponse(res).then(parseGeoOrThrow).then(resolve, reject) },
    )
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`proxy did not respond within ${timeoutMs}ms`)) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Relay proxies: target rides in `X-Proxy-Target`, the same path the browser
 * takes, so the exit IP matches. `node:https` because `fetch` drops auth.
 */
function lookupViaRelayHeader(parsed: URL, timeoutMs: number): Promise<ProxyGeo> {
  const creds = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password ?? '')}`
  const headers: Record<string, string> = {
    'Proxy-Authorization': `Basic ${Buffer.from(creds).toString('base64')}`,
    'X-Proxy-Target': GEO_API_URL,
  }
  const port = parseInt(parsed.port || '443', 10)
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: parsed.hostname, port, path: '/', method: 'GET', headers, agent: false },
      (res) => { readResponse(res).then(parseGeoOrThrow).then(resolve, reject) },
    )
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`relay did not respond within ${timeoutMs}ms`)) })
    req.on('error', reject)
    req.end()
  })
}

/** SOCKS5: CONNECT to the geo API and speak HTTP/1.1 on the raw tunnel. */
function lookupViaSocks5(parsed: URL, timeoutMs: number): Promise<ProxyGeo> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket | undefined
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`proxy did not respond within ${timeoutMs}ms`))),
      timeoutMs,
    )

    SocksClient.createConnection({
      proxy: {
        host: parsed.hostname,
        port: parseInt(parsed.port, 10),
        type: 5,
        userId: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      },
      command: 'connect',
      destination: { host: GEO_API_HOST, port: 80 },
      timeout: timeoutMs,
    }).then(({ socket: sock }) => {
      socket = sock
      sock.write(`GET ${GEO_API_PATH} HTTP/1.1\r\nHost: ${GEO_API_HOST}\r\nConnection: close\r\n\r\n`)
      let data = ''
      sock.on('data', (chunk: Buffer) => { data += chunk.toString() })
      sock.on('end', () => finish(() => {
        try { resolve(parseGeoOrThrow(parseRawHttpResponse(data))) } catch (e) { reject(e) }
      }))
      sock.on('error', (e: Error) => finish(() => reject(e)))
    }).catch((e: Error) => finish(() => reject(e)))
  })
}

/**
 * Always goes through the proxy: a hostname fallback answers just as confidently
 * for a dead proxy, which is how a broken one looks healthy.
 */
export async function probeProxyExit(proxyUrl: string, timeoutMs = 10_000): Promise<ProxyProbeResult> {
  const start = Date.now()
  const fail = (msg: string): ProxyProbeResult => ({ ok: false, error: msg, latencyMs: Date.now() - start })

  let parsed: URL
  try {
    parsed = new URL(proxyUrl)
  } catch {
    return fail(`invalid proxy url: ${proxyUrl}`)
  }

  const scheme = parsed.protocol.replace(':', '')
  const lookup =
    scheme === 'relay' ? lookupViaRelayHeader
      : scheme === 'socks5' || scheme === 'socks' ? lookupViaSocks5
        : scheme === 'http' || scheme === 'https' ? lookupViaHttpProxy
          : null
  if (!lookup) return fail(`unsupported proxy scheme: ${scheme}`)

  try {
    const geo = await lookup(parsed, timeoutMs)
    const latencyMs = Date.now() - start
    // Includes DNS, connect and TLS, so it overestimates Chrome's http_rtt -
    // deliberately not compensated: erring slow only ever yields a slower
    // effectiveType, which is still a self-consistent trio.
    if (geo) geo.rttMs = latencyMs
    return { ok: true, geo, latencyMs }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/**
 * This machine's own exit, for launches with no proxy. The kernel leaves the
 * host IP alone there, so the persona has to agree with it: without a public IP
 * WebRTC falls back to being switched off, which no real browser is, and the
 * timezone stays on the persona's default while the address says otherwise.
 */
export async function lookupDirectGeo(timeoutMs = 10_000): Promise<ProxyGeo | null> {
  const start = Date.now()
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const req = http.get(GEO_API_URL, (res) => { readResponse(res).then(resolve, reject) })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('geo lookup timed out')))
      req.on('error', reject)
    })
    const geo = parseGeoOrThrow(data)
    geo.rttMs = Date.now() - start
    return geo
  } catch {
    return null
  }
}

/** HTTP(S)/SOCKS5/relay. Null on error; use `probeProxyExit` for the reason. */
export async function lookupProxyGeo(proxyUrl: string, timeoutMs = 10_000): Promise<ProxyGeo | null> {
  return (await probeProxyExit(proxyUrl, timeoutMs)).geo ?? null
}

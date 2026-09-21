import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { SocksClient } from 'socks'
import { relayFetch, relayKeyFromUrl } from './relay-tunnel'

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

const DEFAULT_GEO_SERVER = 'https://antibrow.com'
/** Our own endpoint gets a short leash so a slow edge cannot eat the whole
 *  budget and leave nothing for the fallback. */
const OWN_TARGET_TIMEOUT_MS = 4_000

/** One place a probe can ask "where did this connection come out?". */
export interface GeoTarget {
  /** Absolute URL, the form the relay header path needs. */
  url: string
  host: string
  port: number
  path: string
  /** Our own endpoint is HTTPS: the proxy operator would otherwise see the
   *  product's hostname in clear text, which ip-api never revealed. */
  tls: boolean
  kind: 'own' | 'ipapi'
}

const IPAPI_TARGET: GeoTarget = {
  url: GEO_API_URL, host: GEO_API_HOST, port: 80, path: GEO_API_PATH, tls: false, kind: 'ipapi',
}

/**
 * Ours first, ip-api behind it: a launch must not depend on our own uptime,
 * since a geo lookup that resolves to nothing cancels the launch outright.
 */
export function geoTargets(serverUrl?: string): GeoTarget[] {
  const base = serverUrl ?? process.env.ANTIBROW_GEO_SERVER ?? process.env.ANTIBROW_SERVER ?? DEFAULT_GEO_SERVER
  try {
    const u = new URL(`${base.replace(/\/+$/, '')}/api/v1/geo`)
    return [{
      url: u.toString(),
      host: u.hostname,
      port: parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10),
      path: `${u.pathname}${u.search}`,
      tls: u.protocol === 'https:',
      kind: 'own',
    }, IPAPI_TARGET]
  } catch {
    return [IPAPI_TARGET]
  }
}

/** Both endpoints, one shape. Throws with the reason so a caller can fall through. */
export function parseGeoBody(target: GeoTarget, data: string): ProxyGeo {
  return target.kind === 'own' ? parseOwnGeoOrThrow(data) : parseGeoOrThrow(data)
}

function parseOwnGeoOrThrow(data: string): ProxyGeo {
  let json: { ip?: string; country?: string; countryCode?: string; countryName?: string; city?: string; timezone?: string }
  try {
    json = JSON.parse(data)
  } catch {
    throw new Error(data.trim() ? `geo endpoint returned a non-JSON body: ${preview(data)}` : 'proxy returned an empty response')
  }
  // The edge answers 200 with nulls when it has no geo for the caller, and an
  // older deployment answers without an `ip` at all. Both have to fall through:
  // no timezone leaves the persona disagreeing with its exit, and no ip turns
  // WebRTC off, which no real browser is.
  if (!json.timezone) throw new Error('geo endpoint returned no timezone for this exit')
  if (!json.ip) throw new Error('geo endpoint returned no exit ip')
  return {
    ip: json.ip,
    country: json.countryName ?? '',
    countryCode: json.countryCode ?? json.country ?? '',
    city: json.city ?? '',
    timezone: json.timezone,
  }
}

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

function proxyCreds(parsed: URL): string | null {
  if (!parsed.username) return null
  const creds = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password ?? '')}`
  return Buffer.from(creds).toString('base64')
}

/** Speak HTTP/1.1 on an open tunnel, adding TLS when the target wants it. */
function requestOverSocket(sock: net.Socket, target: GeoTarget, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stream: net.Socket | tls.TLSSocket = sock
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.destroy()
      sock.destroy()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`proxy did not respond within ${timeoutMs}ms`))),
      timeoutMs,
    )
    const send = () => {
      let data = ''
      stream.on('data', (chunk: Buffer) => { data += chunk.toString() })
      stream.on('end', () => finish(() => {
        try { resolve(parseRawHttpResponse(data)) } catch (e) { reject(e instanceof Error ? e : new Error(String(e))) }
      }))
      stream.on('error', (e: Error) => finish(() => reject(e)))
      stream.write(
        `GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\n`
        + 'Accept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n',
      )
    }

    if (!target.tls) { send(); return }
    stream = tls.connect({ socket: sock, servername: target.host }, send)
    stream.on('error', (e: Error) => finish(() => reject(e)))
  })
}

/** HTTP(S) forward proxy, plaintext target: absolute-URL GET sent to the proxy itself. */
function lookupViaHttpProxy(parsed: URL, target: GeoTarget, timeoutMs: number): Promise<ProxyGeo> {
  if (target.tls) return lookupViaConnect(parsed, target, timeoutMs)

  const secure = parsed.protocol === 'https:'
  const port = parseInt(parsed.port || (secure ? '443' : '80'), 10)
  const headers: Record<string, string> = { Host: target.host }
  const creds = proxyCreds(parsed)
  if (creds) headers['Proxy-Authorization'] = `Basic ${creds}`

  return new Promise((resolve, reject) => {
    const mod = secure ? https : http
    const req = mod.request(
      // `agent: false`: a pooled socket left dead by the proxy would make the
      // next probe fail with "socket hang up".
      { host: parsed.hostname, port, path: target.url, method: 'GET', headers, agent: false },
      (res) => { readResponse(res).then((b) => parseGeoBody(target, b)).then(resolve, reject) },
    )
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`proxy did not respond within ${timeoutMs}ms`)) })
    req.on('error', reject)
    req.end()
  })
}

/** HTTP(S) forward proxy, TLS target: CONNECT tunnel, then TLS end to end. */
function lookupViaConnect(parsed: URL, target: GeoTarget, timeoutMs: number): Promise<ProxyGeo> {
  const secure = parsed.protocol === 'https:'
  const port = parseInt(parsed.port || (secure ? '443' : '80'), 10)
  const headers: Record<string, string> = { Host: `${target.host}:${target.port}` }
  const creds = proxyCreds(parsed)
  if (creds) headers['Proxy-Authorization'] = `Basic ${creds}`

  return new Promise((resolve, reject) => {
    const mod = secure ? https : http
    const req = mod.request({
      host: parsed.hostname, port, method: 'CONNECT',
      path: `${target.host}:${target.port}`, headers, agent: false,
    })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`proxy did not respond within ${timeoutMs}ms`)) })
    req.on('error', reject)
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy refused CONNECT with HTTP ${res.statusCode}${res.statusCode === 407 ? ' (proxy authentication failed)' : ''}`))
        return
      }
      requestOverSocket(socket, target, timeoutMs).then((b) => parseGeoBody(target, b)).then(resolve, reject)
    })
    req.end()
  })
}

/**
 * Relay proxies: target rides in `X-Proxy-Target`, the same path the browser
 * takes, so the exit IP matches. `node:https` because `fetch` drops auth.
 */
function lookupViaRelayHeader(parsed: URL, target: GeoTarget, timeoutMs: number): Promise<ProxyGeo> {
  const headers: Record<string, string> = {
    'Proxy-Authorization': `Basic ${proxyCreds(parsed) ?? ''}`,
    'X-Proxy-Target': target.url,
  }
  const port = parseInt(parsed.port || '443', 10)
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: parsed.hostname, port, path: '/', method: 'GET', headers, agent: false },
      (res) => { readResponse(res).then((b) => parseGeoBody(target, b)).then(resolve, reject) },
    )
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`relay did not respond within ${timeoutMs}ms`)) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Self-hosted relays carrying a key: probe through the encrypted tunnel the
 * browser itself will use. The header path above is the legacy protocol, which
 * a relay only serves with plaintext mode switched on - probing over it would
 * make every self-hosted deployment choose between an exit-matched timezone and
 * putting hostnames in clear text.
 *
 * The tunnel writes the HTTP request itself, so it can only carry a plaintext
 * target; a TLS one is skipped rather than sent in clear.
 */
async function lookupViaRelayTunnel(parsed: URL, key: Uint8Array, target: GeoTarget, timeoutMs: number): Promise<ProxyGeo> {
  if (target.tls) throw new Error('the relay tunnel cannot carry an HTTPS geo target')
  const body = await relayFetch({
    relay: parsed, key, host: target.host, port: target.port, path: target.path, timeoutMs,
  })
  return parseGeoBody(target, body)
}

/** SOCKS5: CONNECT to the geo endpoint and speak HTTP/1.1 on the raw tunnel. */
function lookupViaSocks5(parsed: URL, target: GeoTarget, timeoutMs: number): Promise<ProxyGeo> {
  return SocksClient.createConnection({
    proxy: {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10),
      type: 5,
      userId: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    },
    command: 'connect',
    destination: { host: target.host, port: target.port },
    timeout: timeoutMs,
  }).then(({ socket }) => requestOverSocket(socket, target, timeoutMs))
    .then((b) => parseGeoBody(target, b))
}

/** Injectable for tests; production always uses the per-scheme lookups above. */
export interface ProbeOptions {
  serverUrl?: string
  lookup?: (proxy: URL, target: GeoTarget, timeoutMs: number) => Promise<ProxyGeo>
}

/**
 * Always goes through the proxy: a hostname fallback answers just as confidently
 * for a dead proxy, which is how a broken one looks healthy.
 */
export async function probeProxyExit(proxyUrl: string, timeoutMs = 10_000, opts: ProbeOptions = {}): Promise<ProxyProbeResult> {
  const start = Date.now()
  const fail = (msg: string): ProxyProbeResult => ({ ok: false, error: msg, latencyMs: Date.now() - start })

  let parsed: URL
  try {
    parsed = new URL(proxyUrl)
  } catch {
    return fail(`invalid proxy url: ${proxyUrl}`)
  }

  const scheme = parsed.protocol.replace(':', '')
  let relayKey: Uint8Array | null = null
  if (scheme === 'relay') {
    try {
      relayKey = relayKeyFromUrl(parsed)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
  const bySchema =
    relayKey ? (u: URL, t: GeoTarget, ms: number) => lookupViaRelayTunnel(u, relayKey!, t, ms)
      : scheme === 'relay' ? lookupViaRelayHeader
        : scheme === 'socks5' || scheme === 'socks' ? lookupViaSocks5
          : scheme === 'http' || scheme === 'https' ? lookupViaHttpProxy
            : null
  // Checked before the injected lookup takes over, so a test double cannot make
  // an unsupported scheme look probeable.
  if (!bySchema) return fail(`unsupported proxy scheme: ${scheme}`)
  const lookup = opts.lookup ?? bySchema

  let lastError = 'no geo target answered'
  for (const target of geoTargets(opts.serverUrl)) {
    const budget = target.kind === 'own'
      ? Math.min(timeoutMs, OWN_TARGET_TIMEOUT_MS)
      : Math.max(1_000, timeoutMs - (Date.now() - start))
    try {
      const geo = await lookup(parsed, target, budget)
      const latencyMs = Date.now() - start
      // Includes DNS, connect and TLS, so it overestimates Chrome's http_rtt -
      // deliberately not compensated: erring slow only ever yields a slower
      // effectiveType, which is still a self-consistent trio.
      if (geo) geo.rttMs = latencyMs
      return { ok: true, geo, latencyMs }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return fail(lastError)
}

/**
 * This machine's own exit, for launches with no proxy. The kernel leaves the
 * host IP alone there, so the persona has to agree with it: without a public IP
 * WebRTC falls back to being switched off, which no real browser is, and the
 * timezone stays on the persona's default while the address says otherwise.
 */
export async function lookupDirectGeo(timeoutMs = 10_000, serverUrl?: string): Promise<ProxyGeo | null> {
  const start = Date.now()
  for (const target of geoTargets(serverUrl)) {
    const budget = target.kind === 'own'
      ? Math.min(timeoutMs, OWN_TARGET_TIMEOUT_MS)
      : Math.max(1_000, timeoutMs - (Date.now() - start))
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const mod = target.tls ? https : http
        const req = mod.get(target.url, (res) => { readResponse(res).then(resolve, reject) })
        req.setTimeout(budget, () => req.destroy(new Error('geo lookup timed out')))
        req.on('error', reject)
      })
      const geo = parseGeoBody(target, data)
      geo.rttMs = Date.now() - start
      return geo
    } catch { /* try the next target */ }
  }
  return null
}

/** HTTP(S)/SOCKS5/relay. Null on error; use `probeProxyExit` for the reason. */
export async function lookupProxyGeo(proxyUrl: string, timeoutMs = 10_000, serverUrl?: string): Promise<ProxyGeo | null> {
  return (await probeProxyExit(proxyUrl, timeoutMs, { serverUrl })).geo ?? null
}

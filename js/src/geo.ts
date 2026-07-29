import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

export interface GeoInfo {
  timezone: string
  countryCode: string
  locale: string
  languages: string
}

/**
 * Look up the geolocation of a proxy's exit IP: through the proxy when possible,
 * otherwise by the proxy hostname.
 *
 * Best-effort, and not a reachability test: a socks5:// url falls through to the
 * hostname lookup, which answers just as confidently for a dead proxy. Use
 * `probeProxyExit` for anything a user reads as "this proxy is up".
 */
export async function lookupProxyGeo(proxyUrl: string, serverUrl?: string): Promise<GeoInfo | null> {
  const proxy = new URL(proxyUrl)

  // Managed `relay://` proxies: the relay host is the endpoint and the real
  // target rides in a header, the same route the browser takes, so the exit IP
  // matches. No hostname fallback here: it would locate the relay, not the exit.
  if (proxy.protocol === 'relay:') {
    const body = await cfRelayGet(proxy, IPAPI_URL).catch(() => null)
    return body ? parseIpApiGeo(body) : null
  }

  const isHttpProxy = proxy.protocol === 'http:' || proxy.protocol === 'https:'

  // Primary: our own endpoint through a CONNECT tunnel.
  if (serverUrl && isHttpProxy) {
    const body = await connectTunnel(proxy, geoEndpoint(serverUrl)).catch(() => null)
    if (body) {
      const geo = parseServerGeo(body)
      if (geo) return geo
    }
  }

  // Fallback: a plain HTTP target through the forward proxy.
  if (isHttpProxy) {
    const body = await httpForwardProxy(proxy, IPAPI_URL).catch(() => null)
    if (body) {
      const geo = parseIpApiGeo(body)
      if (geo) return geo
    }
  }

  // Last resort: look up the proxy hostname itself.
  const body = await directLookup(proxy.hostname).catch(() => null)
  if (body) {
    const geo = parseIpApiGeo(body)
    if (geo) return geo
  }

  return null
}

/** Normalised `<serverUrl>/api/v1/geo`. */
function geoEndpoint(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/api/v1/geo`
}

/**
 * Geolocation of the current connection, used when a profile has no proxy so the
 * browser's language and timezone still match the real exit IP.
 */
export async function lookupCurrentGeo(serverUrl?: string): Promise<GeoInfo | null> {
  if (serverUrl) {
    try {
      const res = await fetch(geoEndpoint(serverUrl), { signal: AbortSignal.timeout(TIMEOUT) })
      if (res.ok) {
        const geo = parseServerGeo(await res.text())
        if (geo) return geo
      }
    } catch { /* fall through to ip-api */ }
  }
  try {
    const res = await fetch(IPAPI_URL, { signal: AbortSignal.timeout(TIMEOUT) })
    if (res.ok) {
      const geo = parseIpApiGeo(await res.text())
      if (geo) return geo
    }
  } catch { /* give up */ }
  return null
}


const IPAPI_URL = 'http://ip-api.com/json/?fields=status,countryCode,timezone'
const TIMEOUT = 5000

/** CONNECT tunnel through an HTTP proxy, then TLS and a raw GET. */
function connectTunnel(proxy: URL, targetUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl)
    const targetHost = target.hostname
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80')

    const headers: Record<string, string> = {}
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`
    }

    const connectReq = http.request({
      hostname: proxy.hostname,
      port: parseInt(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
    })

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`CONNECT ${res.statusCode}`))
        return
      }

      if (target.protocol === 'https:') {
        const tlsSock = tls.connect({ host: targetHost, socket, servername: targetHost }, () => {
          sendHttpGet(tlsSock, target, resolve, reject)
        })
        tlsSock.on('error', (err) => { tlsSock.destroy(); reject(err) })
      } else {
        sendHttpGet(socket, target, resolve, reject)
      }
    })

    connectReq.on('error', reject)
    connectReq.setTimeout(TIMEOUT, () => { connectReq.destroy(); reject(new Error('timeout')) })
    connectReq.end()
  })
}


function sendHttpGet(
  sock: import('node:net').Socket | tls.TLSSocket,
  target: URL,
  resolve: (body: string) => void,
  reject: (err: Error) => void,
) {
  sock.write(
    `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
    `Host: ${target.hostname}\r\n` +
    `Connection: close\r\n\r\n`,
  )

  let data = ''
  sock.on('data', (chunk: Buffer) => { data += chunk.toString() })
  sock.on('end', () => {

    const idx = data.indexOf('\r\n\r\n')
    const body = idx >= 0 ? data.slice(idx + 4) : data

    resolve(stripChunked(body))
  })
  sock.on('error', reject)
}

/** Naive chunked-encoding strip: single-chunk responses only. */
function stripChunked(body: string): string {

  const match = body.match(/^([0-9a-fA-F]+)\r\n/)
  if (match) {
    const size = parseInt(match[1], 16)
    if (size > 0) {
      return body.slice(match[0].length, match[0].length + size)
    }
  }
  return body
}

/** HTTP forward proxy: absolute-URL GET, HTTP targets only. */
function httpForwardProxy(proxy: URL, targetUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl)
    const headers: http.OutgoingHttpHeaders = { Host: target.host }

    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`
    }

    const req = http.request(
      {
        hostname: proxy.hostname,
        port: parseInt(proxy.port) || 80,
        path: targetUrl,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve(body))
      },
    )

    req.on('error', reject)
    req.setTimeout(TIMEOUT, () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

/**
 * GET a target through a `relay://` proxy, with the target in a header. Uses
 * `node:https` because `fetch` drops `Proxy-Authorization`.
 */
function cfRelayGet(proxy: URL, targetUrl: string): Promise<string> {
  const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: proxy.hostname,
        port: proxy.port ? parseInt(proxy.port) : 443,
        path: '/',
        method: 'GET',
        headers: {
          'Proxy-Authorization': `Basic ${Buffer.from(cred).toString('base64')}`,
          'X-Proxy-Target': targetUrl,
        },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve(body))
      },
    )
    req.on('error', reject)
    req.setTimeout(TIMEOUT, () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

/** Query the geo API directly for a hostname or IP. */
async function directLookup(hostname: string): Promise<string> {
  const res = await fetch(
    `http://ip-api.com/json/${encodeURIComponent(hostname)}?fields=status,countryCode,timezone`,
    { signal: AbortSignal.timeout(TIMEOUT) },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}


function parseServerGeo(body: string): GeoInfo | null {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const cc = data.country
    const tz = data.timezone
    if (typeof cc !== 'string' || typeof tz !== 'string') return null
    return buildGeoInfo(cc, tz)
  } catch {
    return null
  }
}


function parseIpApiGeo(body: string): GeoInfo | null {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    if (data.status !== 'success') return null
    const cc = data.countryCode
    const tz = data.timezone
    if (typeof cc !== 'string' || typeof tz !== 'string') return null
    return buildGeoInfo(cc, tz)
  } catch {
    return null
  }
}

function buildGeoInfo(countryCode: string, timezone: string): GeoInfo {
  const entry = COUNTRY_LOCALE[countryCode]
  return {
    timezone,
    countryCode,
    locale: entry ? entry[0] : 'en-US',
    languages: entry ? entry[1] : 'en-US,en;q=0.9',
  }
}

// Country code -> [locale, accept-language]

const COUNTRY_LOCALE: Record<string, [string, string]> = {
  // English
  US: ['en-US', 'en-US,en;q=0.9'],
  GB: ['en-GB', 'en-GB,en;q=0.9'],
  AU: ['en-AU', 'en-AU,en;q=0.9'],
  CA: ['en-CA', 'en-CA,en;q=0.9,fr;q=0.8'],
  NZ: ['en-NZ', 'en-NZ,en;q=0.9'],
  IE: ['en-IE', 'en-IE,en;q=0.9'],
  ZA: ['en-ZA', 'en-ZA,en;q=0.9'],
  IN: ['en-IN', 'en-IN,en;q=0.9,hi;q=0.8'],
  SG: ['en-SG', 'en-SG,en;q=0.9,zh;q=0.8'],
  PH: ['en-PH', 'en-PH,en;q=0.9'],
  NG: ['en-NG', 'en-NG,en;q=0.9'],
  KE: ['en-KE', 'en-KE,en;q=0.9'],
  GH: ['en-GH', 'en-GH,en;q=0.9'],

  // German
  DE: ['de-DE', 'de-DE,de;q=0.9,en;q=0.8'],
  AT: ['de-AT', 'de-AT,de;q=0.9,en;q=0.8'],
  CH: ['de-CH', 'de-CH,de;q=0.9,fr;q=0.8,en;q=0.7'],

  // French
  FR: ['fr-FR', 'fr-FR,fr;q=0.9,en;q=0.8'],
  BE: ['fr-BE', 'fr-BE,fr;q=0.9,nl;q=0.8,en;q=0.7'],
  LU: ['fr-LU', 'fr-LU,fr;q=0.9,de;q=0.8,en;q=0.7'],

  // Spanish
  ES: ['es-ES', 'es-ES,es;q=0.9,en;q=0.8'],
  MX: ['es-MX', 'es-MX,es;q=0.9,en;q=0.8'],
  AR: ['es-AR', 'es-AR,es;q=0.9,en;q=0.8'],
  CO: ['es-CO', 'es-CO,es;q=0.9,en;q=0.8'],
  CL: ['es-CL', 'es-CL,es;q=0.9,en;q=0.8'],
  PE: ['es-PE', 'es-PE,es;q=0.9,en;q=0.8'],
  VE: ['es-VE', 'es-VE,es;q=0.9,en;q=0.8'],
  EC: ['es-EC', 'es-EC,es;q=0.9,en;q=0.8'],
  UY: ['es-UY', 'es-UY,es;q=0.9,en;q=0.8'],
  PY: ['es-PY', 'es-PY,es;q=0.9,en;q=0.8'],
  BO: ['es-BO', 'es-BO,es;q=0.9,en;q=0.8'],
  CR: ['es-CR', 'es-CR,es;q=0.9,en;q=0.8'],
  PA: ['es-PA', 'es-PA,es;q=0.9,en;q=0.8'],
  DO: ['es-DO', 'es-DO,es;q=0.9,en;q=0.8'],
  GT: ['es-GT', 'es-GT,es;q=0.9,en;q=0.8'],
  CU: ['es-CU', 'es-CU,es;q=0.9,en;q=0.8'],
  HN: ['es-HN', 'es-HN,es;q=0.9,en;q=0.8'],
  SV: ['es-SV', 'es-SV,es;q=0.9,en;q=0.8'],
  NI: ['es-NI', 'es-NI,es;q=0.9,en;q=0.8'],
  PR: ['es-PR', 'es-PR,es;q=0.9,en;q=0.8'],

  // Portuguese
  PT: ['pt-PT', 'pt-PT,pt;q=0.9,en;q=0.8'],
  BR: ['pt-BR', 'pt-BR,pt;q=0.9,en;q=0.8'],

  // Italian
  IT: ['it-IT', 'it-IT,it;q=0.9,en;q=0.8'],

  // Dutch
  NL: ['nl-NL', 'nl-NL,nl;q=0.9,en;q=0.8'],

  // Russian / CIS
  RU: ['ru-RU', 'ru-RU,ru;q=0.9,en;q=0.8'],
  UA: ['uk-UA', 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7'],
  BY: ['ru-BY', 'ru-BY,ru;q=0.9,en;q=0.8'],
  KZ: ['ru-KZ', 'ru-KZ,kk;q=0.9,ru;q=0.8,en;q=0.7'],
  UZ: ['uz-UZ', 'uz-UZ,ru;q=0.9,en;q=0.8'],

  // Eastern Europe
  PL: ['pl-PL', 'pl-PL,pl;q=0.9,en;q=0.8'],
  CZ: ['cs-CZ', 'cs-CZ,cs;q=0.9,en;q=0.8'],
  SK: ['sk-SK', 'sk-SK,sk;q=0.9,en;q=0.8'],
  HU: ['hu-HU', 'hu-HU,hu;q=0.9,en;q=0.8'],
  RO: ['ro-RO', 'ro-RO,ro;q=0.9,en;q=0.8'],
  BG: ['bg-BG', 'bg-BG,bg;q=0.9,en;q=0.8'],
  HR: ['hr-HR', 'hr-HR,hr;q=0.9,en;q=0.8'],
  RS: ['sr-RS', 'sr-RS,sr;q=0.9,en;q=0.8'],
  SI: ['sl-SI', 'sl-SI,sl;q=0.9,en;q=0.8'],
  LT: ['lt-LT', 'lt-LT,lt;q=0.9,en;q=0.8'],
  LV: ['lv-LV', 'lv-LV,lv;q=0.9,en;q=0.8'],
  EE: ['et-EE', 'et-EE,et;q=0.9,en;q=0.8'],

  // Nordic
  SE: ['sv-SE', 'sv-SE,sv;q=0.9,en;q=0.8'],
  NO: ['nb-NO', 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7'],
  DK: ['da-DK', 'da-DK,da;q=0.9,en;q=0.8'],
  FI: ['fi-FI', 'fi-FI,fi;q=0.9,en;q=0.8'],
  IS: ['is-IS', 'is-IS,is;q=0.9,en;q=0.8'],

  // East Asia
  JP: ['ja-JP', 'ja-JP,ja;q=0.9,en;q=0.8'],
  KR: ['ko-KR', 'ko-KR,ko;q=0.9,en;q=0.8'],
  CN: ['zh-CN', 'zh-CN,zh;q=0.9,en;q=0.8'],
  TW: ['zh-TW', 'zh-TW,zh;q=0.9,en;q=0.8'],
  HK: ['zh-HK', 'zh-HK,zh;q=0.9,en;q=0.8'],
  MO: ['zh-MO', 'zh-MO,zh;q=0.9,en;q=0.8'],
  MN: ['mn-MN', 'mn-MN,mn;q=0.9,en;q=0.8'],

  // Southeast Asia
  TH: ['th-TH', 'th-TH,th;q=0.9,en;q=0.8'],
  VN: ['vi-VN', 'vi-VN,vi;q=0.9,en;q=0.8'],
  ID: ['id-ID', 'id-ID,id;q=0.9,en;q=0.8'],
  MY: ['ms-MY', 'ms-MY,ms;q=0.9,en;q=0.8'],
  MM: ['my-MM', 'my-MM,my;q=0.9,en;q=0.8'],
  KH: ['km-KH', 'km-KH,km;q=0.9,en;q=0.8'],
  LA: ['lo-LA', 'lo-LA,lo;q=0.9,en;q=0.8'],

  // Middle East
  TR: ['tr-TR', 'tr-TR,tr;q=0.9,en;q=0.8'],
  SA: ['ar-SA', 'ar-SA,ar;q=0.9,en;q=0.8'],
  AE: ['ar-AE', 'ar-AE,ar;q=0.9,en;q=0.8'],
  EG: ['ar-EG', 'ar-EG,ar;q=0.9,en;q=0.8'],
  IQ: ['ar-IQ', 'ar-IQ,ar;q=0.9,en;q=0.8'],
  JO: ['ar-JO', 'ar-JO,ar;q=0.9,en;q=0.8'],
  KW: ['ar-KW', 'ar-KW,ar;q=0.9,en;q=0.8'],
  QA: ['ar-QA', 'ar-QA,ar;q=0.9,en;q=0.8'],
  BH: ['ar-BH', 'ar-BH,ar;q=0.9,en;q=0.8'],
  OM: ['ar-OM', 'ar-OM,ar;q=0.9,en;q=0.8'],
  LB: ['ar-LB', 'ar-LB,ar;q=0.9,fr;q=0.8,en;q=0.7'],
  IL: ['he-IL', 'he-IL,he;q=0.9,en;q=0.8'],
  IR: ['fa-IR', 'fa-IR,fa;q=0.9,en;q=0.8'],
  PK: ['ur-PK', 'ur-PK,ur;q=0.9,en;q=0.8'],
  BD: ['bn-BD', 'bn-BD,bn;q=0.9,en;q=0.8'],
  LK: ['si-LK', 'si-LK,si;q=0.9,en;q=0.8'],
  NP: ['ne-NP', 'ne-NP,ne;q=0.9,en;q=0.8'],

  // Other
  GR: ['el-GR', 'el-GR,el;q=0.9,en;q=0.8'],
  CY: ['el-CY', 'el-CY,el;q=0.9,en;q=0.8'],
  GE: ['ka-GE', 'ka-GE,ka;q=0.9,en;q=0.8'],
  AM: ['hy-AM', 'hy-AM,hy;q=0.9,en;q=0.8'],
  AZ: ['az-AZ', 'az-AZ,az;q=0.9,en;q=0.8'],

  // North Africa
  MA: ['ar-MA', 'ar-MA,ar;q=0.9,fr;q=0.8,en;q=0.7'],
  DZ: ['ar-DZ', 'ar-DZ,ar;q=0.9,fr;q=0.8,en;q=0.7'],
  TN: ['ar-TN', 'ar-TN,ar;q=0.9,fr;q=0.8,en;q=0.7'],
  LY: ['ar-LY', 'ar-LY,ar;q=0.9,en;q=0.8'],
}

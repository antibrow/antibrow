import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { SocksClient } from 'socks'
import { personaToFpConfig, API_LOG_FILE, type FpConfigSettings, type Persona } from './persona'
import { writeWindowIcon } from './icon'
import { readProfileMeta } from './profile-dir'

/** Portable passkey store, kept at the profile root so exports carry it. */
export const PASSKEYS_FILE = 'passkeys.json'

const PRODUCT_NAME = 'antibrow'

export interface KernelLaunchOptions extends Omit<FpConfigSettings, 'apiLogPath'> {
  exePath: string
  profileDir: string
  persona: Persona
  timezone: string
  publicIp?: string
  proxyUrl?: string
  /** Signed license token. */
  licenseToken: string
  /** Per-profile encryption key, when this profile was created under one. */
  cryptKey?: string
  /** Window/address label. Defaults to the profile directory basename. */
  label?: string
  headless?: boolean
  focusWindow?: boolean
  localeFromConfig?: boolean
  /**
   * Whether newly registered passkeys go into this profile's portable store.
   * Absent/true = capture. false lets Chrome's own "where to save" dialog
   * through, so those credentials stay outside the profile.
   */
  webauthnCapture?: boolean
  /** Reopen the previous session's tabs. Default true. */
  restoreTabs?: boolean
  onProgress?: (message: string) => void
}

export interface ExitLatch {
  hasExited(): boolean
  onExit(cb: () => void): void
}

/**
 * `child.once('exit')` registered after the process already died never fires,
 * and everything hanging off it stalls: the desktop keeps the profile marked as
 * running and the archive upload that exit was supposed to trigger never runs,
 * so the next machine restores a stale copy. Latch the exit at spawn time and
 * replay it to whoever subscribes later.
 */
export function exitLatch(child: { once(event: 'exit', cb: () => void): unknown }): ExitLatch {
  let exited = false
  const waiting: Array<() => void> = []
  child.once('exit', () => {
    exited = true
    for (const cb of waiting.splice(0)) cb()
  })
  return {
    hasExited: () => exited,
    onExit(cb) {
      if (exited) queueMicrotask(cb)
      else waiting.push(cb)
    },
  }
}

/**
 * Ask the browser to shut itself down, and only kill it if it will not. A
 * SIGKILL'd Chromium flushes nothing: cookies written late are lost, the session
 * files stay half-written and `exit_type` is left at "Crashed" -- and for a
 * synced profile that torn directory is exactly what gets uploaded next.
 */
export async function shutdownKernel(opts: {
  requestClose: () => Promise<void>
  hasExited: () => boolean
  kill: () => void | Promise<void>
  graceMs?: number
  pollMs?: number
}): Promise<'graceful' | 'killed'> {
  const graceMs = opts.graceMs ?? 15_000
  const pollMs = opts.pollMs ?? 100
  const deadline = Date.now() + graceMs
  // requestClose (Browser.close over CDP) can hang forever if the browser wedges
  // mid-shutdown while its websocket stays open. Fire and forget rather than
  // await: the poll loop below is what actually bounds this call, not the
  // request itself.
  void Promise.resolve().then(() => opts.requestClose()).catch(() => {})
  while (!opts.hasExited() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
  }
  if (opts.hasExited()) return 'graceful'
  await opts.kill()
  return 'killed'
}

export interface KernelSession {
  context: BrowserContext
  wsEndpoint: string
  profileDir: string
  onExit(cb: () => void): void
  close(): Promise<void>
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function waitForDevToolsPort(
  child: ChildProcessWithoutNullStreams,
  cdpPort: number,
  timeoutMs: number,
  getDiag: () => string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false

    const done = (err: Error | undefined, endpoint?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      if (err) reject(err)
      else {
        onProgress?.(`CDP endpoint ready ${endpoint}`)
        resolve(endpoint!)
      }
    }

    // No DevToolsActivePort file is written, so readiness must be polled.
    const tryHttp = () => {
      const req = http.get(
        `http://127.0.0.1:${cdpPort}/json/version`,
        (res) => {
          let body = ''
          res.on('data', (chunk: string) => { body += chunk })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { webSocketDebuggerUrl?: string }
              const ws = parsed.webSocketDebuggerUrl ?? `ws://127.0.0.1:${cdpPort}`
              done(undefined, ws)
            } catch {
              // not ready yet
            }
          })
        },
      )
      req.on('error', () => {})
      req.setTimeout(500, () => { req.destroy() })
    }

    const timer = setTimeout(() => {
      const diag = getDiag().trim()
      done(new Error(`Timed out waiting for CDP endpoint on port ${cdpPort}.${diag ? `\nKernel output:\n${diag}` : ''}`))
    }, timeoutMs)
    const poll = setInterval(tryHttp, 200)

    child.once('error', (err) => done(err))
    child.once('exit', (code, signal) => {
      const diag = getDiag().trim()
      done(new Error(
        `Browser exited before CDP ready (code=${code ?? 'null'}, signal=${signal ?? 'null'}).` +
        (diag ? `\nKernel output:\n${diag}` : ''),
      ))
    })

    tryHttp()
  })
}

function writeProxyAuthExtension(profileDir: string, username: string, password: string): string {
  const extDir = path.join(profileDir, 'proxy-auth-ext')
  fs.mkdirSync(extDir, { recursive: true })

  const manifest = {
    name: 'Proxy Auth',
    version: '1.0.0',
    manifest_version: 3,
    permissions: ['webRequest', 'webRequestAuthProvider'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'background.js' },
  }
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const userJs = JSON.stringify(username)
  const passJs = JSON.stringify(password)
  const bg = [
    `const USERNAME = ${userJs};`,
    `const PASSWORD = ${passJs};`,
    'chrome.webRequest.onAuthRequired.addListener(',
    '  (details, callback) => {',
    '    if (!details.isProxy) { callback({}); return; }',
    '    callback({ authCredentials: { username: USERNAME, password: PASSWORD } });',
    '  },',
    "  { urls: ['<all_urls>'] },",
    "  ['asyncBlocking']",
    ');',
  ].join('\n')
  fs.writeFileSync(path.join(extDir, 'background.js'), bg)

  return extDir
}

/** Local HTTP CONNECT proxy that tunnels through an authenticated SOCKS5 proxy. */
function startSocks5LocalProxy(
  socksHost: string,
  socksPort: number,
  socksUser: string,
  socksPass: string,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()

    server.on('connect', (req, clientSocket, head) => {
      const [targetHost, targetPortStr] = (req.url ?? '').split(':')
      const targetPort = parseInt(targetPortStr ?? '443', 10)

      SocksClient.createConnection({
        proxy: {
          host: socksHost,
          port: socksPort,
          type: 5,
          userId: socksUser,
          password: socksPass,
        },
        command: 'connect',
        destination: { host: targetHost, port: targetPort },
      }).then(({ socket }) => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) socket.write(head)
        socket.pipe(clientSocket)
        clientSocket.pipe(socket)
        socket.on('error', () => clientSocket.destroy())
        clientSocket.on('error', () => socket.destroy())
      }).catch(() => {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        clientSocket.destroy()
      })
    })

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      const targetPort = url.port ? parseInt(url.port) : 80

      SocksClient.createConnection({
        proxy: {
          host: socksHost,
          port: socksPort,
          type: 5,
          userId: socksUser,
          password: socksPass,
        },
        command: 'connect',
        destination: { host: url.hostname, port: targetPort },
      }).then(({ socket }) => {
        const reqLine = `${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}\r\n`
        const headers = Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n')
        socket.write(`${reqLine}${headers}\r\n\r\n`)
        req.pipe(socket)
        socket.pipe(res)
        socket.on('error', () => res.destroy())
        res.on('error', () => socket.destroy())
      }).catch(() => {
        res.writeHead(502)
        res.end()
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      resolve({ port, close: () => server.close() })
    })
    server.on('error', reject)
  })
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
  } else {
    // The child leads its own process group, so -pid kills every sub-process.
    try { process.kill(-pid, 'SIGKILL') } catch {}
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

function killByUserDataDir(profileDir: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  const udd = path.resolve(profileDir).replace(/\\/g, '/').toLowerCase()
  const script = [
    '$udd = $env:FP_KILL_UDD',
    'for ($i = 0; $i -lt 2; $i++) {',
    '  $procs = Get-CimInstance Win32_Process | Where-Object {',
    '    $_.CommandLine -and $_.CommandLine.Replace([char]92,[char]47).ToLower().Contains($udd)',
    '  }',
    '  if (-not $procs) { break }',
    '  $procs | ForEach-Object { cmd /c "taskkill /pid $($_.ProcessId) /T /F" 2>$null | Out-Null }',
    '  Start-Sleep -Milliseconds 400',
    '}',
  ].join('\n')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, FP_KILL_UDD: udd } },
      () => resolve(),
    )
  })
}

export interface BuildLaunchArgsOptions {
  fpConfigPath: string
  licenseToken: string
  /** Per-profile encryption key. Whether it belongs on this launch is decided
   *  by the profile directory (see resolveCryptKey), never here. */
  cryptKey?: string
  userDataDir: string
  displayLabel: string
  cdpPort: number
  language: string
  headless?: boolean
  /** Whether the new window takes focus. Default true. */
  focusWindow?: boolean
  /** True when the kernel reads the macOS app locale from fp-config, which
   *  retires the -AppleLanguages pair and the stray tab it opens. */
  localeFromConfig?: boolean
  profileDir: string
  webauthnCapture?: boolean
  /** Reopen the tabs of the previous session. Default true. */
  restoreTabs?: boolean
  /**
   * Explicit rather than read from `process.platform` so the linux/windows
   * branches stay testable from either OS.
   */
  platform: NodeJS.Platform
  /** Android profiles only: match the window to the persona's screen so
   *  innerWidth never exceeds the screen.width we report. */
  androidScreen?: { width: number; height: number }
}

/**
 * Assemble the kernel command line (without the executable itself). Pure and
 * platform-parametrized so the linux/windows/darwin branches can be asserted
 * on directly instead of by grepping the source.
 */
export function buildLaunchArgs(opts: BuildLaunchArgsOptions): string[] {
  const isWin = opts.platform === 'win32'
  const isLinux = opts.platform === 'linux'

  const args = [
    `--fp-config=${opts.fpConfigPath}`,
    `--fp-license=${opts.licenseToken}`,
    `--user-data-dir=${opts.userDataDir}`,
    `--fp-address-label=${opts.displayLabel}`,
    // Renames the browser in chrome://version and the About page. Measured as
    // invisible to pages: with and without it, navigator, the high-entropy UA
    // hints and the Sec-CH-UA headers are byte-identical. Kernels that predate
    // the flag ignore it.
    `--fp-product-name=${PRODUCT_NAME}`,
    `--remote-debugging-port=${opts.cdpPort}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    `--lang=${opts.language}`,
    // Device-bound session credentials sign a site's short-lived auth cookies
    // with a key the OS keeps unexportable (Secure Enclave / TPM). A profile
    // that carries a bound session is refused the moment it opens elsewhere,
    // which is why Gmail came up signed out on a second machine while GitHub,
    // which does not use DBSC, stayed signed in. Off, Google issues ordinary
    // cookies and those travel with the profile.
    '--disable-features=DeviceBoundSessions',
    // Bring the previous tabs back. Chromium's default startup is the new tab
    // page and only a crashed exit offers restore, so without this whether the
    // tabs return depends on how the last session happened to die.
    ...(opts.restoreTabs === false ? [] : ['--restore-last-session', '--hide-crash-restore-bubble']),
    // Linux/Docker: no user namespace, /dev/shm capped at 64 MB, no real GPU.
    // --no-zygote avoids a startup abort in the Linux builds. macOS needs none
    // of this and would only lose its sandbox.
    ...(isLinux ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-software-rasterizer',
        '--disable-crash-reporter',
        '--no-zygote'] : []),
    // Windows headless: move the window off-screen rather than --headless=new,
    // which is detectable. The size is deliberately left alone - shrinking the
    // window shrinks the viewport with it (a desktop fp-config does not spoof
    // outerWidth), which breaks page layout and contradicts the spoofed screen.
    ...(isWin && opts.headless ? ['--window-position=-10000,-10000'] : []),
    // Explicit false only: an unset option must not change how a launch has
    // always behaved. Kernel builds without the switch ignore it, so this stays
    // safe on an older install.
    ...(opts.focusWindow === false ? ['--fp-no-activate'] : []),
    // Android keeps its window sized to the persona screen even when hidden:
    // innerWidth === screen.width is part of the phone's identity, and being
    // off-screen does not change what the page measures.
    ...(opts.androidScreen
      ? [`--window-size=${opts.androidScreen.width},${opts.androidScreen.height}`]
      : []),
    // macOS ICU resolves Intl.* from CFLocale/AppleLanguages and silently
    // ignores --lang and LANG/LC_ALL, so this NSUserDefaults pair is the only
    // way to steer it. Meaningless on Windows/Linux.
    //
    // The `(xx-XX)` half has no leading dash, so Chromium's own parser takes it
    // for a positional arg and opens it as a URL (`http://(en-us)/`) in a stray
    // tab; closeStrayLocaleTab() gets rid of it after connecting, at the cost of
    // it being briefly visible.
    //
    // `--no-startup-window` would stop that tab from ever existing, and it was
    // tried: it also defers session restore, so Chromium restores the profile's
    // previous tabs into a window of its own beside the one created over CDP and
    // every existing profile opens with two windows. Not worth trading for a
    // flash. Kernels carrying the mac-locale patch read the locale from fp-config
    // and retire the pair entirely.
    ...(opts.platform === 'darwin' && !opts.localeFromConfig
      ? ['-AppleLanguages', `(${opts.language})`]
      : []),
  ]

  // Cookies and saved passwords are encrypted under this key, which never
  // touches the profile directory; the kernel keeps only a verifier there.
  if (opts.cryptKey) args.push(`--fp-crypt-key=${opts.cryptKey}`)

  args.push(`--fp-webauthn-store=${path.join(opts.profileDir, PASSKEYS_FILE)}`)
  if (opts.webauthnCapture === false) args.push('--fp-webauthn-create=choose')

  return args
}

/**
 * True for the tab Chromium opens because of the `-AppleLanguages (xx-XX)` pair
 * (see buildLaunchArgs). Chromium's URL fixup turns the bare `(en-US)` argument
 * into `http://(en-us)/`, so match that shape as well as the raw argument.
 */
export function isStrayLocaleTabUrl(url: string, language: string): boolean {
  let decoded = url
  try {
    decoded = decodeURIComponent(url)
  } catch {
    // Keep the raw URL: a malformed escape is not our tab anyway.
  }
  const lang = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^(?:https?://)?\\(${lang}\\)/?$`, 'i').test(decoded.trim())
}

/**
 * `(en-us)` is not a resolvable host, so by the time we look the tab has usually
 * committed an error page and `page.url()` reads `chrome-error://chromewebdata/`
 * -- the address bar still shows `(en-us)`, but the document URL no longer does.
 * Ask the navigation history what that tab was actually trying to load.
 */
async function isStrayLocalePage(context: BrowserContext, page: Page, language: string): Promise<boolean> {
  const url = page.url()
  if (isStrayLocaleTabUrl(url, language)) return true
  if (!url.startsWith('chrome-error:')) return false
  try {
    const cdp = await context.newCDPSession(page)
    try {
      const history = (await cdp.send('Page.getNavigationHistory')) as {
        entries?: Array<{ url?: string; userTypedURL?: string }>
      }
      return (history.entries ?? []).some(
        (e) => isStrayLocaleTabUrl(e.url ?? '', language) || isStrayLocaleTabUrl(e.userTypedURL ?? '', language),
      )
    } finally {
      await cdp.detach().catch(() => {})
    }
  } catch {
    return false
  }
}

/**
 * Open the first page when the kernel handed over none. Normally a no-op -- the
 * kernel's own startup window provides it -- but callers expect a page to exist
 * as soon as a session is handed over, so cover the zero-page case (e.g. extra
 * args suppressing the startup window).
 */
export async function ensureStartupPage(context: BrowserContext): Promise<void> {
  if (context.pages().length > 0) return
  // A real failure surfaces on the caller's own newPage(); never fail a launch
  // over the courtesy tab.
  await context.newPage().catch(() => {})
}

/**
 * Get rid of that tab. On darwin it is always there, so the short poll is worth
 * it: the startup navigation may not have committed when CDP starts answering,
 * and `page.url()` would still read `about:blank`.
 */
async function closeStrayLocaleTab(context: BrowserContext, language: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pages = context.pages()
    const flags = await Promise.all(pages.map((p) => isStrayLocalePage(context, p, language)))
    const stray = pages.filter((_, i) => flags[i])
    if (stray.length) {
      // Something has to stay open: closing the last tab takes the window --
      // and with it the kernel -- down.
      if (stray.length === pages.length) await context.newPage()
      for (const p of stray) await p.close().catch(() => {})
      return
    }
    if (Date.now() >= deadline) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * Address-bar label for a profile directory. The basename used to BE the
 * profile name; it is an opaque id now, so it is the last resort. `label` is
 * checked truthily on purpose: an empty string is not a usable label, and
 * openProfile's `??` passes one straight through.
 */
export function resolveDisplayLabel(profileDir: string, label?: string): string {
  return label || readProfileMeta(profileDir)?.name || path.basename(profileDir)
}

/** Launch the kernel with the given persona and connect Playwright over CDP. */
export async function launchKernel(opts: KernelLaunchOptions): Promise<KernelSession> {
  const { exePath, profileDir, persona, timezone, publicIp, proxyUrl, licenseToken, onProgress } = opts

  const userDataDir = path.join(profileDir, 'user-data')
  fs.mkdirSync(userDataDir, { recursive: true })

  const displayLabel = resolveDisplayLabel(profileDir, opts.label)

  const fpConfig = personaToFpConfig(persona, {
    label: displayLabel,
    timezone,
    publicIp,
    canvasNoise: opts.canvasNoise,
    apiLog: opts.apiLog,
    apiLogPath: path.join(profileDir, API_LOG_FILE),
    rttMs: opts.rttMs,
  })
  const fpConfigPath = path.join(profileDir, 'fp-config.json')
  fs.writeFileSync(fpConfigPath, JSON.stringify(fpConfig, null, 2))

  const cdpPort = await pickFreePort()

  const isWin = process.platform === 'win32'

  const args = buildLaunchArgs({
    fpConfigPath,
    licenseToken,
    cryptKey: opts.cryptKey,
    userDataDir,
    displayLabel,
    cdpPort,
    language: persona.languages[0] ?? 'en-US',
    headless: opts.headless,
    focusWindow: opts.focusWindow,
    localeFromConfig: opts.localeFromConfig,
    profileDir,
    webauthnCapture: opts.webauthnCapture,
    restoreTabs: opts.restoreTabs,
    platform: process.platform,
    androidScreen:
      persona.deviceType === 'android' ? { width: persona.screenW, height: persona.screenH } : undefined,
  })

  // Per-profile icon seeded from the label, so the profile is recognizable in the
  // taskbar (Windows/Linux) or the Dock and app switcher (macOS - it has no
  // per-window icons). On failure the switch is omitted; a kernel that does not
  // know the switch ignores it and keeps its default icon.
  {
    const iconPath = writeWindowIcon(profileDir, displayLabel)
    if (iconPath) args.push(`--fp-window-icon=${iconPath}`)
  }

  let localProxyClose: (() => void) | undefined

  if (proxyUrl) {
    // Credentials stay inline in --proxy-server and are resolved by the kernel's
    // network layer, so no extension and no local forwarder are involved.
    // ANTIBROW_PROXY_AUTH=extension restores the older path for troubleshooting.
    const legacyAuth = process.env.ANTIBROW_PROXY_AUTH === 'extension'
    if (!legacyAuth) {
      args.push(`--proxy-server=${proxyUrl}`)
    } else {
      try {
        const u = new URL(proxyUrl)
        const scheme = u.protocol.replace(/:$/, '')
        const isSocks5WithAuth = (scheme === 'socks5' || scheme === 'socks') && u.username
        if (scheme === 'relay') {
          args.push(`--proxy-server=${proxyUrl}`)
        } else if (isSocks5WithAuth) {
          const fwd = await startSocks5LocalProxy(
            u.hostname,
            parseInt(u.port, 10),
            decodeURIComponent(u.username),
            decodeURIComponent(u.password),
          )
          localProxyClose = fwd.close
          args.push(`--proxy-server=http://127.0.0.1:${fwd.port}`)
        } else {
          const proxyArg = `${u.protocol}//${u.hostname}:${u.port}`
          args.push(`--proxy-server=${proxyArg}`)
          if (u.username) {
            const extDir = writeProxyAuthExtension(profileDir, decodeURIComponent(u.username), decodeURIComponent(u.password))
            args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`)
          }
        }
      } catch {
        args.push(`--proxy-server=${proxyUrl}`)
      }
    }
  }

  onProgress?.(`Spawning kernel ${path.basename(exePath)} cdp_port=${cdpPort}`)
  // No windowsHide: true here. Node implements it via STARTUPINFO's
  // wShowWindow=SW_HIDE, which on Windows overrides the *first* ShowWindow call a
  // process makes. Chromium only calls ShowWindow once when --window-size or
  // --window-position is on the command line (both android profiles and the
  // Windows headless off-screen trick add one of these) - so windowsHide silently
  // left the browser window created but never shown (WS_VISIBLE never set), CDP
  // still connected fine. chrome.exe has no console window to hide in the first
  // place, so this option never did anything useful here.
  const child = spawn(exePath, args, {
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams
  // Latched here, before anything can await: a kernel that dies during startup
  // must still report its exit to callers that subscribe afterwards.
  const exit = exitLatch(child)
  // Keep the last few KB of kernel output so a failed start can explain itself.
  let kernelOut = ''
  const appendOut = (chunk: Buffer) => { kernelOut = (kernelOut + chunk.toString()).slice(-4000) }
  child.stderr?.on('data', (chunk: Buffer) => { appendOut(chunk); if (!isWin) process.stderr.write(chunk) })
  child.stdout?.on('data', (chunk: Buffer) => { appendOut(chunk) })
  onProgress?.(`Browser pid=${child.pid ?? 'unknown'}, waiting for CDP endpoint`)

  let wsEndpoint: string
  try {
    wsEndpoint = await waitForDevToolsPort(child, cdpPort, 120_000, () => kernelOut, onProgress)
  } catch (err) {
    killProcessTree(child.pid)
    const out = kernelOut.trim()
    if (/concurren|max.*instance|instance.*limit|license.*(limit|cap|mi\b)|too many/i.test(out)) {
      const cap = out.match(/limit\s*\((\d+)\)/)?.[1]
      throw new Error(
        `Concurrency limit reached${cap ? ` (${cap})` : ''}: close a running browser or upgrade for higher concurrency.`,
      )
    }
    throw err
  }

  onProgress?.(`Connecting Playwright over CDP to ${wsEndpoint}`)
  const pw = await chromium.connectOverCDP(wsEndpoint)
  const context = pw.contexts()[0] ?? (await pw.newContext())

  if (process.platform === 'darwin') {
    // Order matters: close first (in case a startup window did appear), then make
    // sure exactly one page is left for the caller. With no -AppleLanguages pair
    // there is no tab to wait for, and the poll costs up to 3s of every launch.
    if (!opts.localeFromConfig) {
      await closeStrayLocaleTab(context, persona.languages[0] ?? 'en-US').catch(() => {})
    }
    await ensureStartupPage(context)
  }

  return {
    context,
    wsEndpoint,
    profileDir,
    onExit(cb) {
      exit.onExit(cb)
    },
    async close() {
      // Browser.close first, over the live CDP connection -- pw.close() only
      // drops the connection for a browser we attached to, so disconnecting
      // before asking would leave nothing to ask with.
      const outcome = await shutdownKernel({
        requestClose: async () => {
          const cdp = await pw.newBrowserCDPSession()
          await cdp.send('Browser.close')
        },
        hasExited: () => exit.hasExited(),
        kill: () => killProcessTree(child.pid),
      })
      await pw.close().catch(() => {})
      localProxyClose?.()
      if (outcome === 'killed') opts.onProgress?.('Browser did not exit in time; killed')
      await killByUserDataDir(userDataDir)
    },
  }
}

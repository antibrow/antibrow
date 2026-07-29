import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chromium, type BrowserContext } from 'playwright-core'
import { SocksClient } from 'socks'
import { personaToFpConfig, API_LOG_FILE, type FpConfigSettings, type Persona } from './persona'
import { writeWindowIcon } from './icon'

/** Portable passkey store, kept at the profile root so exports carry it. */
export const PASSKEYS_FILE = 'passkeys.json'

export interface KernelLaunchOptions extends Omit<FpConfigSettings, 'apiLogPath'> {
  exePath: string
  profileDir: string
  persona: Persona
  timezone: string
  publicIp?: string
  proxyUrl?: string
  /** Signed license token. */
  licenseToken: string
  /** Window/address label. Defaults to the profile directory basename. */
  label?: string
  headless?: boolean
  /**
   * Whether newly registered passkeys go into this profile's portable store.
   * Absent/true = capture. false lets Chrome's own "where to save" dialog
   * through, so those credentials stay outside the profile.
   */
  webauthnCapture?: boolean
  onProgress?: (message: string) => void
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

    // The kernel does not write a DevToolsActivePort file, so readiness has to
    // be polled over HTTP.
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

/** Launch the kernel with the given persona and connect Playwright over CDP. */
export async function launchKernel(opts: KernelLaunchOptions): Promise<KernelSession> {
  const { exePath, profileDir, persona, timezone, publicIp, proxyUrl, licenseToken, onProgress } = opts

  const userDataDir = path.join(profileDir, 'user-data')
  fs.mkdirSync(userDataDir, { recursive: true })

  const displayLabel = opts.label || path.basename(profileDir)

  const fpConfig = personaToFpConfig(persona, {
    label: displayLabel,
    timezone,
    publicIp,
    canvasNoise: opts.canvasNoise,
    apiLog: opts.apiLog,
    apiLogPath: path.join(profileDir, API_LOG_FILE),
  })
  const fpConfigPath = path.join(profileDir, 'fp-config.json')
  fs.writeFileSync(fpConfigPath, JSON.stringify(fpConfig, null, 2))

  const cdpPort = await pickFreePort()

  const isWin = process.platform === 'win32'

  const args = [
    `--fp-config=${fpConfigPath}`,
    `--fp-license=${licenseToken}`,
    `--user-data-dir=${userDataDir}`,
    `--fp-address-label=${displayLabel}`,
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    `--lang=${persona.languages[0] ?? 'en-US'}`,
    // Docker: no sandbox (root, no user namespace), /tmp for shared memory
    // (/dev/shm is capped at 64 MB) and software rendering (no real GPU).
    // --no-zygote avoids a startup abort in the Linux builds.
    ...(!isWin ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-software-rasterizer',
        '--disable-crash-reporter',
        '--no-zygote'] : []),
    // Windows headless: move the window off-screen rather than --headless=new,
    // which is detectable.
    ...(isWin && opts.headless ? ['--window-position=-10000,-10000', '--window-size=1,1'] : []),
  ]

  args.push(`--fp-webauthn-store=${path.join(profileDir, PASSKEYS_FILE)}`)
  if (opts.webauthnCapture === false) args.push('--fp-webauthn-create=choose')

  // Per-profile window icon (Windows only), seeded from the label so the window
  // is recognizable. On failure the switch is omitted.
  if (isWin) {
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
  const child = spawn(exePath, args, {
    windowsHide: isWin,
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams
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

  return {
    context,
    wsEndpoint,
    profileDir,
    onExit(cb) {
      child.once('exit', cb)
    },
    async close() {
      await pw.close().catch(() => {})
      localProxyClose?.()
      killProcessTree(child.pid)
      await killByUserDataDir(userDataDir)
    },
  }
}

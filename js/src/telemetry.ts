import { SDK_VERSION } from './version'

/**
 * Launch outcome reporting. The server sees a license token being minted but not
 * whether the kernel download or the launch that followed it worked. An event is
 * a type, a boolean and a code from a closed vocabulary - no URLs, profile names,
 * proxy details or error text.
 */
export interface TelemetryEvent {
  type: 'kernel.download' | 'kernel.launch'
  ok: boolean
  code?: string
  kernelVersion?: string
  meta?: Record<string, string>
}

const SEND_TIMEOUT_MS = 2000

let clientLabel = 'sdk-js'

/** Lets the MCP server tag its launches apart from direct SDK calls. */
export function setTelemetryClient(label: string): void {
  clientLabel = label
}

export function telemetryDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ANTIBROW_TELEMETRY ?? '').trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'off' || v === 'no'
}

export function classifyLaunchError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (name === 'KernelStartupCrashError' || /segv|crash|signal/.test(msg)) return 'crash'
  // The mi ceiling is machine-wide, so another vendor's browser can trip it.
  if (/concurrent|concurrency|max instance|\bmi\b/.test(msg)) return 'concurrency'
  if (/license|fp_license|signature|expired|api key|unauthori[sz]ed|\b401\b/.test(msg)) return 'license'
  if (/timeout|timed out|deadline/.test(msg)) return 'timeout'
  if (/enoent|no such file|missing binary|spawn/.test(msg)) return 'missing_binary'
  if (/proxy|tunnel|econnrefused/.test(msg)) return 'proxy'
  return 'unknown'
}

export function classifyDownloadError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (/checksum|sha|digest|corrupt|size mismatch/.test(msg)) return 'checksum'
  if (/signature|codesign|notariz/.test(msg)) return 'signature'
  if (/unzip|extract|ditto|zip/.test(msg)) return 'extract'
  if (/lock|another process|busy/.test(msg)) return 'locked'
  if (/enospc|disk|space|eacces|eperm/.test(msg)) return 'disk'
  if (/abort|cancel/.test(msg)) return 'cancelled'
  if (/fetch|network|econn|etimedout|socket|dns|http [45]/.test(msg)) return 'network'
  return 'unknown'
}

/** Error class name only, for `unknown` rows: never the message, which can carry paths or hosts. */
export function errorKind(err: unknown): Record<string, string> | undefined {
  const name = err instanceof Error ? err.name : typeof err
  return name && name !== 'Error' ? { error: name.slice(0, 60) } : undefined
}

/**
 * Never throws. Awaiting it is bounded by a short timeout, which matters on the
 * failure path: the caller is about to rethrow, and an unhandled rejection ends
 * the process before a detached request could leave.
 */
export async function sendTelemetry(opts: {
  key: string
  server: string
  events: TelemetryEvent[]
  fetchImpl?: typeof fetch
}): Promise<void> {
  if (opts.events.length === 0 || telemetryDisabledByEnv()) return
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  timer.unref?.()
  try {
    await doFetch(`${opts.server.replace(/\/+$/, '')}/api/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.key}` },
      body: JSON.stringify({
        events: opts.events.map((e) => ({
          ...e,
          platform: process.platform,
          client: clientLabel,
          clientVersion: SDK_VERSION,
        })),
      }),
      signal: controller.signal,
    })
  } catch {
    /* dropped: a missing data point beats a retry loop */
  } finally {
    clearTimeout(timer)
  }
}

import type { BrowserContext, Page, CDPSession } from 'playwright-core'
import WebSocket from 'ws'

export interface LiveViewOptions {
  /** JPEG quality (1-100), default 60 */
  quality?: number
  /** Max frame width, default 1280 */
  maxWidth?: number
  /** Max frame height, default 720 */
  maxHeight?: number
  /** Send every Nth frame, default 2 (reduces bandwidth) */
  everyNthFrame?: number
}

export interface LiveViewSession {
  /** Unique session key for the live view */
  sessionKey: string
  /** Token for authenticating with the relay worker */
  relayToken: string
  /** URL to view this session in the dashboard */
  viewUrl: string
}

/** Streams CDP screencast frames to the relay over a WebSocket. */
export class LiveViewStream {
  private cdpSession: CDPSession | null = null
  private ws: WebSocket | null = null
  private running = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopCapture?: () => void

  constructor(
    private readonly context: BrowserContext,
    private page: Page,
    private readonly relayUrl: string,
    private readonly sessionKey: string,
    private readonly relayToken: string,
    private readonly options: LiveViewOptions = {},
  ) {}

  /** Start streaming browser frames. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    await this.connectWebSocket()
    await this.startScreencast()

    // Re-bind the CDP session when the active page changes.
    this.context.on('page', async (newPage) => {
      this.page = newPage
      await this.restartScreencast()
    })
  }

  /** Connect to the relay and forward each JPEG frame to the socket. */
  async startWithCapture(
    captureFrame: (onFrame: (jpeg: Buffer) => void, opts?: LiveViewOptions) => Promise<() => void>,
    opts: import('./types').LiveViewStreamOptions,
  ): Promise<void> {
    if (this.running) return
    this.running = true

    await this.connect()
    this.stopCapture = await captureFrame((jpeg) => this.sendFrame(jpeg), opts)
  }

  /** Stop streaming and clean up. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false

    if (this.stopCapture) {
      this.stopCapture()
      this.stopCapture = undefined
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    await this.stopScreencast()

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Establish the relay connection. Overridable in tests. */
  private async connect(): Promise<void> {
    await this.connectWebSocket()
  }

  /** Forward a single JPEG frame to the relay socket. */
  private sendFrame(jpeg: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(jpeg)
    }
  }

  private async connectWebSocket(): Promise<void> {
    const wsUrl = `${this.relayUrl}/produce/${this.sessionKey}?token=${this.relayToken}`

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)

      ws.on('open', () => {
        this.ws = ws
        resolve()
      })

      ws.on('error', (err) => {
        if (!this.ws) {
          reject(err)
          return
        }

        this.scheduleReconnect()
      })

      ws.on('close', () => {
        if (this.running) {
          this.scheduleReconnect()
        }
      })
    })
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (!this.running) return
      try {
        await this.connectWebSocket()
        await this.restartScreencast()
      } catch {

        this.scheduleReconnect()
      }
    }, 3000)
  }

  private async startScreencast(): Promise<void> {
    try {
      this.cdpSession = await this.context.newCDPSession(this.page)

      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.options.quality ?? 60,
        maxWidth: this.options.maxWidth ?? 1280,
        maxHeight: this.options.maxHeight ?? 720,
        everyNthFrame: this.options.everyNthFrame ?? 2,
      })

      this.cdpSession.on('Page.screencastFrame', (params: {
        data: string
        metadata: { offsetTop: number; pageScaleFactor: number; deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number; timestamp?: number }
        sessionId: number
      }) => {
        // Acknowledge the frame to receive the next one.
        this.cdpSession?.send('Page.screencastFrameAck', {
          sessionId: params.sessionId,
        }).catch(() => {})


        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(params.data)
        }
      })
    } catch {

    }
  }

  private async stopScreencast(): Promise<void> {
    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Page.stopScreencast')
        await this.cdpSession.detach()
      } catch {}
      this.cdpSession = null
    }
  }

  private async restartScreencast(): Promise<void> {
    await this.stopScreencast()
    if (this.running) {
      await this.startScreencast()
    }
  }
}

/** Register a live view session; returns the relay token and view URL. */
export async function registerLiveSession(options: {
  key: string
  server?: string
  sessionKey: string
  profileName?: string
  label?: string
  ua?: string
}): Promise<LiveViewSession> {
  const baseUrl = options.server || 'https://antibrow.com'
  const res = await fetch(`${baseUrl}/api/v1/liveview/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.key}`,
    },
    body: JSON.stringify({
      sessionKey: options.sessionKey,
      profileName: options.profileName,
      label: options.label,
      ua: options.ua,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to register live session: ${res.status} ${text}`)
  }

  return res.json() as Promise<LiveViewSession>
}

/** Unregister a live view session. */
export async function unregisterLiveSession(options: {
  key: string
  server?: string
  sessionKey: string
}): Promise<void> {
  const baseUrl = options.server || 'https://antibrow.com'
  await fetch(`${baseUrl}/api/v1/liveview/${options.sessionKey}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${options.key}`,
    },
  }).catch(() => {})
}

/** Keep the live session alive. */
export async function heartbeatLiveSession(options: {
  key: string
  server?: string
  sessionKey: string
}): Promise<void> {
  const baseUrl = options.server || 'https://antibrow.com'
  await fetch(`${baseUrl}/api/v1/liveview/${options.sessionKey}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.key}`,
    },
  }).catch(() => {})
}

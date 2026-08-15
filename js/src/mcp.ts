import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { AntiDetectBrowser } from './browser'
import { listProxies, claimManagedProxy } from './api'
import { LiveViewStream, registerLiveSession, unregisterLiveSession } from './liveview'
import { ensureCacheDir, listProfiles, getProfileDir } from './profile'
import {
  loadOrGeneratePersona,
  defaultKernelVersion,
  readProfileMeta,
  resolvePersonaInit,
  resolveAndroidKernel,
  refreshKernelVersions,
  ANDROID_MIN_KERNEL_VERSION,
} from './engine'
import { rmSync } from 'node:fs'
import type { McpSession } from './types'

/** The tree a profile tool should act on. Anything but `true` means managed. */
export function mcpRootOptions(args: Record<string, unknown> | undefined): { temporary: boolean } {
  return { temporary: args?.temporary === true }
}

/** Start the MCP server over stdio. */
export async function startMcpServer(): Promise<void> {
  const apiKey = process.env.ANTI_DETECT_BROWSER_KEY
  if (!apiKey) {
    console.error('Error: ANTI_DETECT_BROWSER_KEY environment variable is required')
    process.exit(1)
  }

  const server = process.env.ANTI_DETECT_BROWSER_SERVER
  const cacheDir = process.env.ANTI_DETECT_BROWSER_CACHE_DIR

  const ab = new AntiDetectBrowser({
    key: apiKey,
    server,
    cacheDir,
    // stdout is the JSON-RPC channel here, so notices have to go to stderr.
    notify: (m) => console.error(m),
  })

  const resolvedCacheDir = ensureCacheDir(cacheDir)
  const sessions = new Map<string, McpSession>()
  let sessionCounter = 0

  const mcpServer = new Server(
    {
      name: 'anti-detect-browser',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )


  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'launch_browser',
        description: 'Launch a new anti-detect browser instance with a spoofed fingerprint. Auto-creates a profile if it does not exist. For automation runs, set temporary: true so the profile stays out of the desktop app list.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            profile: { type: 'string', description: 'Profile name (required). Server assigns a fingerprint automatically.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags stored on profile metadata when creating a new profile' },
            label: { type: 'string', description: "Text the kernel shows in front of the address bar, so windows are tellable apart. Defaults to the profile name." },
            proxy: { type: 'string', description: 'Proxy URL (protocol://user:pass@host:port)' },
            proxyId: { type: 'string', description: 'Managed proxy id to use (activates it and meters monthly quota). Get one via list_proxies / claim_proxy.' },
            headless: { type: 'boolean', description: 'Run in headless mode' },
            focusWindow: { type: 'boolean', description: 'Whether the new window takes focus. Default true. Pass false to open it behind whatever the user is looking at, without interrupting them; the window is still there.' },
            deviceType: { type: 'string', enum: ['desktop', 'android'], description: 'Simulate an Android phone (running on this desktop/server, not on a physical device) instead of a desktop browser. Applies only when the profile is first created; an existing profile keeps its own device type.' },
            realFingerprint: { type: 'boolean', description: 'Draw the identity from the Captured-machine fingerprint library instead of generating one. Requires a paid plan; the server rejects this on free plans. Applies only when the profile is first created.' },
            temporary: { type: 'boolean', description: 'Use the temporary profile tree. Recommended for automation: temporary profiles are local-only and do not appear in the desktop app profile list. They persist on disk and are never deleted automatically.' },
          },
          required: ['profile'],
        },
      },
      {
        name: 'close_browser',
        description: 'Close a browser instance by session ID',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID to close' },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'list_sessions',
        description: 'List all currently running browser sessions',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'list_profiles',
        description: 'List local browser profiles. Profiles are stored on disk and unlimited.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            temporary: { type: 'boolean', description: 'Use the temporary profile tree. Recommended for automation: temporary profiles are local-only and do not appear in the desktop app profile list. They persist on disk and are never deleted automatically.' },
          },
        },
      },
      {
        name: 'create_profile',
        description: 'Create a local browser profile and fix its fingerprint identity now. Profiles are unlimited and local — launch_browser also auto-creates one on first use. The kernel generates a coherent fingerprint automatically.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Profile name (must be unique on this machine)' },
            deviceType: { type: 'string', enum: ['desktop', 'android'], description: 'Simulate an Android phone (running on this desktop/server, not on a physical device) instead of a desktop browser.' },
            realFingerprint: { type: 'boolean', description: 'Draw the identity from the Captured-machine fingerprint library instead of generating one. Requires a paid plan; the server rejects this on free plans.' },
            temporary: { type: 'boolean', description: 'Use the temporary profile tree. Recommended for automation: temporary profiles are local-only and do not appear in the desktop app profile list. They persist on disk and are never deleted automatically.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'delete_profile',
        description: 'Delete a local browser profile and its data from disk.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Profile name to delete' },
            temporary: { type: 'boolean', description: 'Use the temporary profile tree. Recommended for automation: temporary profiles are local-only and do not appear in the desktop app profile list. They persist on disk and are never deleted automatically.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'list_proxies',
        description: 'List the managed proxies assigned to you, plus your monthly quota (limit / usedThisMonth / remaining / holdCount / holdCap).',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'claim_proxy',
        description: 'Claim an available managed proxy. Claiming is free and does not consume monthly quota (quota is consumed only when you launch a profile with the proxy). Returns the claimed proxy including its id.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'navigate',
        description: 'Navigate browser to a URL',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID' },
            url: { type: 'string', description: 'URL to navigate to' },
          },
          required: ['sessionId', 'url'],
        },
      },
      {
        name: 'screenshot',
        description: 'Take a screenshot of the current page',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID' },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'evaluate',
        description: 'Execute JavaScript in the page context',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID' },
            script: { type: 'string', description: 'JavaScript code to execute' },
          },
          required: ['sessionId', 'script'],
        },
      },
      {
        name: 'click',
        description: 'Click an element by CSS selector',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID' },
            selector: { type: 'string', description: 'CSS selector of element to click' },
          },
          required: ['sessionId', 'selector'],
        },
      },
      {
        name: 'fill',
        description: 'Fill a form field with text',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID' },
            selector: { type: 'string', description: 'CSS selector of input element' },
            value: { type: 'string', description: 'Text to fill' },
          },
          required: ['sessionId', 'selector', 'value'],
        },
      },
      {
        name: 'get_content',
        description: 'Get text content of the page or a specific element',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID' },
            selector: { type: 'string', description: 'Optional CSS selector to get content from' },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'start_live_view',
        description: 'Start live view streaming for a browser session. Enables real-time viewing of the browser screen from the dashboard.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID' },
            quality: { type: 'number', description: 'JPEG quality 1-100 (default 60)' },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'stop_live_view',
        description: 'Stop live view streaming for a browser session',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: { type: 'string', description: 'Session ID' },
          },
          required: ['sessionId'],
        },
      },
    ],
  }))


  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      switch (name) {
        case 'launch_browser': {
          const result = await ab.launch({
            profile: args?.profile as string,
            tags: args?.tags as string[] | undefined,
            label: args?.label as string | undefined,
            proxy: args?.proxy as string | undefined,
            proxyId: args?.proxyId as string | undefined,
            headless: args?.headless as boolean | undefined,
            focusWindow: args?.focusWindow as boolean | undefined,
            deviceType: args?.deviceType as 'desktop' | 'android' | undefined,
            realFingerprint: args?.realFingerprint as boolean | undefined,
            temporary: mcpRootOptions(args).temporary,
          })

          const sessionId = `session_${++sessionCounter}`
          const session: McpSession = {
            id: sessionId,
            context: result.context,
            page: result.page,
            profileDir: result.profileDir,
            profileName: args?.profile as string,
            createdAt: new Date(),
          }
          sessions.set(sessionId, session)

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                sessionId,
                profileDir: result.profileDir,
              }, null, 2),
            }],
          }
        }

        case 'close_browser': {
          const sessionId = args?.sessionId as string
          const session = sessions.get(sessionId)
          if (!session) {
            return {
              content: [{ type: 'text' as const, text: `Session not found: ${sessionId}` }],
              isError: true,
            }
          }

          if (session.liveViewStream) {
            await session.liveViewStream.stop().catch(() => {})
            await unregisterLiveSession({
              key: apiKey,
              server,
              sessionKey: session.id,
            }).catch(() => {})
          }
          await session.context.close()
          sessions.delete(sessionId)

          return {
            content: [{ type: 'text' as const, text: `Session ${sessionId} closed successfully` }],
          }
        }

        case 'list_sessions': {
          const list = Array.from(sessions.entries()).map(([id, s]) => ({
            id,
            profileDir: s.profileDir,
            createdAt: s.createdAt.toISOString(),
          }))
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          }
        }

        case 'list_profiles': {
          const names = listProfiles(cacheDir, mcpRootOptions(args))
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(names, null, 2) }],
          }
        }

        case 'create_profile': {
          const name = args?.name as string
          if (!name) {
            return { content: [{ type: 'text' as const, text: 'Profile name is required' }], isError: true }
          }
          const profileDir = getProfileDir(name, cacheDir, mcpRootOptions(args))
          // Android-capable kernels exist only in the manifest, and a fresh MCP
          // process has an empty catalogue - without this the resolution below
          // would fall back to the compiled-in default every time.
          await refreshKernelVersions(resolvedCacheDir)
          const personaInit = await resolvePersonaInit(profileDir, {
            deviceType: args?.deviceType as 'desktop' | 'android' | undefined,
            realFingerprint: args?.realFingerprint as boolean | undefined,
            key: apiKey,
            server,
          })
          // An Android profile takes a kernel carrying the mobile patches, same
          // as the engine's own default resolution in openProfile.
          const defaultKv = personaInit?.deviceType === 'android'
            ? resolveAndroidKernel()
            : defaultKernelVersion()
          const persona = loadOrGeneratePersona(profileDir, defaultKv.version, personaInit)
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ name, profileDir, kernelVersion: persona.kernelVersion }, null, 2),
            }],
          }
        }

        case 'delete_profile': {
          const name = args?.name as string
          if (!name) {
            return { content: [{ type: 'text' as const, text: 'Profile name is required' }], isError: true }
          }
          const profileDir = getProfileDir(name, cacheDir, mcpRootOptions(args))
          rmSync(profileDir, { recursive: true, force: true })
          return {
            content: [{ type: 'text' as const, text: `Profile "${name}" deleted from disk` }],
          }
        }

        case 'list_proxies': {
          const data = await listProxies({ key: apiKey, server })
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          }
        }

        case 'claim_proxy': {
          const proxy = await claimManagedProxy({ key: apiKey, server })
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ proxy }, null, 2) }],
          }
        }

        case 'navigate': {
          const session = getSession(sessions, args?.sessionId as string)
          await session.page.goto(args?.url as string, { waitUntil: 'domcontentloaded' })
          const title = await session.page.title()
          return {
            content: [{
              type: 'text' as const,
              text: `Navigated to ${args?.url}. Page title: ${title}`,
            }],
          }
        }

        case 'screenshot': {
          const session = getSession(sessions, args?.sessionId as string)
          const buffer = await session.page.screenshot({ type: 'png' })
          return {
            content: [{
              type: 'image' as const,
              data: buffer.toString('base64'),
              mimeType: 'image/png',
            }],
          }
        }

        case 'evaluate': {
          const session = getSession(sessions, args?.sessionId as string)
          const result = await session.page.evaluate(args?.script as string)
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            }],
          }
        }

        case 'click': {
          const session = getSession(sessions, args?.sessionId as string)
          await session.page.click(args?.selector as string)
          return {
            content: [{
              type: 'text' as const,
              text: `Clicked element: ${args?.selector}`,
            }],
          }
        }

        case 'fill': {
          const session = getSession(sessions, args?.sessionId as string)
          await session.page.fill(args?.selector as string, args?.value as string)
          return {
            content: [{
              type: 'text' as const,
              text: `Filled ${args?.selector} with value`,
            }],
          }
        }

        case 'get_content': {
          const session = getSession(sessions, args?.sessionId as string)
          let content: string
          if (args?.selector) {
            content = await session.page.textContent(args.selector as string) || ''
          } else {
            content = await session.page.textContent('body') || ''
          }

          if (content.length > 10000) {
            content = content.slice(0, 10000) + '\n... (truncated)'
          }
          return {
            content: [{ type: 'text' as const, text: content }],
          }
        }

        case 'start_live_view': {
          const session = getSession(sessions, args?.sessionId as string)
          const relayUrl = process.env.ANTI_DETECT_BROWSER_RELAY_URL || 'wss://liveview-relay.antibrow.com'
          const lvSession = await registerLiveSession({
            key: apiKey,
            server,
            sessionKey: session.id,
            profileName: readProfileMeta(session.profileDir)?.name ?? session.profileDir.split(/[/\\]/).pop(),
            ua: '',
          })
          const stream = new LiveViewStream(
            session.context,
            session.page,
            relayUrl,
            lvSession.sessionKey,
            lvSession.relayToken,
            { quality: (args?.quality as number) || 60 },
          )
          await stream.start()
          session.liveViewStream = stream
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                message: 'Live view started',
                viewUrl: lvSession.viewUrl,
                sessionId: session.id,
              }, null, 2),
            }],
          }
        }

        case 'stop_live_view': {
          const session = getSession(sessions, args?.sessionId as string)
          if (session.liveViewStream) {
            await session.liveViewStream.stop()
            session.liveViewStream = undefined
            await unregisterLiveSession({
              key: apiKey,
              server,
              sessionKey: session.id,
            })
          }
          return {
            content: [{ type: 'text' as const, text: `Live view stopped for session ${session.id}` }],
          }
        }

        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
            isError: true,
          }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      }
    }
  })


  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)


  process.on('SIGINT', async () => {
    await mcpServer.close()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await mcpServer.close()
    process.exit(0)
  })
}

function getSession(sessions: Map<string, McpSession>, sessionId: string): McpSession {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(`Session not found: ${sessionId}. Use list_sessions to see active sessions.`)
  }
  return session
}

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { startMcpServer } from './mcp'
import { SDK_VERSION } from './version'
import { clearTemporaryProfiles } from './temporary-profiles'

export interface ClearTempArgs {
  olderThanDays?: number
  dryRun: boolean
}

const OLDER_THAN_EQ = '--older-than='

/**
 * Parses --clear-temp's own flags (apart from --clear-temp itself). Throws on
 * any unrecognized `--`-prefixed flag, a missing/empty --older-than value, or
 * a value that isn't a finite non-negative number - a typo like --dryrun or a
 * dangling --older-than must fail loud instead of letting the sweep run
 * unfiltered.
 */
export function parseClearTempArgs(args: string[]): ClearTempArgs {
  let olderThanRaw: string | undefined
  let olderThanSeen = false
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--clear-temp') continue
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg.startsWith(OLDER_THAN_EQ)) {
      olderThanSeen = true
      olderThanRaw = arg.slice(OLDER_THAN_EQ.length)
      continue
    }
    if (arg === '--older-than') {
      olderThanSeen = true
      olderThanRaw = args[i + 1]
      i++
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unrecognized argument: ${arg}. Run --help for usage.`)
    }
  }
  if (olderThanSeen && (olderThanRaw === undefined || olderThanRaw === '')) {
    throw new Error('Missing value for --older-than')
  }
  const olderThanDays = olderThanRaw === undefined ? undefined : Number(olderThanRaw)
  if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
    throw new Error(`Invalid --older-than value: ${olderThanRaw}`)
  }
  return { olderThanDays, dryRun }
}

/**
 * ANTIBROW_CACHE_DIR wins, ANTI_DETECT_BROWSER_CACHE_DIR is the legacy
 * fallback - matches the Python SDK's precedence, since both share one cache.
 */
export function resolveClearTempCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.ANTIBROW_CACHE_DIR || env.ANTI_DETECT_BROWSER_CACHE_DIR
}

function runClearTemp(args: string[], env: NodeJS.ProcessEnv): void {
  let parsed: ClearTempArgs
  try {
    parsed = parseClearTempArgs(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
    return
  }
  const cleared = clearTemporaryProfiles(resolveClearTempCacheDir(env), {
    olderThanDays: parsed.olderThanDays,
    dryRun: parsed.dryRun,
  })
  const bytes = cleared.reduce((sum, c) => sum + c.bytes, 0)
  const mb = (bytes / 1024 / 1024).toFixed(1)
  for (const c of cleared) console.log(`${parsed.dryRun ? 'would remove' : 'removed'} ${c.name}`)
  console.log(`${cleared.length} temporary profile(s), ${mb} MB${parsed.dryRun ? ' (dry run)' : ''}`)
}

export function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (args.includes('--mcp')) {
    startMcpServer().catch((error) => {
      console.error('Failed to start MCP server:', error)
      process.exit(1)
    })
  } else if (args.includes('--clear-temp')) {
    runClearTemp(args, env)
  } else if (args.includes('--version') || args.includes('-v')) {
    console.log(`anti-detect-browser v${SDK_VERSION}`)
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log(`
anti-detect-browser v${SDK_VERSION} — anti-detect browser SDK + MCP server

Usage:
  anti-detect-browser --mcp      Start as an MCP server (for AI agents)
  anti-detect-browser --clear-temp
                                 Delete temporary profiles (--older-than=<days>, --dry-run)
  anti-detect-browser --help     Show this help
  anti-detect-browser --version  Show version

MCP server mode:
  Exposes the browser to AI agents over MCP (stdio transport). Requires the
  ANTI_DETECT_BROWSER_KEY environment variable.

  Tools: launch_browser, close_browser, list_sessions, list_profiles,
         create_profile, delete_profile, list_proxies, claim_proxy,
         navigate, screenshot, evaluate, click, fill, get_content,
         start_live_view

  Environment variables:
    ANTI_DETECT_BROWSER_KEY        API key (required)
    ANTI_DETECT_BROWSER_SERVER     Server URL (optional)
    ANTI_DETECT_BROWSER_CACHE_DIR  Cache directory (optional)

Temporary profiles:
  Pass { temporary: true } to launch() so automation profiles land in their own
  tree and stay out of the desktop app list. They are never deleted
  automatically - clear them with --clear-temp.

  MCP client config:
    {
      "mcpServers": {
        "anti-detect-browser": {
          "command": "npx",
          "args": ["anti-detect-browser", "--mcp"],
          "env": { "ANTI_DETECT_BROWSER_KEY": "your-api-key" }
        }
      }
    }

SDK usage (Node.js):
  import { AntiDetectBrowser } from 'anti-detect-browser'

  const ab = new AntiDetectBrowser({ key: 'your-api-key' })
  const { page, browser } = await ab.launch({ profile: 'my-profile' })
  await page.goto('https://example.com')
  await browser.close()
`)
  } else {
    console.log(`anti-detect-browser v${SDK_VERSION}`)
    console.log('Run with --mcp to start as MCP server, or --help for usage.')
  }
}

/**
 * True when `entryArg` (normally `process.argv[1]`) is what actually loaded
 * this module, so the CLI only self-runs on direct invocation and not on
 * import (e.g. by tests). Resolved through the real path first: Node reports
 * `import.meta.url` as the target of a symlink, not the symlink itself, and
 * both `node_modules/.bin/<name>` and the `npx` shim ARE symlinks on macOS
 * and Linux - comparing the raw argv path left every symlinked invocation
 * (which is how the README tells MCP clients to launch this) silently doing
 * nothing.
 */
export function isDirectInvocation(entryArg: string | undefined, moduleUrl: string): boolean {
  if (!entryArg) return false
  let resolvedPath: string
  try {
    resolvedPath = realpathSync(entryArg)
  } catch {
    resolvedPath = entryArg
  }
  return moduleUrl === pathToFileURL(resolvedPath).href
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2), process.env)
}

import { startMcpServer } from './mcp'
import { SDK_VERSION } from './version'

const args = process.argv.slice(2)

if (args.includes('--mcp')) {
  startMcpServer().catch((error) => {
    console.error('Failed to start MCP server:', error)
    process.exit(1)
  })
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(`anti-detect-browser v${SDK_VERSION}`)
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`
anti-detect-browser v${SDK_VERSION} — anti-detect browser SDK + MCP server

Usage:
  anti-detect-browser --mcp      Start as an MCP server (for AI agents)
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

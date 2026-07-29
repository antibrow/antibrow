"""An MCP server that hands any agent a fingerprinted browser.

Exposes launch_browser / navigate / click / fill / get_content / screenshot /
evaluate_js / list_profiles / close_browser over stdio, so Claude Desktop,
Claude Code, Cursor or any MCP client can drive a real antidetect browser.

    pip install "antibrow[mcp]"
    python examples/09_mcp_server.py          # speaks MCP over stdio

Client config:

    {
      "mcpServers": {
        "antibrow": {
          "command": "python",
          "args": ["/absolute/path/to/examples/09_mcp_server.py"],
          "env": { "ANTIBROW_API_KEY": "your-api-key" }
        }
      }
    }

The browser stays alive between tool calls: the session is held in this process,
so an agent can navigate, read, click and come back later in the conversation.
Anything printed to stdout would corrupt the JSON-RPC channel, so progress goes
to stderr.
"""

from __future__ import annotations

import base64
import sys
from typing import Dict, Optional

from mcp.server.fastmcp import FastMCP

from antibrow import AsyncAntibrow, launch_async, list_profiles

mcp = FastMCP("antibrow")

_session: Optional[AsyncAntibrow] = None
_page = None


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _require_page():
    if _page is None:
        raise RuntimeError("No browser is running. Call launch_browser first.")
    return _page


@mcp.tool()
async def launch_browser(
    profile: str = "agent",
    proxy: Optional[str] = None,
    headless: bool = False,
) -> str:
    """Start a fingerprinted browser (or reuse the running one).

    profile: identity name - same name keeps cookies and fingerprint.
    proxy:   optional 'http://user:pass@host:port' or 'socks5://...'.
    """
    global _session, _page
    if _session is not None:
        return "Already running: profile={0} cdp={1}".format(
            _session.profile_dir.name, _session.cdp_url
        )
    _session = await launch_async(
        profile=profile, proxy=proxy, headless=headless, on_progress=_log
    )
    _page = await _session.new_page()
    return "Launched profile={0} kernel={1} timezone={2} exit_ip={3}".format(
        profile, _session.kernel_version, _session.timezone, _session.public_ip or "direct"
    )


@mcp.tool()
async def navigate(url: str, wait_until: str = "domcontentloaded") -> str:
    """Open a URL in the running browser."""
    page = _require_page()
    response = await page.goto(url, wait_until=wait_until)
    return "{0} -> {1} ({2})".format(
        url, await page.title(), response.status if response else "no response"
    )


@mcp.tool()
async def get_content(selector: Optional[str] = None, max_chars: int = 8000) -> str:
    """Read visible text from the page, or from one CSS selector."""
    page = _require_page()
    if selector:
        text = await page.inner_text(selector)
    else:
        text = await page.inner_text("body")
    return text[:max_chars]


@mcp.tool()
async def click(selector: str, timeout_ms: int = 10000) -> str:
    """Click the first element matching a CSS selector."""
    page = _require_page()
    await page.click(selector, timeout=timeout_ms)
    return "clicked {0}".format(selector)


@mcp.tool()
async def fill(selector: str, value: str, timeout_ms: int = 10000) -> str:
    """Type a value into an input."""
    page = _require_page()
    await page.fill(selector, value, timeout=timeout_ms)
    return "filled {0}".format(selector)


@mcp.tool()
async def screenshot(full_page: bool = False) -> Dict[str, str]:
    """Capture the page as a base64 PNG."""
    page = _require_page()
    data = await page.screenshot(full_page=full_page)
    return {"mime_type": "image/png", "data": base64.b64encode(data).decode("ascii")}


@mcp.tool()
async def evaluate_js(expression: str) -> str:
    """Run a JavaScript expression in the page and return its result."""
    page = _require_page()
    return repr(await page.evaluate(expression))


@mcp.tool()
async def browser_status() -> str:
    """Report the running session's identity, or say that none is running."""
    if _session is None:
        return "No browser running."
    return (
        "profile={0} kernel={1} cdp={2} timezone={3} exit_ip={4}\nua={5}"
    ).format(
        _session.profile_dir.name,
        _session.kernel_version,
        _session.cdp_url,
        _session.timezone,
        _session.public_ip or "direct",
        _session.persona.ua,
    )


@mcp.tool()
async def list_local_profiles() -> str:
    """List the browser profiles that exist on this machine."""
    profiles = list_profiles()
    return "\n".join(profiles) if profiles else "(no profiles yet)"


@mcp.tool()
async def close_browser() -> str:
    """Close the browser and stop the kernel process."""
    global _session, _page
    if _session is None:
        return "Nothing to close."
    await _session.close()
    _session, _page = None, None
    return "Closed."


if __name__ == "__main__":
    mcp.run()

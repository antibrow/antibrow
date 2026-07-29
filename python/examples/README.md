# Examples

Every example is runnable. They all need an API key — `python -m antibrow login`
once, or `export ANTIBROW_API_KEY=...` — and the first run downloads the browser
kernel (~190 MB, cached afterwards).

| File | What it shows | Extra install |
|---|---|---|
| [`01_basic.py`](01_basic.py) | Launch, browse, read the fingerprint back, screenshot CreepJS | — |
| [`02_persistent_profile.py`](02_persistent_profile.py) | Profiles: frozen identity + persistent storage. Run it twice | — |
| [`03_proxy_geoip.py`](03_proxy_geoip.py) | HTTP/SOCKS5 proxies, and making timezone + WebRTC follow the exit IP | — |
| [`04_playwright.py`](04_playwright.py) | Locators, routing, init scripts, cookies — plain Playwright | — |
| [`05_puppeteer_style.py`](05_puppeteer_style.py) | Puppeteer/Node idiom → Python mapping, and attaching Node over CDP | — |
| [`06_browser_use.py`](06_browser_use.py) | An LLM agent driving the browser | `pip install browser-use` |
| [`07_crawl4ai.py`](07_crawl4ai.py) | crawl4ai's markdown pipeline over a fingerprinted browser | `pip install crawl4ai` |
| [`08_scrapling.py`](08_scrapling.py) | Scrapling's adaptive selectors over the same session | `pip install scrapling` |
| [`09_mcp_server.py`](09_mcp_server.py) | A full MCP server: any agent gets a stealth browser | `pip install "antibrow[mcp]"` |
| [`10_docker/`](10_docker/) | Container image, headful under Xvfb, cached kernel volume | Docker |

```bash
python examples/01_basic.py
ANTIBROW_PROXY="socks5://user:pass@host:1080" python examples/03_proxy_geoip.py
```

## Notes

- **Linux/Docker:** run under `xvfb-run -a`. `headless=True` is a Windows-only
  trick (off-screen window); on Linux a virtual display is the honest equivalent,
  and real `--headless` is avoided because it is itself a fingerprint.
- **Third-party APIs move.** `06`–`08` target the integrations' current APIs
  (browser-use, crawl4ai, Scrapling). If one changes, the stable part is always
  `session.cdp_url` / `session.cdp_endpoint` — hand that to whatever the library
  now calls its "connect to an existing browser" option.
- **Concurrency:** each running browser consumes one slot from your plan's cap.
  Free is 1; the kernel enforces it and raises `ConcurrencyLimitError`.

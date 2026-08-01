<div align="center">

<img src="https://antibrow.com/AntiBrow-mark.svg" alt="AntiBrow" height="72">

# antibrow

**The antidetect browser your AI agent can drive.**

Kernel-level fingerprint spoofing · unlimited local profiles, free · the Playwright API you already write

[![PyPI](https://img.shields.io/pypi/v/antibrow?color=6366f1&label=pypi)](https://pypi.org/project/antibrow/)
[![Python](https://img.shields.io/pypi/pyversions/antibrow?color=3776ab)](https://pypi.org/project/antibrow/)
[![CI](https://github.com/antibrow/antibrow/actions/workflows/ci.yml/badge.svg)](https://github.com/antibrow/antibrow/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6366f1)](#platform-support)
[![Agent ready](https://img.shields.io/badge/agent-MCP%20ready-a855f7)](#ai-agents-and-mcp)
[![License](https://img.shields.io/badge/wrapper-MIT-444)](LICENSE)

</div>

```python
from antibrow import launch

browser = launch()
page = browser.new_page()
page.goto("https://abrahamjuliot.github.io/creepjs/")
```

That is a real Chromium — with a real device's fingerprint, its own persistent profile, and no `playwright install` step — driven by the exact Playwright API you already know.

---

## Contents

- [Why antibrow](#why-antibrow)
- [Install](#install)
- [Quick start](#quick-start)
- [API reference](#api-reference)
- [Profiles and fingerprints](#profiles-and-fingerprints)
- [Proxies](#proxies)
- [Framework integrations](#framework-integrations)
  - [Playwright](#playwright) · [Puppeteer / Node](#coming-from-puppeteer-or-the-node-sdk) · [browser-use](#browser-use) · [crawl4ai](#crawl4ai) · [Scrapling](#scrapling) · [MCP](#ai-agents-and-mcp) · [Selenium](#selenium)
- [Docker](#docker)
- [CLI](#cli)
- [Platform support](#platform-support)
- [Plans and concurrency](#plans-and-concurrency)
- [FAQ](#faq)
- [License](#license)

## Why antibrow

**The spoofing is in the engine, not in a script.** Most stealth tooling patches JavaScript from the outside: override a getter, shim `navigator`, monkey-patch `toString`. Anti-bot vendors have been fingerprinting those patches for years. antibrow ships a modified Chromium — Canvas, WebGL, WebGPU, audio, fonts, `navigator`, screen, DOMRect and timezone are answered inside C++/Blink, so there is no injected script to find, no property descriptor out of place, and worker contexts return exactly what the main thread does.

**One coherent identity, frozen per profile.** Randomising every value independently is itself a signal: real devices do not pair an AMD renderer with an Intel vendor string, or a 1.0 device pixel ratio with a 1536×864 screen. Each profile gets one self-consistent persona at creation time and keeps it forever — same UA, same GPU, same seeds, same fonts, launch after launch.

**Timezone follows the proxy.** Pass a proxy and the exit IP is resolved through that same proxy; the browser's timezone and WebRTC identity are set from it before the first byte of the first page.

**Unlimited local profiles, free.** A profile is a directory. Name one and it exists. There is no per-profile fee and nothing to provision. Your plan sets how many browsers run *at the same time*, not how many identities you may own.

**Built for agents.** `launch()` hands back a live CDP endpoint plus a Playwright handle, so browser-use, crawl4ai, Scrapling, your own MCP server, or plain Playwright all attach without glue code.

## Install

```bash
pip install antibrow
```

Then fetch the browser kernel and store your API key (both are one-time):

```bash
python -m antibrow install     # downloads + extracts the kernel (~190 MB zip, ~440 MB on disk)
python -m antibrow login       # stores your key in ~/.antibrow/license.key
```

> **An API key is required.** The kernel verifies a short-lived, server-signed license token on startup and refuses to run without one — that check is compiled into the binary, so there is no offline mode. A **free key** (1 concurrent browser, unlimited local profiles) is at **[antibrow.com](https://antibrow.com)**. This package never signs tokens itself: it exchanges your key for a token over HTTPS and caches it, so a tight relaunch loop hits the network roughly once a day.

You do **not** need `playwright install` — antibrow drives its own kernel, not Playwright's bundled browsers. The `playwright` package is still required (for its client library).

Skipping `install` is fine: the first `launch()` downloads the kernel it needs.

## Quick start

```python
from antibrow import launch

# A named profile: same fingerprint, cookies and storage every time.
browser = launch(profile="shopper-01")

page = browser.new_page()
page.goto("https://whoer.net")
print(page.title())

browser.close()
```

Context manager, headless, proxy, geo-matched timezone:

```python
from antibrow import launch

with launch(
    profile="scraper-eu",
    headless=True,
    proxy="http://user:pass@gate.example.com:8080",
    geoip=True,                       # timezone + WebRTC follow the proxy exit
) as browser:
    page = browser.new_page()
    page.goto("https://example.com")
    print(browser.timezone, browser.public_ip)
```

Async, for agents and concurrent crawls:

```python
import asyncio
from antibrow import launch_async

async def main():
    browser = await launch_async(profile="agent-01")
    page = await browser.new_page()
    await page.goto("https://example.com")
    print(await page.title())
    await browser.close()

asyncio.run(main())
```

More in [`examples/`](examples/).

## API reference

### `launch(profile="default", **options) -> Antibrow`

Starts the kernel and returns a handle that is ready to drive. Blocking (sync) API.

| Option | Type | Default | What it does |
|---|---|---|---|
| `profile` | `str` | `"default"` | Profile name. Same name → same identity, cookies, storage. Unlimited, free, local. |
| `headless` | `bool` | `False` | Hide the window. On Windows the window is moved off-screen instead of `--headless=new`, because headless Chromium has its own detectable fingerprint. On Linux use Xvfb (see [Docker](#docker)); on macOS it has no effect yet. |
| `proxy` | `str \| dict` | `None` | `"http://user:pass@host:port"`, `"socks5://…"`, `"https://…"`, `"relay://…"`, or Playwright's `{"server": …, "username": …, "password": …}`. |
| `geoip` | `bool` | `True` | Resolve the proxy's exit IP through the proxy and make timezone + WebRTC match it. No-op without a proxy. |
| `timezone` | `str` | `None` | Force an IANA timezone (`"Europe/Berlin"`), overriding the geo lookup. |
| `api_key` | `str` | env / key file | AntiBrow API key. |
| `server` | `str` | `https://antibrow.com` | License server base URL. |
| `cache_dir` | `path` | `~/.anti-detect-browser` | Where kernels and profiles live. |
| `profile_dir` | `path` | `None` | Exact profile directory, bypassing `cache_dir`/`profile`. |
| `kernel_version` | `str` | newest | Kernel for a **new** profile. Existing profiles keep the version frozen in their persona. |
| `label` | `str` | profile name | Text shown in the kernel's address-bar tag — tells windows apart at a glance. |
| `args` | `list[str]` | `None` | Extra Chromium switches. |
| `proxy_auth` | `"native" \| "extension"` | `"native"` | How proxy credentials are answered. Native = inside the network stack, no extension. |
| `license_token` | `str` | `None` | Use a pre-minted token instead of calling the server. |
| `license_provider` | `callable` | `None` | Return a token from your own issuer (self-hosted, vault, CI). |
| `update_kernel` | `bool` | `False` | Check for a newer build of this profile's kernel and install it before launching. |
| `reuse_initial_page` | `bool` | `True` | Let the first `new_page()` return Chromium's initial blank tab instead of opening a second one. |
| `timeout` | `float` | `120.0` | Seconds to wait for the browser to come up. |
| `on_progress` | `callable` | `None` | Receives progress lines (`"Downloading 42%"`, `"CDP endpoint ready …"`). |

### The `Antibrow` handle

Attribute lookups fall through to the Playwright `BrowserContext`, so anything you would call on a context works directly on the handle.

```python
browser = launch(profile="p1")

page  = browser.new_page()          # -> Playwright Page
pages = browser.pages               # -> delegated to the context
browser.add_init_script("…")        # -> delegated
browser.add_cookies([...])          # -> delegated

browser.context                     # the raw Playwright BrowserContext
browser.browser                     # the raw Playwright Browser (CDP connection)
browser.page                        # first page, created on demand

browser.cdp_endpoint                # 'ws://127.0.0.1:54321/devtools/browser/…'
browser.cdp_url                     # 'http://127.0.0.1:54321'  (what crawl4ai wants)
browser.profile_dir                 # Path to this profile on disk
browser.persona                     # the frozen identity (UA, GPU, screen, seeds…)
browser.timezone, browser.public_ip # resolved from the proxy when geoip=True
browser.kernel_version, browser.pid
browser.plan                        # everything resolved for this launch
browser.plan.redacted_args()        # the command line, secrets masked - paste into bug reports

browser.close()                     # closes the browser and reaps the process tree
```

`new_page()` hands back Chromium's initial blank tab the first time it is called (Chromium always opens with one), then opens real new tabs. Use `browser.context.new_page()` if you always want a fresh one.

### Other entry points

```python
from antibrow import launch_async, launch_persistent_context, prepare_launch

browser = await launch_async(profile="p1")          # asyncio twin of launch()
context = launch_persistent_context(profile="p1")   # raw Playwright BrowserContext
plan    = prepare_launch(profile="p1")              # resolve everything, start nothing
```

`prepare_launch()` returns the exact executable, arguments, persona and timezone that a launch would use, without starting a process — useful for tests, dry runs and bug reports.

### Errors

Every intentional failure derives from `AntibrowError`:

```python
from antibrow import AntibrowError, ConcurrencyLimitError, LicenseError

try:
    browser = launch()
except ConcurrencyLimitError:
    ...   # the plan's simultaneous-browser cap is in use (enforced by the kernel)
except LicenseError:
    ...   # no API key, or the server rejected it
except AntibrowError:
    ...   # kernel download, unsupported platform, proxy, launch failure
```

## Profiles and fingerprints

A profile is a directory under `~/.anti-detect-browser/profiles/<name>/`:

```
persona.json     the frozen identity - written once, never regenerated
fp-config.json   the persona serialized for the kernel, rewritten each launch
user-data/       Chromium's profile: cookies, storage, history, extensions
```

The cache directory is shared with the [Node SDK](https://www.npmjs.com/package/anti-detect-browser) and the AntiBrow desktop app, so a profile created from Python shows up in the desktop app's list and vice versa. Override it with `ANTIBROW_CACHE_DIR` or `cache_dir=`.

What a persona pins:

| Surface | Example |
|---|---|
| User agent + `navigator` | Windows 11 / current Chrome, `platform`, `vendor`, `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, UA-CH `platformVersion` |
| Screen | CSS size, `availWidth/Height` minus the taskbar, `colorDepth`, `devicePixelRatio` (never 1.0) |
| GPU | matching WebGL unmasked vendor + renderer (Intel / NVIDIA / AMD) |
| Canvas, audio, DOMRect | per-profile seeds → deterministic noise, identical on every visit |
| Fonts | Windows font set, Segoe UI, no CJK leakage |
| Locale | `languages`, `Accept-Language`, and the timezone (from the proxy when `geoip=True`) |
| WebRTC | passthrough with the proxy's public IP, or disabled when there is no proxy |

Determinism matters as much as the values themselves: a browser that returns a *new* canvas hash on every call is trivially flagged. Seeds are stable per profile, so repeat visits agree with each other.

Inspect a live identity:

```python
browser = launch(profile="p1")
print(browser.persona.ua, browser.persona.gpu_renderer, browser.persona.screen_w)
```

Sanity checks worth running once: [creepjs](https://abrahamjuliot.github.io/creepjs/), [whoer.net](https://whoer.net), [browserleaks.com/canvas](https://browserleaks.com/canvas), [pixelscan.net](https://pixelscan.net).

## Proxies

```python
launch(proxy="http://user:pass@gate.example.com:8080")
launch(proxy="https://user:pass@gate.example.com:443")
launch(proxy="socks5://user:pass@127.0.0.1:1080")
launch(proxy={"server": "http://gate.example.com:8080", "username": "u", "password": "p"})
```

Credentials are handled **inside the kernel** — HTTP/HTTPS 407 challenges are answered in the network stack, SOCKS5 uses RFC 1929 user/password negotiation. Nothing is loaded into `chrome://extensions`, which is exactly the kind of tell an antidetect browser must not have. (`proxy_auth="extension"` reproduces the older MV3 approach if you ever need it for an HTTP proxy; it cannot do SOCKS5.)

Passwords containing `@`, `:` or `/` are fine — percent-encode them in the URL, or use the dict form.

With `geoip=True` (the default), the exit IP is looked up *through* the proxy before launch, and its timezone is written into the fingerprint:

```python
browser = launch(profile="p1", proxy="socks5://user:pass@127.0.0.1:1080")
print(browser.public_ip, browser.timezone)   # 203.0.113.7 America/Los_Angeles
```

AntiBrow's own managed residential proxies use the `relay://` scheme, which the kernel speaks natively:

```python
launch(proxy="relay://<api-key>:<proxy-id>@proxy.antibrow.com")
```

## Framework integrations

Every integration works the same way: antibrow starts the browser, and you hand its **CDP endpoint** to whatever wants to drive it.

```python
browser = launch(profile="p1")
browser.cdp_url        # http://127.0.0.1:54321
browser.cdp_endpoint   # ws://127.0.0.1:54321/devtools/browser/…
```

### Playwright

The handle *is* Playwright. Existing scripts change only their launch line:

```python
# before
# from playwright.sync_api import sync_playwright
# pw = sync_playwright().start()
# browser = pw.chromium.launch()
# context = browser.new_context()

from antibrow import launch
context = launch(profile="p1")        # a BrowserContext in all but name

page = context.new_page()
page.goto("https://example.com")
page.get_by_role("button", name="Sign in").click()
```

Need the literal object for an API that type-checks it:

```python
from antibrow import launch_persistent_context
context = launch_persistent_context(profile="p1")   # playwright BrowserContext
context.close()                                     # also stops the kernel
```

Full example: [`examples/04_playwright.py`](examples/04_playwright.py).

### Coming from Puppeteer or the Node SDK

Same product, two runtimes — [`anti-detect-browser`](https://www.npmjs.com/package/anti-detect-browser) on npm, `antibrow` on PyPI, sharing one cache directory, one profile format and one account.

```js
// Node
const ab = new AntiDetectBrowser({ key: process.env.ANTI_DETECT_BROWSER_KEY })
const { page, browser } = await ab.launch({ profile: 'shopper-01' })
await page.goto('https://example.com')
await browser.close()
```

```python
# Python
browser = launch(profile="shopper-01")
page = browser.new_page()
page.goto("https://example.com")
browser.close()
```

Puppeteer users: the endpoint is plain CDP, so `puppeteer.connect({ browserURL: browser.cdp_url })` works from any language. Side-by-side mapping in [`examples/05_puppeteer_style.py`](examples/05_puppeteer_style.py).

### browser-use

```python
from antibrow import launch_async
from browser_use import Agent, Browser, ChatOpenAI

session = await launch_async(profile="agent-01", proxy="http://user:pass@gate:8080")
agent = Agent(
    task="Find the cheapest flight from Berlin to Lisbon next month",
    llm=ChatOpenAI(model="gpt-4.1-mini"),
    browser=Browser(cdp_url=session.cdp_url),
)
await agent.run()
```

[`examples/06_browser_use.py`](examples/06_browser_use.py) — includes the fallback spelling for older browser-use releases (`BrowserSession(cdp_url=…)`).

### crawl4ai

```python
from antibrow import launch_async
from crawl4ai import AsyncWebCrawler, BrowserConfig

session = await launch_async(profile="crawler-01")
config = BrowserConfig(cdp_url=session.cdp_url, headless=False)

async with AsyncWebCrawler(config=config) as crawler:
    result = await crawler.arun(url="https://example.com")
    print(result.markdown)
```

[`examples/07_crawl4ai.py`](examples/07_crawl4ai.py)

### Scrapling

```python
from antibrow import launch
from scrapling.fetchers import DynamicFetcher

browser = launch(profile="scrapling-01")
page = DynamicFetcher.fetch("https://example.com", cdp_url=browser.cdp_endpoint)
print(page.css_first("h1::text"))
```

[`examples/08_scrapling.py`](examples/08_scrapling.py)

### AI agents and MCP

Any MCP client can drive a fingerprinted browser. [`examples/09_mcp_server.py`](examples/09_mcp_server.py) is a complete stdio MCP server (`pip install "antibrow[mcp]"`) exposing `launch_browser`, `navigate`, `click`, `fill`, `get_content`, `screenshot`, `evaluate` and `close_browser`:

```json
{
  "mcpServers": {
    "antibrow": {
      "command": "python",
      "args": ["/abs/path/to/examples/09_mcp_server.py"],
      "env": { "ANTIBROW_API_KEY": "your-api-key" }
    }
  }
}
```

The Node package ships an MCP server out of the box (`npx anti-detect-browser --mcp`) if you would rather not run the example.

### Selenium

Selenium cannot attach to a CDP-only endpoint without a matching chromedriver, so there is no supported Selenium binding today. If you are migrating, the Playwright section above is the shortest path; open an issue if chromedriver support matters to you.

## Docker

The Linux kernel runs headful under Xvfb - real headless Chromium has its own fingerprint, so the image renders to a virtual display instead. The image below works on both `linux/amd64` and `linux/arm64`; the matching kernel build is chosen from the container's CPU, so nothing here is architecture-specific.

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir antibrow
COPY script.py .
CMD ["xvfb-run", "-a", "python", "script.py"]
```

```bash
docker build -t my-scraper .
docker run --rm -e ANTIBROW_API_KEY=$ANTIBROW_API_KEY \
  -v antibrow-cache:/root/.anti-detect-browser my-scraper
```

Mounting the cache volume keeps the kernel (and your profiles) between runs. The full image is in this repo's [`Dockerfile`](Dockerfile); see [`examples/10_docker/`](examples/10_docker/).

## CLI

```bash
python -m antibrow install [--version 150.0.7871.182] [--force]   # get the kernel
python -m antibrow info                                           # kernels, profiles, license
python -m antibrow login [--key ab_live_…]                        # store an API key
python -m antibrow version                                        # SDK + default kernel
```

`antibrow …` works too (console script). `info` is the first thing to run when something is wrong: it prints the cache directory, every kernel version with install/update status, all profiles with their pinned kernel, and where your API key was found.

### Environment variables

| Variable | Purpose |
|---|---|
| `ANTIBROW_API_KEY` | API key (also accepts the Node SDK's `ANTI_DETECT_BROWSER_KEY`) |
| `ANTIBROW_LICENSE_TOKEN` | Pre-minted license token; skips the server call entirely |
| `ANTIBROW_CACHE_DIR` | Kernel + profile root (default `~/.anti-detect-browser`) |
| `ANTIBROW_SERVER` | License server base URL |

## Platform support

| Platform | Status | Notes |
|---|---|---|
| Windows 10/11 x64 | Supported | Headful, or headless via off-screen window |
| macOS 12+ (Apple silicon + Intel) | Supported | Universal build. Headful — `headless=True` has no effect here yet |
| Linux x64 (glibc) | Supported | Needs Xvfb for headless; container flags applied automatically |
| Linux arm64 (glibc) | Supported | Separate arm64 build, picked automatically from the CPU |
| Docker (linux/amd64, linux/arm64) | Supported | See [Docker](#docker) |
| Linux musl (Alpine) | Not yet | No kernel build |

Python 3.9 – 3.13. The kernel is cached once per version — ~190 MB to download on
Windows and Linux, ~320 MB for the macOS universal bundle (it carries both
architectures) — and `python -m antibrow info` shows what is installed and where.

## Plans and concurrency

Local profiles are unlimited on every plan, including free. What scales with the plan is how many browsers run **at the same time** — enforced by the kernel itself (cross-process file locks), not by this SDK, so it cannot be worked around by spawning more Python processes.

| Plan | Local profiles | Concurrent browsers | Cloud sync | Managed proxies |
|---|:--:|:--:|:--:|:--:|
| Free | unlimited | 1 | – | – |
| Basic | unlimited | 5 | yes | yes |
| Pro | unlimited | 20 | yes | yes |
| Team | unlimited | 100 | yes | yes |

Details at [antibrow.com/pricing](https://antibrow.com/pricing). Exceeding the cap raises `ConcurrencyLimitError` instead of hanging.

Cloud profile sync and Live View are implemented in the Node SDK and the desktop app; this package is local-only for now.

## FAQ

**Do I need `playwright install`?**
No. antibrow downloads and drives its own kernel. The `playwright` pip package is required for its client library, but its bundled browsers are never used.

**Does it work without an API key?**
No. The license check is compiled into the kernel binary. A free key is at [antibrow.com](https://antibrow.com), and one token covers a whole day of relaunches.

**Where does my data go?**
Profiles never leave your machine in this package. The only outbound calls are: the kernel download (`download.antibrow.com`), the token exchange (`antibrow.com`), and — only when `geoip=True` *and* a proxy is set — one request to `ip-api.com` **through your proxy** to read its exit timezone.

**Can I use my own profile directory / mount it into CI?**
Yes: `launch(profile_dir="/data/profiles/acct-17")`, or set `ANTIBROW_CACHE_DIR`. Copy the directory to move an identity between machines.

**Is headless detectable?**
Real headless Chromium is, which is why `headless=True` on Windows moves the window off-screen instead. On Linux, run headful under Xvfb (as the Dockerfile does).

**How do I keep the kernel up to date?**
`python -m antibrow install --force`, or `launch(update_kernel=True)`. Installed kernels are never swapped under you.

**Something fails on launch — what do I send?**
`python -m antibrow info` and `prepare_launch(...).redacted_args()`. Both are safe to paste; the license token and proxy password are masked.

**Is this legal to use?**
It is a browser. Scraping public data, testing your own anti-fraud stack and managing your own accounts are ordinary uses. Fraud, credential stuffing and violating a site's terms are not — and are not supported here.

## License

Two licenses, and the boundary matters:

- **This repository — the Python wrapper, CLI, examples and docs — is [MIT](LICENSE).** Fork it, vendor it, ship it.
- **The browser kernel binary is closed source and separately licensed.** It is not in this repository and not in the PyPI package; it is downloaded from AntiBrow's own CDN at runtime, by the end user, onto the end user's machine. Redistributing, reselling or repackaging that binary is not permitted. Full terms and the OEM/SaaS boundary: [BINARY-LICENSE.md](BINARY-LICENSE.md).

Depending on this package does **not** make you a redistributor of the kernel.

## Links

- Website and API keys — [antibrow.com](https://antibrow.com)
- Docs — [antibrow.com/docs/sdk](https://antibrow.com/docs/sdk)
- Node/TypeScript SDK — [`anti-detect-browser`](https://www.npmjs.com/package/anti-detect-browser)
- Desktop app — [antibrow.com/download](https://antibrow.com/download)
- Issues — [GitHub](https://github.com/antibrow/antibrow/issues)

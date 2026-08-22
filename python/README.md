<div align="center">

<img src="https://antibrow.com/AntiBrow-mark.svg" alt="AntiBrow" height="72">

# antibrow

**English** | [Русский](https://github.com/antibrow/antibrow/blob/main/python/README.ru.md)

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
  - [Managed proxies](#managed-proxies) · [Your own proxy library](#your-own-proxy-library)
- [Managing cloud profiles](#managing-cloud-profiles)
- [Live View](#live-view)
- [Framework integrations](#framework-integrations)
  - [Playwright](#playwright) · [Puppeteer / Node](#coming-from-puppeteer-or-the-node-sdk) · [browser-use](#browser-use) · [crawl4ai](#crawl4ai) · [Scrapling](#scrapling) · [MCP](#ai-agents-and-mcp) · [Selenium](#selenium)
- [Running automation at scale](#running-automation-at-scale)
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

**Authenticated proxies, with nothing loaded to make them work.** `socks5://user:pass@host:port` works as-is: HTTP/HTTPS `407` challenges are answered in the network stack, SOCKS5 by RFC 1929 username/password negotiation, all inside the engine. `chrome://extensions` stays empty — the proxy-auth helper extension most antidetect browsers still ship is enumerable from any page, and is itself a tell.

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
| `focus_window` | `bool` | `True` | Whether the new window takes focus. `False` opens it behind whatever is in front, so a launch does not interrupt you - the window is still there, just not focused. Not headless. Decided in the kernel, so install the latest kernel for the profile before relying on it. |
| `headless` | `bool` | `False` | Hide the window. On Windows the window is moved off-screen instead of `--headless=new`, because headless Chromium has its own detectable fingerprint. On Linux use Xvfb (see [Docker](#docker)); on macOS it has no effect yet. |
| `proxy` | `str \| dict` | `None` | `"http://user:pass@host:port"`, `"socks5://…"`, `"https://…"`, or Playwright's `{"server": …, "username": …, "password": …}`. |
| `proxy_id` | `str` | `None` | Use one of your **managed** proxies instead. See [Managed proxies](#managed-proxies). Mutually exclusive with `proxy`. |
| `geoip` | `bool` | `True` | Resolve the exit IP and make timezone + WebRTC match it: through the proxy when one is set, otherwise this machine's own exit. |
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
| `device_type` | `"desktop" \| "android"` | `"desktop"` | Simulate an Android phone instead of a desktop browser. Applies only when the profile is **created**; see [Android profiles](#android-profiles). |
| `real_fingerprint` | `bool` | `False` | Draw the identity from the fingerprint library on the server instead of generating one (paid plans). Also creation-time only. |
| `sync` | `bool` | plan default | Cloud profile sync: restore before launching, save after closing. `None` follows the plan the key is on, `False` keeps the launch local, `True` attempts it regardless. |
| `on_sync` | `callable` | `None` | Receives a `SyncEvent` as each transfer starts and finishes. |
| `canvas_noise` | `bool` | `True` | Per-profile Canvas + WebGL noise. `False` turns both off; the identity itself does not change. |
| `api_log` | `"off" \| "curated" \| "all"` | `"off"` | Log the fingerprint APIs pages touch to `<profile>/fp-api-log.jsonl`. |
| `live_view` | `bool \| LiveViewOptions` | `False` | Stream the window to your dashboard. See [Live View](#live-view). |
| `webauthn_capture` | `bool` | `True` | Keep new passkeys in the profile's portable store, so they travel with a sync or an export. `False` lets the browser ask where to save instead (phone / security key) and those stay on this device. |
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
browser.synced                      # True when this profile has a cloud archive slot
browser.sync_error                  # why the closing upload failed, if it did
browser.plan                        # everything resolved for this launch
browser.plan.redacted_args()        # the command line, secrets masked - paste into bug reports

browser.close()                     # closes the browser and reaps the process tree
```

`close()` also packs the profile and uploads it when sync is on, so it is the point at which cookies, storage and passkeys reach the cloud. It never raises for a sync failure — check `browser.sync_error` (or `on_sync`) if you need to know.

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
from antibrow import AntibrowError, ApiError, ConcurrencyLimitError, LicenseError

try:
    browser = launch()
except ConcurrencyLimitError:
    ...   # the plan's simultaneous-browser cap is in use (enforced by the kernel)
except LicenseError:
    ...   # no API key, or the server rejected it
except AntibrowError:
    ...   # kernel download, unsupported platform, proxy, launch failure
```

`ApiError` covers the management calls in [Managing cloud
profiles](#managing-cloud-profiles) and carries `.status` — the HTTP status, or
`0` when the server could not be reached — so you can branch on it instead of
matching the message:

```python
try:
    profile = get_profile(api_key, name="shopper")
except ApiError as error:
    if error.status == 404:
        ...
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

### Moving a profile to another Chrome major

A profile's kernel is frozen when it is created, and the persona is what decides which kernel actually runs — so `launch(kernel_version=…)` cannot move an existing one. This can:

```python
from antibrow import set_profile_kernel_version

set_profile_kernel_version("151", profile_name="shopper-01")
```

Only the version-derived fields move. The seeds, GPU, screen and everything else stay put, so the site sees the same device on a newer Chrome rather than a brand new one behind the same cookies. It applies on the next launch, and refuses a version the kernel catalogue does not know instead of quietly leaving the profile where it was.

With cloud sync on, run it on the machine that used the profile last: `persona.json` travels in the archive, and a restore from the cloud brings back the version that archive was packed with.

### Android profiles

A profile can be a phone instead of a desktop - running on the same Windows, macOS or Linux machine, with no device farm and no remote hardware:

```python
browser = launch(profile="phone-01", device_type="android")
```

Everything a page can read is answered in the kernel, from one real device:

| Surface | Android profile reports |
|---|---|
| UA + client hints | `Mobile Safari` UA, `Sec-CH-UA-Mobile: ?1`, `Sec-CH-UA-Platform: "Android"`, real `model` and `platformVersion`, `formFactors: ["Mobile"]`, empty `architecture` / `bitness` |
| `navigator` | `platform` `"Linux armv81"`, `maxTouchPoints`, mobile core/memory counts, no plugins or mime types, `pdfViewerEnabled` false |
| Touch and layout | `ontouchstart`, `window.orientation`, portrait `screen.orientation`, `(pointer: coarse)` / `(hover: none)`, window sized to the device screen so `innerWidth == screen.width` on a viewport-meta page |
| GPU | mobile unmasked vendor/renderer plus the ETC/ASTC compressed-texture extensions a phone GPU actually exposes |
| Screen, audio, fonts, connection | drawn from that same device |

Three real phones ship inside the package, so a free-plan profile can be Android with nothing to download first. A whole device row is picked at once, never field by field - that is what keeps the screen, the GPU report and the client hints agreeing with each other.

```python
browser = launch(profile="phone-01", device_type="android")
print(browser.persona.android_model, browser.persona.android_os_major)
```

Two constraints:

- **The device type is frozen at creation**, inside `persona.json`. Passing `device_type` to an existing profile does nothing; create a new profile to switch.
- **Android needs kernel `151` or newer** - the first one carrying the mobile support. The newest qualifying kernel is chosen automatically for a new Android profile and installed for you; a profile pinned to an older kernel raises rather than starting a desktop kernel behind a phone's fingerprint. `antibrow.kernel_supports_android(version)` answers the same question directly, and `antibrow.android_capable_kernels()` lists what qualifies.

For a different real machine each time instead of the three bundled rows, add `real_fingerprint=True` (paid plans; it works for `device_type="desktop"` too, drawing a Windows machine). A free key is rejected by the server rather than quietly downgraded to a generated persona.

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

### Managed proxies

Proxies the service holds for you. Your code only ever sees an id — the exit
endpoint is resolved server-side and never reaches the machine running the
browser:

```python
from antibrow import launch, list_proxies, claim_managed_proxy

listing = list_proxies(api_key)
print(listing.quota.remaining, [p.id for p in listing.proxies])

proxy = claim_managed_proxy(api_key)
browser = launch("shopper", proxy_id=proxy.id)
```

A launch activates the proxy (that is what checks ownership and meters the
monthly quota), takes a **short-lived ticket**, and hands the kernel a
`relay://` URL built from it. Your API key is never on the kernel's command
line, and the ticket is handed back when the session closes.

`release_managed_proxy` returns one to the pool and `swap_managed_proxy` trades
it for another.

### Your own proxy library

Keep your own proxies on the server so every machine and the desktop app see the
same list:

```python
from antibrow import ProxyConfig, create_user_proxy, list_user_proxies

create_user_proxy(api_key, config=ProxyConfig(
    type="SOCKS5", host="gate.example.com", port=1080,
    username="u", password="p", label="US residential",
))
for proxy in list_user_proxies(api_key):
    print(proxy.id, proxy.config.label)
```

## Managing cloud profiles

Everything the dashboard can do to a cloud profile, this SDK can do too. These
are management calls: unlike the best-effort sync inside a launch, they raise
`ApiError` (which carries `.status`) when the server says no.

```python
from antibrow import (
    ProfileConfig, create_profile, get_or_create_profile,
    list_server_profiles, update_profile, delete_profile,
    get_profile_for_launch, get_account, launch,
)

account = get_account(api_key)
print(account.plan, f"{account.profile_count}/{account.profile_limit}")

get_or_create_profile(api_key, name="shopper", tags=["ads"],
                      config=ProfileConfig(group="ads", label="Shopper"))

for profile in list_server_profiles(api_key):
    print(profile.name, profile.updated_at)

update_profile(api_key, id="shopper", config=ProfileConfig(note="daily run"))
delete_profile(api_key, name="shopper")
```

`get_profile_for_launch` resolves a cloud profile into launch arguments,
following its proxy reference for you:

```python
target = get_profile_for_launch(api_key, name="shopper")
browser = launch(target.profile, proxy_id=target.proxy_id, proxy=target.proxy)
```

Pass `since=` to `sync_pull_profiles` for a delta: it returns the changes plus
the server's clock to use as the next `since`, and deleted profiles come back
carrying `deleted_at` so your own copy can follow.

### Cookies and storage as plain values

The profile archive is the browser's own binary state. `ProfileState` is the
portable version — cookies and `localStorage` you can read, edit, and replay:

```python
from antibrow import ProfileStateCookie, upload_profile_state, download_profile_state

upload_profile_state(api_key, name="shopper", cookies=[
    ProfileStateCookie(name="sid", value="…", domain=".example.com"),
])

state = download_profile_state(api_key, name="shopper")   # None if never uploaded
```

## Live View

Watch a running profile from your dashboard. The kernel produces a JPEG
screencast and the SDK forwards it to the relay over one WebSocket; nothing
drives the browser, it is a one-way copy of what the window already shows.

```bash
pip install "antibrow[liveview]"
```

```python
from antibrow import launch, LiveViewOptions

browser = launch("shopper", live_view=True)
print(browser.live_view.view_url)          # open this to watch

# or spend less bandwidth
browser = launch("shopper", live_view=LiveViewOptions(quality=40, every_nth_frame=4))
```

The stream stops and the session is released on `close()`. A live view that
cannot be registered or connected is reported through `on_progress` and the
browser runs anyway — a browser you cannot watch still works.

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

## Running automation at scale

Automation tends to mint a profile per task. Pass `temporary=True` so those
profiles land in their own directory tree, out of the way of the profiles you
actually manage:

```python
from antibrow import launch, clear_temporary_profiles

for task in tasks:
    browser = launch(f"task-{task.id}", temporary=True)
    page = browser.new_page()
    page.goto(task.url)
    browser.close()

# Temporary profiles are never deleted for you.
removed = clear_temporary_profiles(older_than_days=7)
print(f"removed {len(removed)} temporary profiles")
```

Three things to know:

- **They do not show up in the desktop app.** The desktop app only reads the
  managed tree, so a temporary profile is invisible to it.
- **The two trees are separate namespaces.** A temporary `gmail` and a managed
  `gmail` are two different profiles with their own identity and cookies.
- **Nothing is deleted automatically.** A temporary profile keeps its identity
  and its logins for as long as you leave it on disk, which is what makes it
  reusable. Clear them yourself with `clear_temporary_profiles()` or
  `python -m antibrow clear-temp --older-than=7`.

Per launch, `temporary=False` puts one profile back in the managed tree.

### Cloud sync

A launch never creates a cloud profile on its own. By default a profile syncs
only when the server already knows the name, so an automation run cannot fill
your sync quota with profiles you never meant to keep. To put a new profile in
the cloud, ask for it:

```python
launch("main-account", sync=True)    # create + sync
launch("main-account", sync=False)   # stay local
```

`sync=True` and `temporary=True` are mutually exclusive; passing both raises.
`sync=True` also raises when your plan does not include cloud sync.

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

Use one volume per architecture. Kernels are keyed by version, not by CPU (`<cache_dir>/kernels/<version>/`), so a volume shared between an amd64 host and an arm64 host hands the wrong binary to whichever one downloads second. An ARM instance is otherwise a normal target here rather than a workaround: if the rest of your fleet already runs on ARM, nothing forces you to keep an x86 machine around for the browser.

## CLI

```bash
python -m antibrow install [--version 151] [--force]              # get the kernel
python -m antibrow info                                           # kernels, profiles, license
python -m antibrow login [--key ab_live_…]                        # store an API key
python -m antibrow clear-temp [--older-than 7] [--dry-run]        # delete temporary profiles
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

### Cloud profile sync

On a paid plan a launch restores the profile before starting and saves it again on
`close()`, so the next machine opens the same cookies, storage, history and
passkeys. It is on by default there and needs no extra code:

```python
from antibrow import launch

browser = launch(profile="shopper-01")   # restored from the cloud
...
browser.close()                          # saved back
if browser.sync_error:
    print("not saved:", browser.sync_error)
```

Watch the transfers with `on_sync=`, or keep a launch local with `sync=False`.
Sync problems never fail a launch: the local profile directory is always usable.

Profiles also move by file. `export_profile_archive()` writes a `.fpprofile`
(identity, browser state, passkey store) that `import_profile_archive()` reads
back, on this SDK or the desktop app:

```python
from antibrow import PortableProfileMeta, export_profile_archive, import_profile_archive, profile_dir

data = export_profile_archive(profile_dir("shopper-01"), PortableProfileMeta(name="shopper-01"))
open("shopper-01.fpprofile", "wb").write(data)          # export with the browser closed

meta = import_profile_archive(data, profile_dir("shopper-02"))
```

An encrypted profile is converted on a temporary copy first, so the archive opens
without a key; that needs the profile's own key and kernel, so pass
`api_key=`/`server=` and `cache_dir=`. The original directory is never touched,
and if the conversion did not happen the export aborts rather than write a file
nobody can open. A bound proxy url travels in the archive in full, password
included - whoever you hand the file to gets that credential too.

Live View remains Node-SDK and desktop only.

## FAQ

**Do I need `playwright install`?**
No. antibrow downloads and drives its own kernel. The `playwright` pip package is required for its client library, but its bundled browsers are never used.

**Does it work without an API key?**
No. The license check is compiled into the kernel binary. A free key is at [antibrow.com](https://antibrow.com), and one token covers a whole day of relaunches.

**Where does my data go?**
Profiles never leave your machine in this package. The only outbound calls are: the kernel download (`download.antibrow.com`), the token exchange (`antibrow.com`), and — only when `geoip=True` — one request to `ip-api.com` to read the exit timezone (**through your proxy** when one is set, otherwise direct).

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

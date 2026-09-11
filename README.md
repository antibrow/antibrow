<p align="center">
  <strong>AntiBrow</strong><br>
  <em>The antidetect browser your AI agent can drive.</em>
</p>

**English** | [Русский](README.ru.md)

<p align="center">
  <a href="https://pypi.org/project/antibrow/"><img src="https://img.shields.io/pypi/v/antibrow" alt="PyPI"></a>
  <a href="https://www.npmjs.com/package/anti-detect-browser"><img src="https://img.shields.io/npm/v/anti-detect-browser" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/SDK%20license-MIT-blue" alt="MIT"></a>
  <a href="https://antibrow.com"><img src="https://img.shields.io/badge/site-antibrow.com-111" alt="Website"></a>
</p>

---

Kernel-level fingerprint spoofing, driven by the **standard Playwright API you already
write**. Every profile carries a coherent real-device fingerprint — canvas, WebGL, WebGPU,
audio, fonts, WebRTC and the protocol layer all agree, because they were sampled from one
real machine rather than randomized independently.

This repository holds the **open-source SDKs**. See [Licensing](#licensing) for what is and
isn't open.

```
python/   →  PyPI: antibrow
js/       →  npm:  anti-detect-browser
```

## Install

**Python**

```bash
pip install antibrow
```

```python
from antibrow import launch

browser = launch()                      # engine downloads on first run
page = browser.new_page()
page.goto("https://example.com")
browser.close()
```

**JavaScript / TypeScript**

```bash
npm install anti-detect-browser playwright-core
```

```js
import { openProfile } from 'anti-detect-browser'

const session = await openProfile({ key: process.env.ANTIBROW_KEY, profileName: 'default' })
const page = await session.context.newPage()
await page.goto('https://example.com')
await session.close()
```

Both SDKs speak the same on-disk format: a profile created by one is launchable by the
other, with the identical fingerprint.

## What you get

- **Engine-level spoofing, not JS injection.** Fingerprints are produced inside Chromium's
  C++ layer, so there are no `toString` / prototype / stack-trace tells for a detector to
  find.
- **Coherent real-device profiles.** 30+ categories, 500+ parameters, all drawn from the
  same real machine. Randomized values contradict each other; these don't.
- **Android profiles on a desktop machine.** `device_type="android"` (`deviceType: 'android'`
  in JS) gives a profile a real phone's identity - mobile client hints, touch input, portrait
  screen, mobile GPU - with no device farm and no remote hardware. Real phones ship inside
  both packages, so it works on the free tier.
- **Timezone and locale follow the proxy.** Pass a proxy and the exit IP's geo is resolved
  and written into the fingerprint before launch.
- **Proxy auth handled in the engine.** `http` / `https` / `socks5` credentials go inline on
  `--proxy-server`; the engine answers the challenge itself. No helper extension is loaded,
  so nothing shows up in `chrome://extensions`.
- **An encrypted relay with no proxy-protocol signature.** `relay://…?key=` is spoken
  natively by the engine over a single WebSocket, with every frame sealed under
  AES-256-GCM - no plaintext CONNECT line, no SOCKS5 handshake, no local forwarder process.
  The relay server is MIT-licensed and self-hostable. See below.
- **Persistent identities.** Cookies, storage and passkeys survive restarts — warm an
  account once and it stays warm.
- **Passkeys captured and replayed.** Each profile carries its own virtual authenticator, so
  a passkey a site enrols is kept in the profile's own store and replayed on the next
  sign-in. On by default; it travels with a sync or an export.
- **Portable profiles.** Export a profile - identity, browser state and passkey store - to a
  single `.fpprofile` file and import it on another machine or hand it to someone else.
  Cloud sync moves the same payload for you, per profile, when you turn it on.
- **Standard Playwright.** You get a normal `BrowserContext` over CDP. No proprietary API to
  learn, and existing scripts port over by changing how the browser is launched.
- **MCP server mode**, so an AI agent can drive a profile directly.
- **Recipes: task-level site adapters.** Ask for `reddit/hot` and get JSON, instead of a
  browser handle and a scraping problem. See below.

## Recipes

One command per site, published in a separate repository
([antibrow/recipes](https://github.com/antibrow/recipes)) and shared by both SDKs, so
adding a site is a pull request there rather than a release here.

```bash
anti-detect-browser recipe run google/search --profile shopper-01 --jq '.items[].title'
anti-detect-browser recipe fanout amazon/search --profiles 'shopper-*' --concurrency 4
```

```python
from antibrow import run_recipe, fanout_recipe

print(run_recipe("reddit/hot", temporary=True, args={"limit": 5}).value)
```

Covered today: Google, Amazon, Walmart, Reddit, X, Medium, Yelp, Indeed, Hacker News,
DuckDuckGo, GitHub, PyPI, npm, plus exit-IP and fingerprint checks. Several of those answer
a plain scraper with a captcha, which is the point: a recipe runs inside a profile with its
own identity and its own exit IP, and `fanout` runs the same command on N of them at once.
Recipes are pinned by SHA-256, only reviewed ones run by default, and each one may only
reach the hosts it declares - a request to any other host is blocked.

**Want a platform that is not there yet?** Sites behind Cloudflare, DataDome, PerimeterX or
Akamai are the ones this layer exists for. Open an issue on the recipes repo, or write one
from its `GUIDE.md` - the format is a single file with no dependencies.

## Encrypted relay

`relay://` is a transport both SDKs accept wherever a proxy URL goes. SOCKS5 and HTTP
CONNECT put a fixed, recognizable handshake on the wire before any of your traffic moves;
this one doesn't. The engine opens a single WebSocket to the relay and speaks an
AEAD-sealed frame protocol inside it - keys derived per connection with HKDF-SHA256, each
frame sealed with AES-256-GCM under a counter nonce - so there is no plaintext CONNECT
line, no SOCKS5 handshake and no fixed-length header to match on. The target hostname
travels inside the sealed frame.

```js
const browser = await new AntiDetectBrowser({ apiKey }).launch({
  proxy: 'relay://alice:s3cret@relay.yourdomain.com?key=<relay key>',
})
```

```python
browser = launch(proxy="relay://alice:s3cret@relay.yourdomain.com?key=<relay key>")
```

`?key=` is the relay's 32-byte base64url pre-shared key, and it is what selects the
encrypted protocol - both here and in the exit-IP lookup the SDK runs before launch, so
timezone and WebRTC follow the relay's exit. Leave it out and the URL means the older
plaintext protocol instead, which a relay serves only if its operator turned it on; a
malformed key is refused rather than downgraded.

There is no local forwarder process and no extension - the engine speaks the protocol
itself, and the credential never reaches the page's renderer process.

The relay server is a separate MIT-licensed project
([antibrow/relay](https://github.com/antibrow/relay)) and is meant to be self-hosted on a
domain you control: `npx antibrow-relay keygen` prints the deployment's pre-shared key,
then deploy it as a Cloudflare Worker or run it as a plain Node process and create an
upstream and an account at `/admin`. The account credential is what goes in the URL above.
A hosted one runs at <https://bastion.antibrow.com/>.

Two limits worth knowing: a device running TLS inspection sees the WebSocket upgrade and
the sealed frames under it (it still finds no proxy-protocol signature, but it sees more
than a passive observer does), and domain-category filtering blocks a hostname before any
protocol is inspected - which is the reason to host on your own domain rather than a shared
default. The frame format, key schedule and threat model are in the
[whitepaper](https://antibrow.com/relay/whitepaper).

## Docs and examples

| | |
|---|---|
| Python API, options, CLI | [`python/README.md`](python/README.md) |
| JavaScript API | [`js/README.md`](js/README.md) |
| Runnable examples (Playwright, browser-use, crawl4ai, Scrapling, MCP, Docker) | [`python/examples/`](python/examples/) |

## Platforms

Windows x64, macOS (universal) and Linux x64 / arm64.

## Licensing

Read this before you build on it — the SDK and the engine have **different licenses**.

- **The SDKs in this repository are MIT** ([`LICENSE`](LICENSE)). Use them anywhere,
  including commercially.
- **The browser engine is a closed-source binary** distributed separately, under
  [`BINARY-LICENSE.md`](BINARY-LICENSE.md). In short: you may use it for your own work,
  including commercial work, at any company size — but you may not redistribute, resell,
  repackage or embed it, and exposing it to third-party customers (bundled, hosted, or
  behind your own API) needs a separate OEM/SaaS license.
- **Listing these packages as a dependency is not redistribution**, because the engine is
  downloaded from official AntiBrow channels on the user's own machine.

`BINARY-LICENSE.md` is the authoritative text; the summary above is not a substitute for it.

## Acceptable use

Automating systems without authorization, credential stuffing and bulk account-creation
abuse are prohibited. You are responsible for complying with the terms of the sites you
automate and with the law in your jurisdiction.

## Links

- Website — <https://antibrow.com>
- Documentation — <https://antibrow.com/docs>
- Encrypted relay — <https://antibrow.com/relay> · [antibrow/relay](https://github.com/antibrow/relay)
- Issues — <https://github.com/antibrow/antibrow/issues>

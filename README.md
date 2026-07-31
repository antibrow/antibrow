<p align="center">
  <strong>AntiBrow</strong><br>
  <em>The antidetect browser your AI agent can drive.</em>
</p>

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
- **Timezone and locale follow the proxy.** Pass a proxy and the exit IP's geo is resolved
  and written into the fingerprint before launch.
- **Proxy auth handled in the engine.** `http` / `https` / `socks5` credentials go inline on
  `--proxy-server`; the kernel answers the challenge itself. No helper extension is loaded,
  so nothing shows up in `chrome://extensions`.
- **Persistent identities.** Cookies, storage and passkeys survive restarts — warm an
  account once and it stays warm.
- **Standard Playwright.** You get a normal `BrowserContext` over CDP. No proprietary API to
  learn, and existing scripts port over by changing how the browser is launched.
- **MCP server mode**, so an AI agent can drive a profile directly.

## Docs and examples

| | |
|---|---|
| Python API, options, CLI | [`python/README.md`](python/README.md) |
| JavaScript API | [`js/README.md`](js/README.md) |
| Runnable examples (Playwright, browser-use, crawl4ai, Scrapling, MCP, Docker) | [`python/examples/`](python/examples/) |

## Platforms

Windows x64, macOS (universal) and Linux x64.

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
- Issues — <https://github.com/antibrow/antibrow/issues>

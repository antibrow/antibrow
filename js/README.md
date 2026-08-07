![AntiBrow](https://antibrow.com/AntiBrow-mark.svg)

# anti-detect-browser

**The antidetect browser your AI agent can drive.**

Kernel-level fingerprint spoofing · **unlimited local profiles, free** · standard Playwright API · built-in MCP server.

[![npm version](https://img.shields.io/npm/v/anti-detect-browser?color=6366f1&label=npm)](https://www.npmjs.com/package/anti-detect-browser)
[![node](https://img.shields.io/badge/node-%E2%89%A518-3c873a)](https://nodejs.org)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6366f1)
![MCP ready](https://img.shields.io/badge/agent-MCP%20ready-a855f7)
![license](https://img.shields.io/badge/license-MIT-444)

---

Give your automation — or your AI agent — a real browser the web **can't tell apart from a human**. Real-device fingerprints spoofed at the kernel, driven by the Playwright API you already write.

## Why anti-detect-browser

### Local-first, and free

Create **unlimited browser profiles on your own machine — free, forever.** No per-profile fees, no per-seat pricing. Every profile is a fully isolated identity — its own real-device fingerprint, cookies, storage and proxy — persisted on disk and restored byte-for-byte on the next launch. Name a profile and it exists; there's nothing to provision.

### Agent-ready out of the box

Ships as an **MCP server** — one line (`npx anti-detect-browser --mcp`) drops a fully fingerprinted browser into Claude or any MCP client, so your agent can navigate, click, type, read and screenshot the real web. Prefer code? `launch()` returns a standard Playwright `BrowserContext` and `Page`, so your existing scripts work unchanged — only the launch line differs.

### Technically ahead

Fingerprints are spoofed at the **kernel level** (a custom Chromium 149 runtime), not with fragile JavaScript patches that anti-bot systems flag on sight. Signals stay **coherent** across Canvas, WebGL, WebGPU, fonts, audio, `navigator`, screen and timezone — nothing contradicts, because it's a real device profile, not randomized noise. Timezone and geolocation **follow your proxy** automatically.

### Authenticated proxies, with nothing loaded to make them work

Pass `http://`, `https://` or **`socks5://user:pass@host:port`** and the credentials are answered **inside the engine** — HTTP/HTTPS `407` challenges in the network stack, SOCKS5 by RFC 1929 username/password negotiation. No helper extension is installed, so `chrome://extensions` stays empty; the proxy-auth extension most antidetect browsers still ship is enumerable from any page and is itself a tell. Credentials reach the network process only, never a renderer.

## Proof it works

Real residential exit, `Proxy: No`, 90% disguise on whoer.net — and a clean run through CreepJS:

![whoer.net result](https://antibrow.com/proof/whoer.png)
![CreepJS result](https://antibrow.com/proof/creepjs.png)

## Quick start

```bash
npm install anti-detect-browser
```

Get an API key from the dashboard at [antibrow.com](https://antibrow.com), then:

```ts
import { AntiDetectBrowser } from 'anti-detect-browser'

const ab = new AntiDetectBrowser({ key: process.env.ANTI_DETECT_BROWSER_KEY })

// Unlimited local profiles — just name one. It's created on disk on first use.
const { page, browser } = await ab.launch({ profile: 'shopper-01' })

await page.goto('https://whoer.net')      // standard Playwright from here on
console.log(await page.title())
await browser.close()
```

With a managed residential proxy (timezone & geo follow it) and a visual label:

```ts
const { page } = await ab.launch({
  profile: 'shopper-02',
  proxyId: 'px_xxxxxxxx',   // managed residential proxy — activated + injected for you
  label: 'acct@shop.com',   // floating tag + window title, so windows are tellable apart
  color: '#6366f1',
})
```

`launch()` resolves to `{ browser, context, page, profileDir }` — `context` and `page` are the real Playwright objects.

## Keeping the browser kernel up to date

The fingerprint browser kernel ships new builds over time (fresh Chrome majors, spoofing fixes). Installed kernels are cached and **never swapped under you** — you decide when to update.

```ts
// Any installed kernel have a newer build published?
if (await ab.hasKernelUpdate()) {
  const updated = await ab.updateKernel()   // pull the newer build(s)
  console.log('updated kernels:', updated)  // → ['150.0.7871.182']
}

// Or inspect per-version detail
const status = await ab.checkKernelUpdates()
// [{ version, label, installed, installedBuild, availableBuild, updateAvailable }]

// Update just one version, with progress
await ab.updateKernel('150.0.7871.182', msg => console.log(msg))
```

Even without that, `launch()` quietly checks (once per process, in the background) and prints a one-line notice if a newer kernel build exists — so you'll know, without it ever updating behind your back or slowing the launch:

```
[anti-detect-browser] A newer browser kernel build is available for: Chrome 150. Run browser.updateKernel() to update now, or launch with { updateKernelBeforeLaunch: true }.
```

Prefer it hands-off? Let `launch()` check **and update** the profile's kernel before it starts — **off by default**:

```ts
await ab.launch({
  profile: 'shopper-01',
  updateKernelBeforeLaunch: true,   // default false — when true, updates then launches (no notice)
})
```

If the machine is offline the check is skipped silently and the browser launches with the installed kernel — updates never block a launch. (The notice goes to stdout; the MCP server routes it to stderr to keep the JSON-RPC channel clean.)

## Use it from an AI agent (MCP)

Add it to your MCP client config and your agent gets a stealth browser:

```json
{
  "mcpServers": {
    "anti-detect-browser": {
      "command": "npx",
      "args": ["anti-detect-browser", "--mcp"],
      "env": { "ANTI_DETECT_BROWSER_KEY": "your-api-key" }
    }
  }
}
```

**Tools:** `launch_browser`, `navigate`, `click`, `fill`, `screenshot`, `evaluate`, `get_content`, `list_profiles`, `create_profile`, `list_proxies`, `claim_proxy`, `start_live_view`, and more.

## What you get

| Feature | |
|---|---|
| **Real-device fingerprints** | Kernel-level spoofing, coherent across Canvas / WebGL / WebGPU / fonts / audio / timezone |
| **Unlimited local profiles** | Free on every plan — isolated, persistent, no per-profile cost |
| **Standard Playwright API** | `launch()` returns real `BrowserContext` / `Page` — zero to learn |
| **Self-updating kernel** | Detect new browser-kernel builds and pull them on demand, or check-and-update before launch |
| **Built-in MCP server** | Drive it from Claude or any MCP agent, no glue code |
| **Managed residential proxies** | One `proxyId`; the exit IP, timezone and geo all line up |
| **Authenticated HTTP/SOCKS5** | Credentials answered in the engine (`407` / RFC 1929) — no proxy-auth extension to enumerate |
| **Live View** | Stream a running session to your dashboard in real time |
| **Cloud profile sync** | Roam a profile (identity + state) across machines |
| **Concurrency by plan** | Kernel-enforced simultaneous-browser cap |

Managed proxies, Live View and cloud sync are on the paid plans. Local profiles and the full fingerprint engine are free.

## Concurrency & plans

Local profiles are unlimited on every plan. How many browsers you run **at once** scales with your plan (enforced by the kernel):

| Plan | Local profiles | Concurrent browsers | Cloud sync | Proxies |
|------|:---:|:---:|:---:|:---:|
| Free | unlimited | 1 | no | no |
| Basic | unlimited | 5 | yes | yes |
| Pro | unlimited | 20 | yes | yes |
| Team | unlimited | 100 | yes | yes |

See [antibrow.com/pricing](https://antibrow.com/pricing).

## Requirements

- Node.js >= 18
- Windows x64, macOS (universal) or Linux x64 / arm64
- `playwright-core` (peer dependency)

## Links

- Docs — [antibrow.com/docs/sdk](https://antibrow.com/docs/sdk)
- Dashboard / API key — [antibrow.com](https://antibrow.com)
- Pricing — [antibrow.com/pricing](https://antibrow.com/pricing)

## License

MIT

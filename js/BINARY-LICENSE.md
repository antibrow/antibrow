# AntiBrow Browser Kernel — Binary License

**Status: DRAFT. Not yet reviewed by counsel. Subject to change before 1.0.**
For anything commercially load-bearing, confirm with legal@antibrow.com first.

---

## 1. Two things, two licenses

This repository contains a **wrapper**. It does not contain a browser.

| | What it is | License |
|---|---|---|
| **This repository / the `antibrow` PyPI package** | Python source: launcher, CLI, persona and fp-config serialization, examples, docs | **MIT** — see [LICENSE](LICENSE) |
| **The AntiBrow browser kernel** (`fp-chromium-*.zip`, `chrome.exe` / `chrome`) | A closed-source Chromium derivative with AntiBrow's fingerprint engine | **Proprietary** — this document |

The kernel is **not** in this repository, **not** in the PyPI package, and **not** in any release artifact published from this repository. It is downloaded at runtime, by the end user, from AntiBrow's own distribution endpoint (`https://download.antibrow.com/`), onto that end user's machine.

## 2. What you may do with the kernel

Subject to a valid AntiBrow license (including the free tier), you may:

- **download and run** the kernel on machines you control, or that you operate on behalf of your own organisation;
- use it for **internal purposes** without any additional agreement — your own automation, your own scraping, your own QA, your own account operations, whether or not that work is commercial;
- run it in **your own CI, containers and cloud instances**, provided each running instance is covered by your license's concurrency entitlement;
- **depend on this package** in software you publish, including commercial software (see §4).

No separate agreement is needed for any of the above.

## 3. What you may not do with the kernel

Without a written OEM/SaaS agreement from AntiBrow, you may **not**:

- **redistribute** the kernel binary — no mirroring, no re-hosting, no bundling it into your installer, image, wheel, npm package, extension or ZIP;
- **resell** it, or sell access to it, as a product or as part of one;
- **repackage or rebrand** it, including shipping it under another name or embedding it in another browser product;
- **expose it to third parties as a service** — for example, offering "browser sessions", "stealth browsing", "scraping API" or "agent browser infrastructure" to your own customers, where their traffic runs through kernels you operate;
- **circumvent the license check**, including patching the binary, forging or replaying license tokens, or otherwise defeating the concurrency enforcement;
- **reverse engineer, decompile or disassemble** the kernel, except to the extent that right cannot lawfully be excluded in your jurisdiction.

## 4. Depending on this package is not redistribution

**This is the key point, so it is stated plainly:**

> Listing `antibrow` as a dependency of your project — in `pyproject.toml`, `requirements.txt`, a lockfile, a Dockerfile, or anywhere else — **does not make you a redistributor of the browser kernel**, because you are not distributing the kernel. Your users obtain the kernel themselves, directly from AntiBrow's official distribution endpoint, at first run on their own machine, under their own AntiBrow license.

Concretely:

| Scenario | Redistribution? | Extra license needed? |
|---|---|---|
| Your open-source tool lists `antibrow` as a dependency | No | No |
| Your commercial CLI installs `antibrow` from PyPI at install time | No | No — each user brings their own key |
| Your Dockerfile runs `pip install antibrow` and the image pulls the kernel **at container start** | No | No |
| Your Docker image ships with the kernel **already baked in** and is published publicly | **Yes** | Yes — contact us |
| You mirror `fp-chromium-*.zip` to your own CDN, S3 bucket or artifact registry | **Yes** | Yes — contact us |
| You run a SaaS where **your customers'** automation drives kernels you host | Not redistribution, but §3 | Yes — OEM/SaaS agreement |

The line is simple: **who downloads the binary, and from where.** If it is the end user, from us, you are fine. If it is you, and you hand it onward, that is redistribution.

## 5. Internal use vs. serving third parties

- **Internal use** — the kernel is driven by you, your employees, your contractors, or your own automated systems, for your organisation's own purposes. Covered by an ordinary AntiBrow license, including the free tier. Being paid by a client for the work product (e.g. delivering scraped data) does not by itself make it third-party use.
- **Third-party use** — the kernel is driven, directly or indirectly, by someone who is not licensed by AntiBrow: your customers, your users, or an API you expose to them. Requires an **OEM/SaaS agreement**. Pricing is per-deployment; contact partners@antibrow.com.

If you are unsure which side you are on, the question to ask is: *if AntiBrow suspended my license today, whose product would stop working — mine, or my customers'?*

## 6. License enforcement in the binary

The kernel verifies a short-lived, Ed25519-signed license token on startup (`--fp-license`) and refuses to start without a valid one. The signing key is held only by AntiBrow's server; this package never signs tokens and contains no key material. The token also carries a concurrency cap, which the kernel enforces across processes.

This is a licensing control, not a security boundary, and it is not a warranty that any given site cannot detect the browser.

## 7. No warranty

The kernel is provided "AS IS", without warranty of any kind. AntiBrow does not warrant that it will remain undetected by any particular website, anti-bot vendor or detection technique. Nothing here is a promise about the legality of what you do with it — that is on you.

## 8. Acceptable use

The kernel may not be used for fraud, credential stuffing, unauthorised access to accounts you do not own, distribution of malware, harassment, or any activity unlawful where you operate. AntiBrow may terminate a license for such use.

## 9. Termination

This license terminates automatically if you breach §3 or §8. On termination you must stop running the kernel and delete your copies. §7 and §8 survive.

## 10. Questions

- Licensing and OEM/SaaS: **partners@antibrow.com**
- Legal: **legal@antibrow.com**
- Everything else: [antibrow.com](https://antibrow.com)

---

*Draft revision 2026-07-28. Terms may change; the version accompanying the kernel build you run is the one that applies.*

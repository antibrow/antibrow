# AntiBrow Browser Kernel - Binary License

**This document is at revision 2026-08-14 and may be updated. OEM agreements (§10) are executed as separate written contracts and are not affected by revisions to this document.**

---

## 1. Two things, two licenses

This repository contains a **wrapper**. It does not contain a browser.

| | What it is | License |
|---|---|---|
| **This repository / the `anti-detect-browser` npm and `antibrow` PyPI packages** | SDK source: launcher, CLI, persona and fp-config serialization, examples, docs | **MIT** - see [LICENSE](LICENSE) |
| **The AntiBrow browser kernel** (`fp-chromium-*.zip`, `chrome.exe` / `chrome`) | A closed-source Chromium derivative with AntiBrow's fingerprint engine | **Proprietary** - this document |
| **The kernel, redistributed or served to your customers** | Same binary, different rights | **OEM agreement** - see §10 |

The kernel is **not** in this repository, **not** in the published packages, and **not** in any release artifact published from this repository. It is downloaded at runtime, by the end user, from AntiBrow's own distribution endpoint (`https://download.antibrow.com/`), onto that end user's machine.

## 2. What you may do with the kernel

Subject to a valid AntiBrow license (including the free tier), you may:

- **download and run** the kernel on machines you control, or that you operate on behalf of your own organisation;
- use it for **internal purposes** without any additional agreement - your own automation, your own scraping, your own QA, your own account operations, whether or not that work is commercial;
- run it in **your own CI, containers and cloud instances**, provided each running instance is covered by your license's concurrency entitlement;
- **depend on this package** in software you publish, including commercial software (see §4).

No separate agreement is needed for any of the above.

## 3. What needs an agreement, and what is never permitted

Two different lists. The first is a product: these are things we license, and the terms are in §10. The second is not negotiable under any agreement.

### 3.1 Commercial uses that an OEM agreement unlocks

These are **not prohibited** - they are the things our OEM program exists to license. Doing them without a written agreement is a breach; asking us about them is a normal sales conversation. See **§10**.

- **Redistributing the kernel binary** - mirroring it, re-hosting it, or bundling it into your own installer, container image, wheel, npm package, extension or ZIP.
- **Baking the kernel into a published image** so your users never contact our distribution endpoint.
- **Serving third parties** - offering browser sessions, stealth browsing, a scraping API, or agent browser infrastructure to your own customers, where their traffic runs through kernels you operate.
- **Reselling** the kernel, or selling access to it, as a product or as part of one.
- **Shipping it under your own name** - rebranding, repackaging, or embedding it in another browser or browser-based product.

We license all five. Concurrency-based pricing, annual commitment, and the technical accommodations in §6 and §10 apply. Contact **partners@antibrow.com**.

### 3.2 Never permitted, with or without an agreement

- **Circumventing the license check** - patching the binary, forging or replaying license tokens, or otherwise defeating concurrency enforcement.
- **Reverse engineering, decompiling or disassembling** the kernel, except to the extent that right cannot lawfully be excluded in your jurisdiction.
- Anything in §8 (Acceptable use).

## 4. Depending on this package is not redistribution

**This is the key point, so it is stated plainly:**

> Listing `anti-detect-browser` or `antibrow` as a dependency of your project - in `package.json`, `pyproject.toml`, `requirements.txt`, a lockfile, a Dockerfile, or anywhere else - **does not make you a redistributor of the browser kernel**, because you are not distributing the kernel. Your users obtain the kernel themselves, directly from AntiBrow's official distribution endpoint, at first run on their own machine, under their own AntiBrow license.

Concretely:

| Scenario | Redistribution? | Extra license needed? |
|---|---|---|
| Your open-source tool lists the SDK as a dependency | No | No |
| Your commercial CLI installs the SDK from npm or PyPI at install time | No | No - each user brings their own key |
| Your Dockerfile installs the SDK and the image pulls the kernel **at container start** | No | No |
| Your Docker image ships with the kernel **already baked in** and is published publicly | **Yes** | Yes - **this is a standard OEM grant, see §10** |
| You mirror `fp-chromium-*.zip` to your own CDN, S3 bucket or artifact registry | **Yes** | Yes - **standard OEM grant, see §10** |
| You run a SaaS where **your customers'** automation drives kernels you host | Not redistribution, but §3.1 | Yes - **this is the main OEM use case, see §10** |

The line is simple: **who downloads the binary, and from where.** If it is the end user, from us, you are fine. If it is you, and you hand it onward, that is redistribution.

Note that the last three rows are not edge cases we tolerate - they are the three things the OEM program is designed to license. Baked-in images in particular are the default grant, not an exception: we know that pulling a Chromium archive at container start is not viable for anything with a cold start budget.

## 5. Internal use vs. serving third parties

- **Internal use** - the kernel is driven by you, your employees, your contractors, or your own automated systems, for your organisation's own purposes. Covered by an ordinary AntiBrow license, including the free tier. Being paid by a client for the work product (e.g. delivering scraped data) does not by itself make it third-party use.
- **Third-party use** - the kernel is driven, directly or indirectly, by someone who is not licensed by AntiBrow: your customers, your users, or an API you expose to them. Requires an **OEM agreement**. Pricing is per-deployment; contact partners@antibrow.com.

If you are unsure which side you are on, the question to ask is: *if AntiBrow suspended my license today, whose product would stop working - mine, or my customers'?*

If the answer is "my customers'", you want §10 - and you will also want §6.2, which is there precisely so that the answer becomes "neither".

## 6. License enforcement in the binary

### 6.1 Default behaviour

The kernel verifies a short-lived, Ed25519-signed license token on startup (`--fp-license`) and refuses to start without a valid one. The signing key is held only by AntiBrow's server; this package never signs tokens and contains no key material. The token also carries a concurrency cap, which the kernel enforces across processes.

This is a licensing control, not a security boundary, and it is not a warranty that any given site cannot detect the browser.

### 6.2 Offline and long-lived tokens (OEM)

Under an OEM agreement (§10), licensing is provisioned to suit your deployment. Long-lived, offline-verifiable tokens and air-gapped issuance are provided as contractual terms of that agreement; the specific validity period and delivery mechanism are agreed per deal.

### 6.3 Continuity (OEM)

An OEM agreement also fixes what happens when AntiBrow's licensing endpoint is unreachable: a grace period during which already-licensed deployments keep starting on their last valid token, with its length agreed per deal. Outside such an agreement, §6.1 applies as written - a valid token must be obtainable at or before startup.

## 7. No warranty

The kernel is provided "AS IS", without warranty of any kind. AntiBrow does not warrant that it will remain undetected by any particular website, anti-bot vendor or detection technique. Nothing here is a promise about the legality of what you do with it - that is on you.

Under an OEM agreement (§10), update cadence and detection-regression response are contractual and supersede this section to the extent stated in that agreement. This section continues to apply to everyone else.

## 8. Acceptable use

The kernel may not be used for fraud, credential stuffing, unauthorised access to accounts you do not own, distribution of malware, harassment, or any activity unlawful where you operate. AntiBrow may terminate a license for such use.

## 9. Termination

This license terminates automatically if you breach §3 or §8. On termination you must stop running the kernel and delete your copies. §7 and §8 survive.

## 10. OEM & Embedding Program

If your product needs the kernel to be *yours* - shipped in your image, called by your customers, or running under your brand - that is what this program is for. It is a standard, repeatable agreement, not a one-off exception.

### 10.1 What an OEM agreement grants

Selected per deal; all of these are on the table:

| Grant | What it means |
|---|---|
| **Redistribution** | Ship the kernel inside your installer, container image or artifact registry. Your users never touch our download endpoint. |
| **Third-party serving** | Your customers' automation drives kernels you operate, under your own license terms with them. |
| **Rebranding** | Ship it under your product name. Binary strings, process name, user-agent product token and update endpoint can be customised. |
| **Version pinning** | Freeze on a specific kernel build for the term, with an agreed migration window. You are not forced onto our release train. |
| **Source escrow** | Available on annual commitments above an agreed threshold. Release triggers: our insolvency, or discontinuation of the kernel. |

### 10.2 What comes with it

- **Offline licensing.** Long-lived, offline-verifiable tokens (see §6.2). No runtime call to our servers is required for your product to start.
- **Air-gapped deployment.** Supported. Token issuance is out-of-band.
- **Update cadence commitment.** A contractual maximum lag behind upstream Chromium stable, and a contractual response window for detection regressions on named target sites.
- **Named technical contact** and a private issue channel.
- **Detection evidence.** The reproducible detection runs we publish at antibrow.com/reports, plus per-deal runs against the sites you actually care about, as pre-sales and acceptance material.

### 10.3 What we ask in return

- **Concurrency-based pricing** with an annual minimum commitment. Pricing is per deployment; contact us for current rates.
- **Attribution is optional.** No "powered by" requirement.
- **Acceptable use flows down.** Your agreement with your customers must carry §8 forward.
- **No sublicensing of the redistribution right** beyond your own product.

### 10.4 Where we compete, stated plainly

AntiBrow operates its own end-user product at antibrow.com. We do **not** operate a browser-infrastructure API or a scraping API, and an OEM agreement commits us not to launch one that targets a licensee's named market during the term. If that changes, it changes at renewal, in writing, not silently.

Contact: **partners@antibrow.com**

## 11. Questions

- Licensing and OEM: **partners@antibrow.com**
- Legal: **legal@antibrow.com**
- Everything else: [antibrow.com](https://antibrow.com)

---

*Revision 2026-08-14. The version accompanying the kernel build you run is the one that applies.*

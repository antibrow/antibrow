# AntiBrow

**The antidetect browser your AI agent can drive** - a Chromium fork with fingerprint
configuration at engine level, driven through the standard Playwright API.

- Website: https://antibrow.com
- Documentation: https://antibrow.com/docs/sdk
- Source (MIT SDK): https://github.com/antibrow/antibrow
- Detection measurements, including the checks that fail: https://antibrow.com/reports

## What is in the image

The Python SDK (`pip install antibrow`), every shared library the engine links against,
and `xvfb`. The engine is a real browser rather than a headless build - headless Chromium
has its own detectable fingerprint - so it runs under a virtual display; the entrypoint is
`xvfb-run -a`, so you do not have to think about it.

The browser engine is **not** baked into the image. It downloads on first launch into
`ANTIBROW_CACHE_DIR` (`/opt/antibrow`); mount that path to keep it between containers
instead of downloading it again.

## Quick start

```bash
docker run --rm antibrow/antibrow          # prints the SDK and default engine versions

docker run --rm \
  -e ANTIBROW_API_KEY=ab_live_... \
  -v antibrow-cache:/opt/antibrow \
  -v "$PWD":/work \
  antibrow/antibrow python script.py
```

```python
# script.py
from antibrow import launch

browser = launch("agent-01")        # same name -> same fingerprint, cookies and storage
page = browser.new_page()
page.goto("https://example.com")
print(page.title())
browser.close()
```

`launch()` returns standard Playwright objects, so existing Playwright code runs unchanged.

## Profiles, proxies, concurrency

A profile is the unit of identity: cookies, storage and an engine-level fingerprint that
persist, so an agent that signed in on an earlier run is still signed in. Unlimited local
profiles are free; how many may run at once is your plan's concurrency limit.

```python
launch("agent-01", proxy="http://user:pass@host:5001")   # one exit IP per profile
launch("scratch", temporary=True)                        # discarded on close
```

Credentials are answered inside the engine - HTTP/HTTPS `407` in the network stack, SOCKS5
by RFC 1929 - so nothing is loaded into `chrome://extensions`.

## Agent frameworks

An MCP server ships with the SDK, and there are guides for
[LangChain](https://antibrow.com/docs/langchain) and the
[Vercel AI SDK](https://antibrow.com/docs/ai-sdk).

## Tags

- `latest`, `<version>` - tracks the `antibrow` PyPI release the image was built from

## Licensing

The SDK in this image is MIT. The browser engine it downloads at runtime is closed source
under separate terms - see
[BINARY-LICENSE.md](https://github.com/antibrow/antibrow/blob/main/BINARY-LICENSE.md).

It does not promise that a given site will accept an automated session. A persistent
identity removes the tells that come from starting over every run: a fresh profile, a stock
automation fingerprint, your own IP.

# Changelog

All notable changes to the `antibrow` Python SDK. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-07-28

First public release of the Python SDK. Feature parity with the Node SDK's
local-profile path; cloud profile sync and Live View are not implemented yet.

### Added

- `launch()` / `launch_async()` / `launch_persistent_context()` — start the
  AntiBrow kernel and attach Playwright over CDP.
- Per-profile personas: a self-consistent Windows/Chrome identity generated once
  and frozen in `persona.json`, serialized to `fp-config.json` on every launch.
  Byte-compatible with the Node SDK and the desktop app, sharing one cache
  directory.
- Kernel management: per-platform download + extraction with build markers,
  runtime discovery of new builds from the remote manifest, update detection,
  and `+x` repair on Linux.
- Proxies: `http`, `https`, `socks5` and `relay` with credentials answered
  inside the kernel (no extension), plus a legacy MV3 fallback mode.
- GeoIP: exit-node timezone and public IP resolved *through* the proxy and
  written into the fingerprint.
- Licensing: server-issued tokens (`POST /api/v1/engine/token`) with local
  caching, an API-key file, environment variables, and a pluggable
  `license_provider` for self-hosted issuers. **No signing key ships in this
  package.**
- CLI: `python -m antibrow install | info | login | version`.
- Examples for Playwright, Puppeteer/Node parity, browser-use, crawl4ai,
  Scrapling, MCP and Docker.

### Known limitations

- macOS: no kernel build; `launch()` raises `UnsupportedPlatformError`.
- Linux headless: run under Xvfb (`headless=True` is a Windows-only off-screen
  window trick).
- Cloud profile sync, Live View and managed-proxy activation by `proxy_id` are
  Node SDK / desktop features and are not implemented here.

[Unreleased]: https://github.com/antibrow/antibrow/compare/python-v0.1.0...HEAD
[0.1.0]: https://github.com/antibrow/antibrow/releases/tag/python-v0.1.0

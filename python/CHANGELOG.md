# Changelog

All notable changes to the `antibrow` Python SDK. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-08-04

Cloud profile sync, portable `.fpprofile` archives, and a portable passkey store -
the profile parts of the Node SDK that were missing here.

### Added

- Cloud profile sync. On a paid plan a launch restores the profile before
  starting and saves it again on `close()`, so another machine opens the same
  cookies, storage, history and passkeys. `sync=False` keeps a launch local,
  `on_sync=` reports each transfer, and `session.sync_error` says whether the
  closing upload made it. A sync failure never fails a launch.
- Passkeys are kept in the profile's own portable store (`passkeys.json` at the
  profile root), so they travel with a sync or an export instead of being stranded
  on the machine that registered them. `webauthn_capture=False` opts out and lets
  the browser ask where to save each passkey.
- Portable profile archives: `export_profile_archive()` / `import_profile_archive()`
  read and write the same `.fpprofile` format the desktop app uses, so a profile
  can be handed over as a file. The older `.zip` export still imports.
- A persona can now carry a captured real-device WebGL report
  (`Persona.captured_webgl`), replayed verbatim into the kernel config. Imported
  profiles keep theirs instead of falling back to a synthesized report.

### Fixed

- macOS: the stray `http://(en-us)/` tab is closed once the browser is up. The
  locale argument macOS needs for `Intl.*` has a half without a leading dash,
  which Chromium's own parser takes for a URL and opens; 0.3.0 left that tab open
  for the whole session.
- Kernel downloads failed with a bare `HTTP 403` on a first install, and the
  kernel catalogue refresh failed silently: the CDN refuses urllib's default
  `Python-urllib/3.x` client signature. Every request the SDK makes now
  identifies itself.

## [0.3.0] - 2026-08-01

Linux arm64 support, and a kernel catalogue that no longer needs an SDK release
to see a newly published kernel.

### Added

- Linux arm64 support. The kernel now ships a separate arm64 build, picked
  automatically from the CPU, so the same code and the same Docker image work on
  `linux/amd64` and `linux/arm64`.

### Changed

- Kernel versions published after an SDK release are now discovered on every
  launch instead of only when `update_kernel=True`. The manifest is cached in the
  cache directory for an hour, failures are silent, and an offline run falls back
  to the last catalogue it saw. The version a brand-new profile is created with
  still changes only with an SDK release.

## [0.2.0] - 2026-07-31

macOS support, plus persona consistency fixes for hosts that aren't Windows.

### Added

- macOS support (Apple silicon and Intel, one universal build). `launch()` works
  the same as on Windows and Linux; see [Platform support](README.md#platform-support)
  for the current caveats.

### Fixed

- A profile's persona is now reported consistently regardless of which OS the
  host machine runs. Previously some identity details could still reflect the
  host rather than the persona when running on a non-Windows host.
- Improved locale handling on macOS, so locale-derived browser output matches the
  persona's language.

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

[0.4.0]: https://github.com/antibrow/antibrow/releases/tag/python-v0.4.0
[0.3.0]: https://github.com/antibrow/antibrow/releases/tag/python-v0.3.0
[0.2.0]: https://github.com/antibrow/antibrow/releases/tag/python-v0.2.0
[0.1.0]: https://github.com/antibrow/antibrow/releases/tag/python-v0.1.0

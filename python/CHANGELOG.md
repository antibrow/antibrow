# Changelog

All notable changes to the `antibrow` Python SDK. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-08-07

Profiles get a stable identity of their own, and a profile opened on a second
machine now arrives intact.

### Added

- Profiles keep an identity record (`profile.json`) inside their own directory,
  and the directory is named after that id rather than the profile name. A
  profile can therefore be renamed without losing its persona, and this SDK, the
  Node SDK and the desktop app all resolve the same name to the same directory.
  Directories from older versions are adopted on first launch, personas
  included.
- `navigator.connection` is derived from the proxy's measured round-trip time
  instead of one constant shared by every user. `effective_type`, `rtt` and
  `downlink` are produced by a single conversion, so they stay consistent with
  each other the way a real connection's are.

### Fixed

- A profile opened on a second machine could come up with the first machine's
  tabs missing and some sites signed out. Restoring a cloud archive now replaces
  the profile's state instead of merging into whatever the machine had left
  over, device-bound sessions are disabled (their keys cannot leave the machine
  that created them), and the browser is asked to close before it is killed so
  cookies and session files are flushed first.
- An upload that failed at the end of a session is no longer overwritten by the
  older cloud copy on the next launch. Each archive carries a generation marker,
  and a launch only downloads when the cloud copy is a different generation than
  the one this machine already has.
- `close()` never actually asked the browser to quit. The request was dispatched
  to a worker thread, which Playwright's synchronous API refuses to serve, so
  every close waited out the full 15 second grace period and then killed the
  browser. A killed browser flushes nothing, so cookies written late were lost
  and a synced profile uploaded a half-written directory. Closing is now
  immediate (measured: 15.1s and killed, to 0.1s and clean) and leaves the
  profile in a normal exit state. The asynchronous API was never affected.
- Cloud sync worked for a profile named `mail@example.com` and for one named
  `work mail`, but not for one named `work mail@example.com`. A name holding
  both a space and a character like `@`, `+` or `:` was escaped into a form the
  server reads as double encoding and refuses before any route matches, so every
  request for that profile failed and its sync silently never ran. Those
  characters are legal in a URL path and are now left as they are. A name
  holding a `#`, or a `%` followed by two hex digits, is still affected.

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

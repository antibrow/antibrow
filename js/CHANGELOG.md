# Changelog

All notable changes to the `anti-detect-browser` Node SDK. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [2.6.0] - 2026-08-10

### Added

- `temporary` on the constructor and on `launch()`: profiles land in a separate
  tree that profile managers never enumerate. Recommended for automation.
- `clearTemporaryProfiles()` and `anti-detect-browser --clear-temp`.
- `getProfileArchiveUploadUrl()`: signs an upload slot without also signing a
  download. Used for the re-sign after a browser exits.

### Changed

- A launch no longer creates a cloud profile by itself. A profile syncs when the
  server already knows the name; pass `sync: true` to create it, `sync: false`
  to stay local. Profiles that already sync are unaffected.
- `sync: true` on a plan whose license does not include cloud sync now throws,
  where it previously would have silently proceeded without syncing.
- A default launch of a name the server has never seen, on a plan that supports
  sync, now prints one notice (via `notify`, once per name per process) that the
  profile is local-only and how to opt it into cloud sync.

## [2.5.0] - 2026-08-10

### Added

- Android profiles: `launch({ deviceType: 'android' })` gives a profile a real
  phone's identity (mobile client hints, touch, portrait screen, mobile GPU) on a
  desktop host. Three real devices ship in the package, the device type is frozen
  when the profile is created, and the kernel that supports it is pinned
  automatically. See [Android profiles](README.md#android-profiles).
- `realFingerprint: true` draws a new profile's identity from the device library
  instead of generating one (paid plans).
- The MCP tools `launch_browser` and `create_profile` accept both options.

### Changed

- `launch({ label })` is drawn by the kernel in front of the address bar instead
  of being injected into the page. The old `#__anti-detect-label` element was a
  fixed-position div any script on the page could read back, which defeated the
  point of spoofing in the engine. `color` no longer has an effect, and the
  `installLabel` / `labelOptions` exports are gone.
- `headless: true` on Windows no longer shrinks the window to 1x1, it only moves
  it off-screen. The 1x1 window took the viewport down with it (a desktop
  fp-config does not spoof `outerWidth`), so pages laid out at 1px wide and
  `innerWidth` contradicted the spoofed `screen.width`. An Android profile now
  keeps its persona screen size while hidden.

### Security

- `adm-zip` moved to `^0.6.0` (GHSA-xcpc-8h2w-3j85: a crafted zip could force a
  4GB allocation while unpacking a profile archive).
- `@modelcontextprotocol/sdk` moved to `^1.26.0`. The previous `^1.0.0` range
  allowed versions carrying three high-severity advisories.

## [2.4.0] - 2026-08-07

Managed proxies stop putting the account key on the command line, profiles get a
stable identity of their own, and a profile opened on a second machine now
arrives intact.

### Security

- A managed proxy launch (`launch({ proxyId })`) no longer passes the account API
  key to the browser. The SDK trades the key for a short-lived ticket first, so
  the kernel command line - readable by anything that can list local processes -
  carries only `relay://<proxyId>:<ticket>@…`. The ticket is scoped to that one
  proxy, expires on its own, and is revoked when the session closes.

### Added

- Profiles keep an identity record (`profile.json`) inside their own directory,
  and the directory is named after that id rather than the profile name. A
  profile can therefore be renamed without losing its persona, and the SDK, the
  Python SDK and the desktop app all resolve the same name to the same
  directory. Directories from older versions are adopted on first launch,
  personas included. Two profiles racing for one name no longer merge: the
  newcomer keeps its data under `<name> (local)`.
- `navigator.connection` is derived from the proxy's measured round-trip time
  instead of one constant shared by every user. `effectiveType`, `rtt` and
  `downlink` are produced by a single conversion, so they stay consistent with
  each other the way a real connection's are.

### Fixed

- A profile opened on a second machine could come up with the first machine's
  tabs missing and some sites signed out. Four causes, all addressed: restoring
  a cloud archive now replaces the profile's state instead of merging into
  whatever the machine had left over; device-bound sessions are disabled, since
  their keys cannot leave the machine that created them and their presence
  forces a re-login; the exit hook fires even when the browser is already gone,
  so the closing upload actually happens; and the browser is asked to close
  before it is killed, so cookies and session files are flushed first.
- An upload that failed at the end of a session is no longer overwritten by the
  older cloud copy on the next launch. Each archive carries a generation marker,
  and a launch only downloads when the cloud copy is a different generation than
  the one this machine already has.
- Cloud sync worked for a profile named `mail@example.com` and for one named
  `work mail`, but not for one named `work mail@example.com`. A name holding
  both a space and a character like `@`, `+` or `:` was escaped into a form the
  server reads as double encoding and refuses before any route matches, so every
  request for that profile failed and its sync silently never ran. Those
  characters are legal in a URL path and are now left as they are. A name
  holding a `#`, or a `%` followed by two hex digits, is still affected.

## [2.2.1] - 2026-08-04

### Fixed

- macOS: the stray `http://(en-us)/` tab is closed once the browser is up. The
  locale argument macOS needs for `Intl.*` has a half without a leading dash,
  which Chromium's own parser takes for a URL and opens; 2.2.0 left that tab
  open for the whole session.

### Changed

- A launch that hands over no page at all now gets a blank one, so a caller
  always finds a page where it expects one. No effect on a normal launch, where
  the browser's own startup window provides it.

## [2.2.0] - 2026-08-01

Linux arm64 support, and a kernel catalogue that no longer needs an SDK release
to see a newly published kernel.

### Added

- Linux arm64 support. The kernel now ships a separate arm64 build, picked
  automatically from the CPU, so the same code and the same Docker image work on
  `linux/amd64` and `linux/arm64`.
- `refreshKernelVersions(cacheDir, opts?)` and `loadCachedKernelVersions(cacheDir)`
  for driving and inspecting the kernel catalogue directly.

### Changed

- Kernel versions published after an SDK release are now discovered on every
  launch instead of only when `updateKernelBeforeLaunch` is set. The manifest is
  cached in the cache directory for an hour, failures are silent, and an offline
  run falls back to the last catalogue it saw. The version a brand-new profile is
  created with still changes only with an SDK release.
- `checkKernelUpdates()` always re-fetches the manifest rather than reading the
  cache, since it reports on the published build.

## [2.1.0] - 2026-07-31

### Added

- macOS support (Apple silicon and Intel, one universal build). `launch()` works
  the same as on Windows and Linux; see [Requirements](README.md#requirements) for
  the current caveats.

### Fixed

- A profile's persona is now reported consistently regardless of which OS the host
  machine runs, so a Windows persona no longer leaks the real host through UA-CH
  metadata.

[2.2.1]: https://github.com/antibrow/antibrow/releases/tag/js-v2.2.1
[2.2.0]: https://github.com/antibrow/antibrow/releases/tag/js-v2.2.0
[2.1.0]: https://github.com/antibrow/antibrow/releases/tag/js-v2.1.0

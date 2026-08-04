# Changelog

All notable changes to the `anti-detect-browser` Node SDK. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

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

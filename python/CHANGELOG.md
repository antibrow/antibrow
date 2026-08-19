# Changelog

All notable changes to the `antibrow` Python SDK. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.15.0] - 2026-08-19

### Added

- `persona_to_fp_config(host_platform=...)` overrides the host the font
  decisions are made for. It defaults to this machine.

### Changed

- `launch(sync=True)` now fails when the server cannot confirm the profile,
  instead of launching without cloud sync. A launch that did not ask for sync
  still proceeds, and now reports that the session will not be restored or
  uploaded.
- `set_profile_kernel_version` commits the switch to the profile's cloud copy
  when given its `archive`, and rolls back if that upload fails. Without
  `archive` the switch stays local to that directory, as before.
- A launch whose `kernel_version` differs from the profile's own now moves the
  profile to that version instead of ignoring it, keeping its identity. A move
  that is not allowed is reported and the launch continues on the current
  version.

### Fixed

- Cloud API calls retry on throttling and transient failures, honouring
  `Retry-After`.
- A Windows profile on a macOS or Linux host now measures text the way Windows
  does. The Windows-only families are absent on those hosts, so every one of
  them measured like a font nobody has installed - a contradiction sites check
  for. Needs a browser version that ships the stand-in families; older ones
  ignore the request and behave as before. Windows hosts are unchanged.
- That same profile no longer offers the families such a host can never render
  at all: they were enumerable but unmeasurable, which is one browser
  contradicting itself. Families with stand-ins are kept, and a Windows host
  still offers the full set.
- Each CSS generic family (`serif`, `sans-serif`, `monospace`, `cursive`,
  `fantasy`) now names a fallback family, so a generic whose first choice is
  unavailable no longer collapses onto the width of a family nobody has.
- An Android profile keeps the stock Android font families instead of only the
  ones its captured device reported, so `sans-serif`, `serif` and `monospace`
  no longer resolve to one and the same font.
- A profile whose identity came from a captured device now reports that
  device's WebGL extensions instead of the host GPU's.

### Removed

- `KERNEL_PIN_FILE`, `read_kernel_pin`, `write_kernel_pin`, `clear_kernel_pin`,
  `apply_kernel_pin` and the `.kernel-pin` file. A pin left by an older version
  is ignored - re-apply the switch if one was pending.

## [0.14.2] - 2026-08-17

### Fixed

- A profile replaying a captured machine could report a self-contradictory
  `navigator.connection`: `effectiveType` came from that machine while `rtt` came
  from the proxy probe, so a real launch shipped `{effectiveType: '4g', rtt: 400}`
  — a pairing Chrome's own thresholds rule out, and one a site can catch by timing
  the connection itself. The trio is now produced by a single decision: with no
  measured rtt a complete captured trio is replayed whole (it is one real Chrome's
  own output, so it already agrees with itself); once the proxy rtt is known all
  three are derived from it. `type` and `downlinkMax` describe the medium rather
  than the latency and still come from the captured device.

## [0.14.1] - 2026-08-15

### Fixed

- The profile-directory JSON files are written as bytes, so their contents no
  longer depend on the platform. On Windows, text-mode writes turned every
  newline into a CRLF, which meant `crypt-state.json` travelled inside the
  archive in a form the Node SDK never produces.
- A test helper matched paths with a forward slash, so on Windows it silently
  failed to make the named file unreadable and the case it was meant to cover
  never ran.

## [0.14.0] - 2026-08-15

Per-profile encryption reaches feature parity with the Node SDK. A profile
created under an external key encrypts its cookies and saved passwords with a key
that never touches the profile directory; this release makes such a profile
launchable, syncable and - the part that was outright broken - exportable.

### Added

- `settle_crypt_state()` records whether a profile is encrypted from what the
  kernel actually did, read from the verifier it leaves in `Local State`. It runs
  after the cloud archive is restored and again once the browser has exited, so a
  mark is never a guess about a kernel that may have ignored the switch. When the
  data cannot be read it writes nothing at all: "cannot tell" is its own answer,
  and folding it into "no key" is what loses data.
- `mark_crypt_key_pending()` / `is_crypt_key_pending()` /
  `clear_crypt_key_pending()` and `.crypt-pending`: a directory that has a key
  waiting for it but has not been launched yet. The first launch carries the key
  and the settlement above turns the outcome into the mark. Machine-local - it is
  never packed into the cloud archive.
- `unmark_profile_encrypted()` heals a profile marked encrypted whose data proves
  otherwise, so it stops demanding a key it never used.
- `profile_crypt_marker()` reports a `user-data` directory as `key-bound`,
  `plain` or `unreadable`.
- The kernel's one-shot re-encryption: `run_crypt_rekey()`, `build_rekey_args()`,
  `parse_rekey_code()`, `NO_CRYPT_KEY`, `REKEY_TIMEOUT_CODE` and `CryptRekeyError`
  (with the kernel's machine-readable `code`, which is what to match on - the
  prose has already changed between builds).
- `copy_portable_profile_files()` copies exactly the set a portable export packs.

### Changed

- **`export_profile_archive()` no longer produces an unopenable file for an
  encrypted profile.** It copies the profile to a temporary directory, converts
  the copy to the kernel's built-in key, verifies on the copy that the verifier
  is really gone, and only then packs. The profile itself is never touched. A
  kernel without the conversion feature ignores the switches and exits
  successfully having done nothing, so the check is on the outcome, not on the
  kernel's version - and when nothing was converted the export aborts instead of
  writing a broken package. Pass `api_key`/`server` (or `crypt_key`) plus
  `cache_dir` so the key, the kernel and the licence can be resolved; an
  unencrypted profile still packs directly and needs none of it.
- A launch carries `--fp-crypt-key` for a directory with a pending marker too,
  not only one already marked encrypted: binding happens on the first launch, so
  the mark cannot be its precondition.
- A key that cannot be fetched now names the profile and says that the key is
  what could not be reached, rather than surfacing a bare socket error.
- The packaged version in `pyproject.toml` had fallen behind `__version__`
  (0.12.0 against 0.13.0); both now read 0.14.0.

## [0.13.0] - 2026-08-15

Everything the Node SDK could do to an account's cloud resources, this SDK can
do now. These had been missing since 0.1.0, which scoped itself to "the Node
SDK's local-profile path"; the cloud-sync work in 0.7.0 added only what a launch
itself needs, and the rest was never revisited.

### Added

- Cloud profile management: `create_profile`, `get_profile`,
  `get_or_create_profile`, `update_profile`, `delete_profile`,
  `list_server_profiles`, `sync_pull_profiles` (delta pulls, with the server's
  clock to use as the next `since`) and `get_profile_for_launch`, which resolves
  a profile into `launch()` arguments and follows its proxy reference. Configs
  travel as `ProfileConfig`, so group, label, tags, kernel version and the
  per-profile switches read the same here, in the Node SDK and in the desktop app.
- `launch(proxy_id=...)` opens a profile through one of your managed proxies. The
  launch activates it (the ownership and quota check), takes a short-lived
  ticket, and hands the kernel a `relay://` URL built from that - the account key
  never reaches the command line, and the ticket is handed back on `close()` or
  if the launch fails after issuing it. Managing them: `list_proxies`,
  `claim_managed_proxy`, `release_managed_proxy`, `swap_managed_proxy`,
  `activate_proxy`, `issue_proxy_ticket`, `revoke_proxy_ticket` and
  `managed_proxy_to_relay_url`.
- Your own proxy library on the server: `create_user_proxy`, `update_user_proxy`,
  `delete_user_proxy`, `list_user_proxies`, `sync_pull_user_proxies` and
  `proxy_config_to_url`.
- `get_account()` reports the plan, its concurrency cap and how much of the
  cloud-profile quota is left.
- `upload_profile_state` / `download_profile_state` carry cookies and
  `localStorage` as plain values you can read and edit - the portable
  counterpart to the profile archive, which is the browser's own binary state.
- Live View: `launch(live_view=True)` streams the window to your dashboard and
  `browser.live_view.view_url` is where to watch it. Needs the new `liveview`
  extra (`pip install "antibrow[liveview]"`); nothing else in the package uses a
  WebSocket client, so an install that never streams does not carry one. Frames
  are written from a sender thread rather than the CDP callback, and only the
  newest frame is kept while the socket is busy: late video is not worth showing
  and queueing it would grow without bound exactly when the network is already
  the problem.
- `launch(canvas_noise=False)` turns off the per-profile Canvas and WebGL noise,
  and `launch(api_log="curated"|"all")` logs the fingerprint APIs a page touches
  to `<profile>/fp-api-log.jsonl`. Leaving both unset writes the same fp-config
  as before they existed.
- `profile_exists(name)`, plus `resolve_profile_dir`, `list_profile_entries`,
  `read_profile_meta`, `write_profile_meta`, `ProfileMeta` and `ProfileEntry`
  exported from the package root - they existed already, only not in `__all__`.
- `ApiError` for the management calls above, carrying `.status` (the HTTP status,
  or `0` when the server could not be reached) so callers branch on the status
  rather than the message. `LiveViewError` for a live view that cannot start.

### Changed

- Both SDKs' HTTP now goes through one place, so every request carries the
  explicit `User-Agent` Cloudflare needs. Cloud sync keeps its old behaviour of
  never raising - a failure there still means "stay local", not a failed launch.

## [0.12.0] - 2026-08-14

### Added

- `launch()` passes the kernel's `--fp-crypt-key` for profiles created under an
  external encryption key, so their cookies and saved passwords are encrypted
  under a key that never touches the profile directory. Whether a launch carries
  the flag is decided by the profile directory itself, not by whether the server
  happens to hold a key; the key is fetched per launch and kept in memory only.
  A profile created without a key is never marked and behaves exactly as before.
- `crypt_key` / `get_crypt_key` on `launch()` and `prepare_launch()`, plus
  `mark_profile_encrypted`, `is_profile_encrypted`, `read_crypt_state`,
  `write_crypt_state`, `fetch_profile_crypt_key`, `parse_crypt_key_body` and
  `resolve_crypt_key`. A marked profile whose key cannot be obtained raises the
  new `CryptKeyError` instead of launching: there is deliberately no fallback to
  launching without the flag, because the kernel binds the key when the profile
  is created, so starting such a profile without its key is refused - and on
  kernels predating build `2026-08-14` it destroyed the profile's existing
  encrypted data instead of refusing.
- `pack_profile_cache_with_report(profile_dir)` returns the archive alongside the
  entries it could not read, and `last_profile_pack_report(profile_dir)` reads
  back the report of the pack an upload just sent. An upload returning 2xx says
  the bytes arrived, not that they are all of the profile, so anything that
  deletes the local copy afterwards needs this instead. `pack_profile_cache`
  keeps its signature and its tolerance of locked files.
- Launches pass `--fp-product-name`, which renames the browser in
  `chrome://version` and the About page. Measured against kernel 151 build
  `2026-08-13c`: with and without the flag, `navigator`, the high-entropy UA
  hints and the `Sec-CH-UA` headers are byte-identical, so the name never reaches
  a page. Kernels that predate the flag ignore it.

### Changed

- Whether a profile's data is encrypted now travels with that data: a
  `crypt-state.json` root item (one boolean, no key material) is packed into the
  profile archive alongside `persona.json` and `passkeys.json`. Restoring a
  profile on a second machine therefore launches with its key instead of being
  refused by the kernel. `profile.json` stays out of the archive, so a
  directory's local markers never travel.
- The launch decision is made after the archive is restored, and the restored
  state file wins over the local record when the two disagree - it is the one
  that arrived with the data it describes.
- Importing a portable profile into a directory that previously held an encrypted
  one now states the imported data's encryption instead of inheriting the
  previous occupant's marker.

## [0.11.1] - 2026-08-14

### Changed

- The binary license now separates the two lists it used to mix. Redistributing
  the kernel, baking it into a published image, serving it to your own
  customers, reselling it and shipping it under your own name are things we
  license under an OEM agreement (new §10), not things we forbid; only
  circumventing the license check and reverse engineering stay prohibited
  outright. The three rows of the §4 table that used to end in "contact us" now
  name the grant that covers them, and §10.4 states plainly which markets we do
  not intend to enter against a licensee.

## [0.11.0] - 2026-08-13

### Added

- `set_profile_kernel_version(version, profile_name=… | profile_dir=…)` moves an
  existing profile to another Chrome major. `launch(kernel_version=…)` only
  seeds a new profile, so until now the only way to move one was to hand-edit
  `persona.json` — and editing the version alone leaves the UA contradicting it.
  Only the three version-derived fields change, so the identity behind the
  profile's cookies survives the move. Unknown versions are refused rather than
  silently resolved to the default, and an Android profile refuses a kernel
  without the mobile patches.
- `should_restore_archive(local, server)` exposes the rule that decides whether
  a launch lays the cloud archive over the local profile.

## [0.10.0] - 2026-08-13

### Changed

- A brand-new profile is created against the newest kernel the catalogue knows
  for this platform, installed or not, rather than the one compiled into this
  release. Publishing a kernel to the manifest now moves the default without an
  SDK release, and the first launch of such a profile downloads that kernel.
  The compiled-in version stays as the fallback for an offline first install.
- `default_kernel_version()` resolves per call instead of scanning the baseline,
  so `find_kernel_version()` falls back to the newest kernel too.

## [0.9.0] - 2026-08-12

### Changed

- A kernel is identified by its Chrome major alone (`150`, `151`) instead of a
  four-part Chromium version. Kernel directories, `persona.json`, the version
  passed to `launch(kernel_version=...)` and everything reported back use the
  major. Installed kernels are migrated by renaming their directory, so nothing
  is downloaded again, and a version frozen into an existing `persona.json` is
  normalized when read rather than rewritten on disk. New:
  `normalize_kernel_version()` and `migrate_legacy_kernel_dirs()`. The catalogue
  cache is now `kernel-catalog-cache.json`; the old file is left in place for
  clients that have not upgraded.

- An Android profile is created against the newest kernel that carries the
  mobile device support, not a fixed one. Any kernel at or above the documented
  minimum qualifies, so newly published ones become available through the kernel
  manifest without an SDK release. `launch(device_type="android",
  kernel_version=...)` honours an explicit version when it qualifies and falls
  back to the newest that does otherwise; existing profiles keep the kernel
  frozen into their identity. New: `android_capable_kernels()` and
  `resolve_android_kernel()`.

- Android capability is decided by the kernel's Chrome major alone. The build
  stamp is no longer consulted, so a qualifying kernel is no longer refused when
  its manifest row omits `build` or carries an older date - the compiled-in
  baseline has no build stamp at all, which made every Android launch depend on
  a successful manifest fetch. `kernel_supports_android(version)` now takes one
  argument; the second is still accepted and ignored so existing calls keep
  working. `ANDROID_MIN_KERNEL_BUILD` is removed: nothing gates on it any more.

## [0.8.0] - 2026-08-10

### Added

- `launch(focus_window=False)` opens the browser behind whatever has focus
  instead of in front of it, so starting a session does not interrupt what you
  are doing. The window is still there and normally sized - this is not
  headless, it just does not come to the front. Default is ``True``.

  Window stacking is decided in the kernel rather than in the SDK, so install
  the latest kernel for the profile before relying on it.

### Fixed

- macOS: the stray `http://(en-us)/` tab is gone on kernels that read the
  application locale from the profile config (Chrome 151, build `2026-08-10c` or
  newer). The launcher stops passing the `-AppleLanguages` pair to those builds,
  so the tab is never opened and the wait that watched for it is skipped. Older
  kernels still get the pair, because dropping it there would leave `Intl`
  reporting the host locale while `navigator.language` says otherwise.

## [0.7.0] - 2026-08-10

### Added

- `temporary=True` on `launch()` and `launch_async()`: profiles land in a
  separate tree that profile managers never enumerate. Recommended for
  automation.
- `clear_temporary_profiles()` and `python -m antibrow clear-temp`.
- `get_profile_archive_upload_url()`: signs an upload slot without also signing
  a download. Used for the re-sign after a browser exits.

### Changed

- A launch no longer creates a cloud profile by itself. A profile syncs when the
  server already knows the name; pass `sync=True` to create it, `sync=False`
  to stay local. Profiles that already sync are unaffected.
- `sync=True` on a plan whose license does not include cloud sync now raises,
  where it previously would have silently proceeded without syncing.
- A default launch of a name the server has never seen, on a plan that supports
  sync, now reports (once per name per process) that the profile is local-only
  and how to opt it into cloud sync - printed to stdout, or sent to
  `on_progress` instead when the caller supplied one.

## [0.6.0] - 2026-08-10

0.5.0 was tagged but never reached PyPI, so this release carries its changes too.

### Added

- Android profiles: `launch(device_type="android")` gives a profile a real
  phone's identity (mobile client hints, touch, portrait screen, mobile GPU) on a
  desktop host. Three real devices ship in the package, the device type is frozen
  when the profile is created, and the kernel that supports it is pinned
  automatically. See [Android profiles](README.md#android-profiles).
- `real_fingerprint=True` draws a new profile's identity from the device library
  instead of generating one (paid plans).
- `DeviceType`, `fetch_real_device`, `kernel_supports_android`,
  `kernel_version_at_least` and `ANDROID_MIN_KERNEL_VERSION` / `_BUILD` are
  exported from the package root, matching the Node SDK.

### Changed

- `headless=True` on Windows no longer shrinks the window to 1x1, it only moves
  it off-screen. The 1x1 window took the viewport down with it, so pages laid
  out at 1px wide and `innerWidth` contradicted the spoofed `screen.width`. An
  Android profile now keeps its persona screen size while hidden.

### Security

- The `mcp` extra now requires `mcp>=1.28.1`; earlier versions carry six
  high-severity advisories.

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

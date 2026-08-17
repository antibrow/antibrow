# Changelog

All notable changes to the `anti-detect-browser` Node SDK. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [2.19.1] - 2026-08-15

### Fixed

- The MCP server's `close_browser` closed the Playwright context, which on a
  CDP connection only drops the link and leaves the browser running. The leaked
  process kept the profile's singleton lock, so the next `launch_browser` on
  that profile ended with "Browser exited before CDP ready" as the new kernel
  handed off to the old one and exited; it also held a concurrency slot for the
  rest of the session, which a single-slot license never gets back. Sessions
  now shut the browser down through the handle `launch()` returns, so the
  process ends, cookies are flushed and any cloud archive is uploaded.
- An agent host that ends the MCP session left every browser it had opened
  running, the same way. Shutdown now closes all open sessions first, and it
  runs on the end of the stdio transport as well as on a signal: a host that
  disappears does not signal the server, it just stops being there and the
  server's input closes behind it. One browser that refuses to exit no longer
  keeps the others from being closed.

## [2.19.0] - 2026-08-15

### Fixed

- A profile was recorded as encrypted when its key was minted, before any
  browser had run. Only some kernel builds understand `--fp-crypt-key`, and
  Chromium ignores switches it does not know, so on a build without support the
  profile was created as an ordinary unencrypted one while its directory - and
  the cloud archive that carries that record - claimed otherwise. The claim was
  harmless on the machine that made it and only surfaced elsewhere: a kernel
  that does support the key refused to start, having found no verifier to check
  it against. Encryption is now recorded from what the kernel actually did.

### Added

- `settleCryptState(profileDir)` reconciles a profile's encryption record with
  the verifier its browser data carries, returning `bound`, `plain` or
  `unknown`. `openProfile()` runs it twice: after the archive restore, so the
  launch reads a directory that agrees with itself, and once the browser has
  exited, which is both the first moment the outcome can be read and the last
  before the archive is packed. `unknown` - an unreadable or absent `Local
  State` - writes nothing, so "cannot tell" is never read as "no key" and an
  encrypted profile whose key is unavailable still refuses to launch.
- A record contradicted by the data it describes is corrected: a profile marked
  encrypted whose browser data carries no verifier is unmarked and launches
  normally. This needs positive evidence - readable data with no verifier is
  data under the built-in key, with no protection to drop.
- `markCryptKeyPending(profileDir)` records that a key is waiting for a
  directory whose first launch has yet to happen. `resolveCryptKey()` now
  passes the key for such a directory too: the kernel binds the key on the
  profile's first launch, so that launch has to carry it, and the encryption
  record is its result rather than its precondition. The marker is
  machine-local and never packed into the cloud archive. Companion helpers:
  `isCryptKeyPending()`, `clearCryptKeyPending()`, `unmarkProfileEncrypted()`,
  `CRYPT_PENDING_FILE`.

## [2.18.0] - 2026-08-15

### Fixed

- `exportProfileArchiveAsync()` resolved the conversion kernel with the same
  lenient lookup as an ordinary launch, but never refreshed the kernel
  catalogue first the way a launch does - so a profile pinned to a version
  published after this SDK (e.g. a new major only present in the runtime
  manifest) silently converted on the compiled-in baseline instead. Against a
  baseline kernel with no `--fp-crypt-rekey` support, Chromium ignores the
  unknown switches and opens a full browser on the temporary copy instead of
  converting it, hanging until the conversion timeout and then failing with a
  message that pointed at the wrong kernel. The export path now refreshes the
  catalogue and resolves the version strictly, the same guard already used for
  the Android kernel floor: a version absent from the catalogue now fails
  immediately, naming the version, instead of quietly running on a different
  one.
- The conversion timeout is now 60s instead of 10 minutes - a real conversion
  finishes in well under a second, so 60s is two orders of magnitude of
  headroom while still failing far short of what a hung, wrong-kernel browser
  window used to cost. A run that hits the timeout now says so explicitly
  (distinct from a kernel refusal, which exits on its own with a code) rather
  than reading like an unexplained failure.
- `fetchProfileCryptKey()` let a transport-level failure (offline, DNS,
  connection refused) through as a bare `fetch failed`, with nothing tying it
  to encryption or to which profile. An encrypted profile cannot launch
  without reaching the server for its key - by design - so this is the error
  users hit most often when offline; it now names the profile and says an
  encrypted profile cannot start without the key, wrapping the original
  transport error rather than hiding it. Launch behaviour is unchanged: the
  key is still required and the kernel is still never spawned without it.

## [2.17.0] - 2026-08-15

### Added

- `exportProfileArchiveAsync()`, and `p.export()` now uses it, so an encrypted
  profile can be exported at all. Its encryption key never enters its own
  directory, so packing the directory as it stands hands the recipient
  ciphertext and nothing to open it with. The profile is now copied to a
  temporary directory, converted there to the browser's built-in encryption,
  and packed from the copy - the profile itself is never touched, and the
  archive opens anywhere, on any machine, with no key.

### Changed

- The export verifies the outcome instead of trusting the browser core: a core
  that predates the conversion feature ignores the switches, converts nothing
  and exits successfully, which would have produced an archive nobody could
  open. The converted copy is now checked for the key verifier the core keeps
  beside the data, and an export that did not convert aborts with an error
  naming the core, writing no file. The temporary copy is removed on every
  path, success or failure.
- `exportProfileArchive()` (the synchronous one) refuses an encrypted profile
  rather than packing unopenable ciphertext. Unencrypted profiles export
  exactly as before.

## [2.16.0] - 2026-08-15

### Fixed

- A kernel major with two full-version rows in the manifest (upstream
  republishing the same major under a newer patch) could register the older
  row's build instead of the newer one, depending only on which row the
  in-memory catalogue happened to see last. Since `.fp-build` drift is what
  drives the "update available" prompt, an unlucky merge order could make a
  major stop offering updates entirely, no matter what upstream published
  next. Kernel platform assets now carry the full version they were published
  under, so a merge always keeps the newer row's build regardless of arrival
  order; a same-full-version refresh can still bump a stale build forward, but
  never walks a known build backwards.

## [2.15.0] - 2026-08-14

### Added

- `profile()`, a durable alternative to passing a profile name to `launch()`
  every time. It resolves (creating on first use) the profile once and hands
  back a `ProfileHandle` that remembers the proxy, group and tags you set on
  it - a later `profile({ name })` call with none of those options passed
  comes back exactly as it was left. The handle adds `launch()` (session-only
  options - passing a proxy, tags, group, `sync` or `temporary` there throws),
  `setProxy()` / `swapProxy()`, `getGroup()` / `setGroup()`, `getTags()` /
  `setTags()`, `enableSync()`, `dangerousDisconnectSync()` (irreversible - it
  deletes the cloud copy and its archive but leaves the local directory
  launchable) and `export()`.
- Exported `ProfileHandle`, and the types `ProfileOptions`, `SessionOptions`,
  `ProxyInput` and `ProxyBinding`.

## [2.14.1] - 2026-08-14

### Changed

- The binary license now separates the two lists it used to mix. Redistributing
  the kernel, baking it into a published image, serving it to your own
  customers, reselling it and shipping it under your own name are things we
  license under an OEM agreement (new §10), not things we forbid; only
  circumventing the license check and reverse engineering stay prohibited
  outright. The three rows of the §4 table that used to end in "contact us" now
  name the grant that covers them, and §10.4 states plainly which markets we do
  not intend to enter against a licensee.
- Package description no longer reads as though the fingerprint work happens
  over CDP. Spoofing is in the kernel; CDP is only the control transport.

## [2.14.0] - 2026-08-14

### Changed

- Whether a profile's data is encrypted now travels with that data: a
  `crypt-state.json` root item (one boolean, no key material) is packed into the
  profile archive alongside `persona.json` and `passkeys.json`. Restoring a
  profile on a second machine therefore launches with its key instead of being
  refused by the kernel. The key itself is still fetched per launch and kept in
  memory only. `profile.json` stays out of the archive, so a directory's local
  markers never travel.
- The launch decision is made after the archive is restored, and the restored
  state file wins over the local record when the two disagree - it is the one
  that arrived with the data it describes.
- Importing a portable profile into a directory that previously held an
  encrypted one now states the imported data's encryption instead of inheriting
  the previous occupant's marker.

## [2.13.0] - 2026-08-14

### Added

- `openProfile` passes the kernel's `--fp-crypt-key` for profiles created under
  an external encryption key, so their cookies and saved passwords are encrypted
  under a key that never touches the profile directory. Whether a launch carries
  the flag is decided by a mark on the profile directory itself, written when the
  profile is created; the key is fetched per launch and kept in memory only.
  A profile created without a key is never marked and behaves exactly as before.
- `cryptKey` / `getCryptKey` on `openProfile`, plus `markProfileEncrypted`,
  `isProfileEncrypted`, `fetchProfileCryptKey` and `resolveCryptKey`.

### Notes

- A marked profile whose key cannot be obtained fails the launch. There is
  deliberately no fallback to launching without the flag: the kernel binds the
  key when the profile is created, so starting such a profile without its key is
  refused - and on kernels predating build `2026-08-14` it destroyed the
  profile's existing encrypted data instead of refusing.

## [2.12.0] - 2026-08-14

### Added

- Launches pass `--fp-product-name`, which renames the browser in
  `chrome://version` and the About page. Measured against kernel 151 build
  `2026-08-13c`: with and without the flag, `navigator`, the high-entropy UA
  hints and the `Sec-CH-UA` headers are byte-identical, so the name never
  reaches a page. Kernels that predate the flag ignore it.

## [2.11.0] - 2026-08-13

### Added

- `packProfileCacheWithReport(profileDir)` returns `{ archive, skipped }`, and
  `lastProfilePackReport(profileDir)` gives the same report for the pack that
  `uploadProfileCache()` did internally. A pack skips files it cannot read (a
  running browser holds some open) and that archive still uploads with a 2xx, so
  a successful upload was never proof the archive is the whole profile. Anything
  that erases the local copy after an upload needs `skipped` to be empty
  first: an archive missing `persona.json` restores as a different identity.
  `packProfileCache()` keeps returning the buffer and packs exactly what it
  packed before: tolerating a locked file is still better than failing the save.

## [2.10.0] - 2026-08-13

### Added

- `setProfileKernelVersion({ profileName | profileDir, version })` moves an
  existing profile to another Chrome major. `launch()`/`openProfile()`'s
  `kernelVersion` only seeds a new profile, so until now the only way to move
  one was to hand-edit `persona.json` — and editing the version alone leaves the
  UA contradicting it. Only the three version-derived fields change, so the
  identity behind the profile's cookies survives the move. Unknown versions are
  refused rather than silently resolved to the default, and an Android profile
  refuses a kernel without the mobile patches.
- `shouldRestoreArchive(local, server)` exposes the rule that decides whether a
  launch lays the cloud archive over the local profile.

## [2.9.0] - 2026-08-13

### Changed

- A brand-new profile is created against the newest kernel the catalogue knows
  for this platform, installed or not, rather than the one compiled into this
  release. Publishing a kernel to the manifest now moves the default without an
  SDK release, and the first launch of such a profile downloads that kernel.
  The compiled-in version stays as the fallback for an offline first install.
- `findKernelVersion()` and `ensureKernel()`'s default argument follow the same
  resolution, so an unknown or omitted version lands on the newest kernel.

### Added

- `defaultKernelVersion()`, the kernel a new profile gets. `DEFAULT_KERNEL_VERSION`
  still exports the compiled-in baseline: it is fixed at import time and cannot
  see manifest versions, so prefer the function.

## [2.8.0] - 2026-08-12

### Changed

- A kernel is identified by its Chrome major alone (`150`, `151`) instead of a
  four-part Chromium version. Kernel directories, `persona.json`, the version
  passed to `openProfile({ kernelVersion })` and everything reported back use
  the major. Installed kernels are migrated by renaming their directory, so
  nothing is downloaded again, and a version frozen into an existing
  `persona.json` is normalized when read rather than rewritten on disk. New:
  `normalizeKernelVersion()` and `migrateLegacyKernelDirs()`. The catalogue
  cache is now `kernel-catalog-cache.json`; the old file is left in place for
  clients that have not upgraded.

- An Android profile is created against the newest kernel that carries the
  mobile device support, not a fixed one. Any kernel at or above the documented
  minimum qualifies, so newly published ones become available through the kernel
  manifest without an SDK release. `openProfile({ deviceType: 'android',
  kernelVersion })` honours an explicit version when it qualifies and falls back
  to the newest that does otherwise; existing profiles keep the kernel frozen
  into their identity. New: `androidCapableKernels()` and
  `resolveAndroidKernel()`.

- Android capability is decided by the kernel's Chrome major alone. The build
  stamp is no longer consulted, so a qualifying kernel is no longer refused when
  its manifest row omits `build` or carries an older date - the compiled-in
  baseline has no build stamp at all, which made every Android launch depend on
  a successful manifest fetch. `kernelSupportsAndroid(version)` now takes one
  argument; the second is still accepted and ignored so existing calls compile.
  `ANDROID_MIN_KERNEL_BUILD` is removed: nothing gates on it any more.

### Fixed

- The per-profile window icon now reaches macOS and Linux. It was only ever
  written as a Windows `.ico`, which those platforms cannot decode - they fell
  back to the default kernel icon with no error. They get a `.png` instead, so a
  profile is recognizable in the Dock, the app switcher and the taskbar. A
  kernel that does not know the switch ignores it and keeps its own icon.

## [2.7.0] - 2026-08-10

### Added

- `launch({ focusWindow: false })` opens the browser behind whatever has focus
  instead of in front of it, so starting a session does not interrupt what you
  are doing. The window is still there and normally sized - this is not
  headless, it just does not come to the front. Default is `true`. Also exposed
  on the MCP `launch_browser` tool.

  Window stacking is decided in the kernel rather than in the SDK, so install
  the latest kernel for the profile before relying on it.

### Changed

- `checkClientVersion()` reads the version policy from a static manifest on the
  CDN instead of calling the API. The `server` option is accepted but ignored;
  pass `manifestUrl` to point at a different manifest. It still fails open to
  `ok` when the manifest cannot be read.

### Fixed

- macOS: the stray `http://(en-us)/` tab is gone on kernels that read the
  application locale from the profile config (Chrome 151, build `2026-08-10c` or
  newer). The launcher stops passing the `-AppleLanguages` pair to those builds,
  so the tab is never opened and the wait that watched for it is skipped. Older
  kernels still get the pair, because dropping it there would leave `Intl`
  reporting the host locale while `navigator.language` says otherwise.

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

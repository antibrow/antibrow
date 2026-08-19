"""The public ``launch`` API.

One call does the whole sequence:

1. get a license token (server-issued - see :mod:`antibrow.license`);
2. restore the profile from the cloud, when the plan syncs (persona.json comes
   out of that archive, so it has to happen before the next step);
3. resolve the profile directory and load (or mint and freeze) its persona;
4. make sure the kernel build that profile is pinned to is on disk;
5. look up the proxy's exit timezone, when a proxy is in play;
6. serialize the persona to ``fp-config.json`` and spawn the kernel;
7. attach Playwright over CDP and hand back a ready-to-drive browser.

``close()`` then packs the profile and uploads it again.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Sequence, Set, Tuple, Union

from . import api as _api
from . import config as _config
from . import devices as _devices
from . import kernel as _kernel
from . import profile_sync as _sync
from .crypt_key import fetch_profile_crypt_key, resolve_crypt_key
from .errors import ApiError, LicenseError, ProfileCacheError, ProxyError
from .geoip import lookup_proxy_geo
from .launcher import (
    DEFAULT_LAUNCH_TIMEOUT,
    _drain_output,
    build_launch_args,
    is_stray_locale_tab_url,
    kill_process_tree,
    pick_free_port,
    shutdown_kernel,
    spawn_kernel,
    wait_for_cdp,
)
from .license import LicenseInfo, LicenseProvider, get_license_token, resolve_api_key
from .liveview import (
    DEFAULT_RELAY_URL,
    LiveViewOptions,
    LiveViewSession,
    LiveViewStream,
    register_live_session,
)
from .persona import (
    PERSONA_FILE,
    DeviceType,
    Persona,
    load_or_generate_persona,
    read_persona,
    with_kernel_version,
    write_fp_config,
    write_persona,
)
from .profile_cache import (
    clear_archive_version,
    download_profile_cache,
    read_archive_version,
    upload_profile_cache,
    write_archive_version,
)
from .profile_dir import read_profile_meta, resolve_profile_dir, settle_crypt_state
from .proxy import ProxyLike, ProxySpec, parse_proxy

if TYPE_CHECKING:  # pragma: no cover - typing only
    from playwright.async_api import BrowserContext as AsyncBrowserContext
    from playwright.sync_api import BrowserContext as SyncBrowserContext

ProgressCallback = Callable[[str], None]

DEFAULT_PROFILE = "default"


@dataclass
class SyncEvent:
    """Progress of one cloud transfer. ``error`` is set only for ``"error"``."""

    phase: str  # "download" | "upload"
    state: str  # "start" | "done" | "error"
    error: Optional[str] = None


SyncCallback = Callable[[SyncEvent], None]


@dataclass
class ArchivePlan:
    """The cloud archive slot this launch got, and how to sign the next upload.

    ``sign_upload`` is called after the browser exits rather than at launch: the
    server signs for 900 seconds and a real session outlives that easily.
    """

    profile: str
    restored: bool = False
    can_upload: bool = False
    sign_upload: Optional[Callable[[], Optional[str]]] = field(default=None, repr=False)
    on_event: Optional[SyncCallback] = field(default=None, repr=False)
    #: The cloud archive's generation, from the server. Equal to the local
    #: marker means this machine already holds it and the restore is skipped.
    version: Optional[str] = None

    def emit(self, phase: str, state: str, error: Optional[str] = None) -> None:
        if self.on_event is not None:
            self.on_event(SyncEvent(phase=phase, state=state, error=error))


@dataclass
class ProxyTicketRef:
    """One issued managed-proxy ticket, and how to hand it back.

    ``revoke`` carries the credentials rather than the plan doing so, for the
    same reason ``ArchivePlan.sign_upload`` does: an API key on a value the
    caller can print is a key in somebody's logs.
    """

    proxy_id: str
    ticket_id: str
    revoke: Optional[Callable[[], None]] = field(default=None, repr=False)


@dataclass
class LaunchPlan:
    """Everything resolved before the kernel process starts.

    Exposed because it is also the whole story of a launch: which binary, which
    identity, which timezone, which arguments. Useful in tests and bug reports.
    """

    exe_path: Path
    args: List[str]
    cdp_port: int
    profile_dir: Path
    user_data_dir: Path
    persona: Persona
    timezone: str
    label: str
    kernel_version: str
    license: LicenseInfo
    public_ip: Optional[str] = None
    proxy: Optional[ProxySpec] = None
    #: None when this profile is local-only (free plan, ``sync=False``, offline).
    archive: Optional[ArchivePlan] = None
    #: The short-lived managed-proxy credential this launch minted, if any. Handed
    #: back when the session closes; it also expires on its own.
    proxy_ticket: Optional[ProxyTicketRef] = None

    @property
    def cdp_url(self) -> str:
        return "http://127.0.0.1:{0}".format(self.cdp_port)

    def redacted_args(self) -> List[str]:
        """Arguments with the license token, encryption key and proxy password masked."""
        out = []
        for arg in self.args:
            if arg.startswith("--fp-license="):
                out.append("--fp-license=<redacted>")
            elif arg.startswith("--fp-crypt-key="):
                out.append("--fp-crypt-key=<redacted>")
            elif arg.startswith("--proxy-server=") and self.proxy is not None:
                out.append("--proxy-server={0}".format(self.proxy.to_url(with_credentials=False)))
            else:
                out.append(arg)
        return out


def prepare_launch(
    profile: str = DEFAULT_PROFILE,
    *,
    headless: bool = False,
    focus_window: bool = True,
    proxy: ProxyLike = None,
    proxy_id: Optional[str] = None,
    proxy_host: Optional[str] = None,
    geoip: bool = True,
    timezone: Optional[str] = None,
    api_key: Optional[str] = None,
    server: Optional[str] = None,
    cache_dir: Optional[Path | str] = None,
    profile_dir: Optional[Path | str] = None,
    kernel_version: Optional[str] = None,
    label: Optional[str] = None,
    args: Optional[Sequence[str]] = None,
    proxy_auth: str = "native",
    license_token: Optional[str] = None,
    license_provider: Optional[LicenseProvider] = None,
    crypt_key: Optional[str] = None,
    get_crypt_key: Optional[Callable[[], Optional[str]]] = None,
    update_kernel: bool = False,
    webauthn_capture: Optional[bool] = None,
    restore_tabs: bool = True,
    device_type: Optional[DeviceType] = None,
    real_fingerprint: bool = False,
    canvas_noise: Optional[bool] = None,
    api_log: Optional[str] = None,
    sync: Optional[bool] = None,
    temporary: bool = False,
    on_sync: Optional[SyncCallback] = None,
    on_progress: Optional[ProgressCallback] = None,
) -> LaunchPlan:
    """Do every blocking step of a launch except starting the process.

    Separated out so the async API can run it in a worker thread and so tests
    can inspect the exact command line without a browser.
    """
    notify = on_progress or (lambda _message: None)

    # Checked before anything is created or fetched: temporary+sync=True is a
    # pure contradiction that never needs a license or a directory to detect,
    # so a typo'd combination costs nothing instead of leaving an orphaned
    # profiles-temp/<name>/ behind.
    _reject_temporary_sync(temporary, sync)

    # The license comes first because its `sync` flag decides whether there is a
    # cloud archive to restore, and because rejecting an unsupported plan has to
    # happen before the profile directory exists.
    notify("Obtaining license token")
    license_info = get_license_token(
        api_key,
        server,
        license_token=license_token,
        license_provider=license_provider,
    )
    _reject_unsynced_plan(sync, license_info.sync)

    root = Path(cache_dir).expanduser() if cache_dir else _config.default_cache_dir()
    if profile_dir:
        directory = Path(profile_dir).expanduser()
        meta = read_profile_meta(directory)
        resolved_name = meta.name if meta else profile
    else:
        # Resolve both the way every other call site does: an env-only key and
        # the default server are the documented setup, and forwarding the raw
        # arguments would silently skip the lookup and strand this profile on a
        # local id the Node SDK never resolves to.
        resolved = resolve_profile_dir(
            profile,
            root,
            api_key=resolve_api_key(api_key),
            server=server or _config.default_server(),
            temporary=temporary,
        )
        directory, resolved_name = resolved.dir, resolved.name
    directory.mkdir(parents=True, exist_ok=True)

    archive = _restore_archive(
        profile_name=resolved_name,
        directory=directory,
        api_key=api_key,
        server=server,
        license_info=license_info,
        sync=sync,
        temporary=temporary,
        on_sync=on_sync,
        notify=notify,
        on_progress=on_progress,
    )

    # After the restore, before the kernel install: crypt-state.json rides in the
    # archive, so on a second machine the restore is what tells us this profile's
    # data is encrypted. The directory decides - a key is never fetched without
    # its say-so, and a key that cannot be obtained fails the launch here rather
    # than being downgraded into a launch without the flag.
    #
    # Settled first, against the data the restore just laid down: it closes out a
    # previous session the kernel already answered (including one that ended in a
    # crash, before close() could run) and corrects a mark that data contradicts,
    # so what follows reads a directory that agrees with itself.
    settle_crypt_state(directory)
    key_source = get_crypt_key or _own_crypt_key_source(resolved_name, api_key, server)
    launch_crypt_key = resolve_crypt_key(directory, crypt_key=crypt_key, get_crypt_key=key_source)

    # Kernels published after this SDK was built are only known from the manifest,
    # so resolve the catalogue before mapping a version string onto an asset. This
    # has to happen before the version below is resolved even when update_kernel is
    # set, or the Android pin resolves against an empty catalogue. `update_kernel`
    # acts on the published build, so it cannot read a cached manifest.
    _kernel.refresh_kernel_versions(root, force=update_kernel)

    init_device_type, init_device = _resolve_persona_init(
        directory,
        device_type=device_type,
        real_fingerprint=real_fingerprint,
        api_key=api_key,
        server=server,
    )

    # A profile that already exists keeps the kernel version frozen into its
    # persona; `kernel_version` only decides what a brand-new profile gets. An
    # Android profile can only take a kernel carrying the mobile patches, so the
    # request is honoured only when it is one of them: a plain lookup would hand
    # back the compiled-in desktop default and freeze it into a phone profile.
    if init_device_type == "android":
        default_kv = _kernel.resolve_android_kernel(kernel_version)
    elif kernel_version:
        default_kv = _kernel.find_kernel_version(kernel_version)
    else:
        default_kv = _kernel.default_kernel_version()
    notify("Loading persona")
    # Only a profile that already had one can drift: a persona generated right
    # here is seeded from the very version the caller asked for.
    had_persona = read_persona(directory) is not None
    persona = load_or_generate_persona(
        directory, default_kv.version, device_type=init_device_type, device=init_device
    )
    if had_persona:
        persona = reconcile_kernel_version(
            directory, persona, kernel_version, cache_dir=cache_dir, on_progress=notify
        )
    if persona.device_type == "android":
        kv = _kernel.find_kernel_version_strict(persona.kernel_version)
    else:
        kv = _kernel.find_kernel_version(persona.kernel_version)

    if update_kernel:
        # Opt-in: pull a rebuilt same-version kernel before launching. The forced
        # manifest refresh already happened above, before the version was resolved.
        status = _kernel.kernel_update_status(root, kv.version)
        if status is not None and status.update_available:
            notify("Updating kernel {0} to the latest build".format(kv.label))
            _kernel.ensure_kernel(root, kv, on_progress, force=True)

    notify("Ensuring kernel {0}".format(kv.label))
    exe_path = _kernel.ensure_kernel(root, kv, on_progress)

    if persona.device_type == "android":
        _assert_android_kernel(kv.version)

    locale_from_config = _kernel.kernel_reads_app_locale_from_config(
        kv.version, _kernel.installed_kernel_build(root, kv.version)
    )

    # Last, so that everything able to reject this launch - the license, the sync
    # mode, the kernel install - has already run. A ticket minted before those
    # would stay live for its whole lifetime with no session to revoke it.
    proxy, ticket = _resolve_managed_proxy(
        proxy=proxy,
        proxy_id=proxy_id,
        proxy_host=proxy_host,
        api_key=api_key,
        server=server,
        label=label or resolved_name,
        notify=notify,
    )

    try:
        proxy_spec = parse_proxy(proxy)
        resolved_timezone = timezone or persona.timezone
        public_ip: Optional[str] = None
        geo = None
        if proxy_spec is not None and geoip:
            notify("Looking up proxy geo")
            geo = lookup_proxy_geo(proxy_spec)
            if geo is not None:
                if geo.timezone and not timezone:
                    resolved_timezone = geo.timezone
                if geo.ip:
                    public_ip = geo.ip

        display_label = label or resolved_name
        fp_config_path = write_fp_config(
            directory,
            persona,
            label=display_label,
            timezone=resolved_timezone,
            public_ip=public_ip,
            rtt_ms=geo.rtt_ms if geo else None,
            canvas_noise=canvas_noise,
            api_log=api_log,
        )

        user_data_dir = directory / "user-data"
        user_data_dir.mkdir(parents=True, exist_ok=True)
        cdp_port = pick_free_port()

        launch_args = build_launch_args(
            fp_config_path=fp_config_path,
            license_token=license_info.token,
            user_data_dir=user_data_dir,
            label=display_label,
            cdp_port=cdp_port,
            language=persona.languages[0] if persona.languages else "en-US",
            headless=headless,
            focus_window=focus_window,
            locale_from_config=locale_from_config,
            platform=_kernel.current_platform(),
            proxy=proxy_spec,
            proxy_auth=proxy_auth,
            profile_dir=directory,
            webauthn_capture=webauthn_capture,
            restore_tabs=restore_tabs,
            android_screen=(persona.screen_w, persona.screen_h) if persona.device_type == "android" else None,
            crypt_key=launch_crypt_key,
            extra_args=args,
        )
    except BaseException:
        # No session was created, so nothing will ever close and revoke it.
        # Retrying against a flaky proxy would otherwise mint one live
        # credential per attempt.
        _revoke_ticket(ticket)
        raise

    return LaunchPlan(
        exe_path=Path(exe_path),
        args=launch_args,
        cdp_port=cdp_port,
        profile_dir=directory,
        user_data_dir=user_data_dir,
        persona=persona,
        timezone=resolved_timezone,
        label=display_label,
        kernel_version=kv.version,
        license=license_info,
        public_ip=public_ip,
        proxy=proxy_spec,
        archive=archive,
        proxy_ticket=ticket,
    )


def _resolve_managed_proxy(
    *,
    proxy: ProxyLike,
    proxy_id: Optional[str],
    proxy_host: Optional[str],
    api_key: Optional[str],
    server: Optional[str],
    label: str,
    notify: ProgressCallback,
) -> Tuple[ProxyLike, Optional[ProxyTicketRef]]:
    """Turn a managed proxy id into a ``relay://`` URL the kernel can use.

    Activation comes first because that is what checks ownership and meters the
    monthly quota; only then is a credential minted, and it is a short-lived
    ticket rather than the account key - the key would otherwise sit in the
    kernel's command line for anyone on the machine to read.
    """
    if not proxy_id:
        return proxy, None
    if proxy is not None:
        raise ValueError("Pass either proxy= or proxy_id=, not both")
    key = resolve_api_key(api_key)
    if not key:
        raise LicenseError("A managed proxy needs an API key: set ANTIBROW_API_KEY or pass api_key=")

    notify("Activating managed proxy")
    activation = _api.activate_proxy(key, server, proxy_id=proxy_id)
    if activation.proxy is None:
        raise ProxyError("Proxy activation did not return a proxy")
    issued = _api.issue_proxy_ticket(key, server, proxy_id=activation.proxy.id, label=label)
    url = _api.managed_proxy_to_relay_url(
        issued.username, issued.password, proxy_host or issued.host or _api.DEFAULT_RELAY_HOST
    )
    ref = ProxyTicketRef(proxy_id=activation.proxy.id, ticket_id=issued.ticket_id)
    ref.revoke = lambda: _api.revoke_proxy_ticket(
        key, server, proxy_id=ref.proxy_id, ticket_id=ref.ticket_id
    )
    return url, ref


def _revoke_ticket(ticket: Optional[ProxyTicketRef]) -> None:
    """Hand a managed-proxy ticket back. Never raises - it expires on its own."""
    if ticket is None or ticket.revoke is None:
        return
    try:
        ticket.revoke()
    except Exception:
        pass


def _start_live_view(
    context: Any,
    page: Any,
    *,
    live_view: "bool | LiveViewOptions",
    relay_url: Optional[str],
    api_key: Optional[str],
    server: Optional[str],
    plan: LaunchPlan,
    notify: ProgressCallback,
) -> Optional[LiveViewSession]:
    """Register and start a live view, or report why not and carry on.

    A browser you cannot watch still works, so nothing here is allowed to take
    the session down with it.
    """
    if not live_view:
        return None
    key = resolve_api_key(api_key)
    if not key:
        notify("Live View needs an API key; continuing without it")
        return None

    options = live_view if isinstance(live_view, LiveViewOptions) else LiveViewOptions()
    session_key = uuid.uuid4().hex
    try:
        registration = register_live_session(
            key,
            server,
            session_key=session_key,
            profile_name=plan.label,
            label=plan.label,
            ua=plan.persona.ua,
        )
        stream = LiveViewStream(
            context,
            page,
            relay_url or DEFAULT_RELAY_URL,
            registration.session_key,
            registration.relay_token,
            options,
        )
        stream.start()
    except Exception as error:
        notify("Live View unavailable: {0}".format(error))
        return None
    notify("Live View at {0}".format(registration.view_url))
    return LiveViewSession(stream, registration, key, server)


def _own_crypt_key_source(
    profile_name: str, api_key: Optional[str], server: Optional[str]
) -> Optional[Callable[[], Optional[str]]]:
    """This account's own key endpoint. A guest passes ``get_crypt_key`` instead,
    because the key it needs belongs to the profile's owner."""
    key = resolve_api_key(api_key)
    if not key:
        return None

    def _fetch() -> Optional[str]:
        return fetch_profile_crypt_key(profile_name, key, server or _config.default_server())

    return _fetch


def _resolve_persona_init(
    directory: Path,
    *,
    device_type: Optional[DeviceType],
    real_fingerprint: bool,
    api_key: Optional[str],
    server: Optional[str],
) -> Tuple[Optional[DeviceType], Optional[Dict[str, Any]]]:
    """Decide what identity a brand-new profile gets.

    Runs after the archive is restored, because persona.json travels inside
    the archive - checking earlier would mint a fresh identity for a profile
    that already has one on another machine.
    """
    if (directory / PERSONA_FILE).exists():
        return None, None
    if not device_type and not real_fingerprint:
        return None, None
    device = None
    if real_fingerprint:
        device = _devices.fetch_real_device(
            "android" if device_type == "android" else "windows",
            key=resolve_api_key(api_key),
            server=server,
        )
    return device_type, device


def _assert_android_kernel(version: Optional[str]) -> None:
    """An Android config on a pre-mobile kernel is worse than no Android at all."""
    if _kernel.kernel_supports_android(version):
        return
    raise RuntimeError(
        "Android profiles need kernel {0} or newer; this install reports version {1!r}. "
        "Update the kernel and retry.".format(
            _kernel.ANDROID_MIN_KERNEL_VERSION, version or "unknown"
        )
    )


def should_restore_archive(local: Optional[str], server: Optional[str]) -> bool:
    """Whether the cloud archive has to be laid over this profile.

    Equality, not ordering - an ETag has none. The case that matters: the last
    upload failed, so the cloud still holds the generation this machine already
    has, and restoring it would erase newer local work (a kernel switch
    included: persona.json is in the archive and the restore runs before it is
    read).
    """
    return not (server and local and local == server)


def reconcile_kernel_version(
    directory: Path,
    persona: Persona,
    requested: Optional[str],
    *,
    cache_dir: Optional[Union[str, Path]] = None,
    on_progress: Optional[ProgressCallback] = None,
) -> Persona:
    """Bring a profile's persona onto the kernel version its caller believes it
    is running, and report either way.

    Callers that keep their own registry (a launcher, the desktop app) pass a
    stored kernel version on every launch, while the version that actually runs
    comes from persona.json. The two drift apart whenever the stored one moves on
    its own - cloud sync copies that field between machines and never touches the
    profile directory - and the drift used to be silent: the row read 152, the
    browser launched 150 and introduced itself as Chrome 150 to every site.

    A refused move is reported, not raised: the persona's own version is a
    working launch, and breaking it would be a worse answer than running the
    older kernel with the reason said out loud.
    """
    # Both sides are normalised: profiles created before the majors-only change
    # still carry the full four-segment string, which is never rewritten just for
    # being read, and a raw comparison would call that a mismatch.
    wanted = _kernel.normalize_kernel_version(requested) if requested else None
    if not wanted or wanted == _kernel.normalize_kernel_version(persona.kernel_version):
        return persona
    try:
        moved = set_profile_kernel_version(
            wanted, profile_dir=directory, cache_dir=cache_dir
        )
    except Exception as error:  # noqa: BLE001 - any refusal keeps the launch alive
        if on_progress:
            on_progress(
                "Cannot move this profile to Chrome {0}, launching on {1}: {2}".format(
                    wanted, persona.kernel_version, error
                )
            )
        return persona
    if on_progress:
        on_progress(
            "Moving profile from Chrome {0} to {1}".format(
                persona.kernel_version, moved.kernel_version
            )
        )
    return moved


@dataclass
class ArchiveCommit:
    """The profile's cloud archive, as `set_profile_kernel_version` needs it."""

    #: Presigned GET for the current cloud copy.
    get_url: Optional[str] = None
    #: Its generation, compared against this directory's marker.
    version: Optional[str] = None
    #: Resolved at the moment of upload - a presign rarely outlives the pack.
    get_put_url: Optional[Callable[[], Optional[str]]] = None


def set_profile_kernel_version(
    version: str,
    *,
    profile_name: Optional[str] = None,
    profile_dir: Optional[Path | str] = None,
    cache_dir: Optional[Path | str] = None,
    temporary: bool = False,
    archive: Optional["ArchiveCommit"] = None,
) -> Persona:
    """Move an existing profile to another kernel major, keeping its identity.

    Only the three version-derived persona fields change.

    With ``archive``, the whole thing is one committed operation: the current
    cloud copy comes down first (another machine may hold a newer one), the
    persona moves, and the result goes back up - and a failed upload rolls the
    persona back rather than leaving the switch half-made. That is what makes
    the switch hold everywhere, including a second cache directory on this same
    machine: they all restore from the archive, and the archive now carries it.
    """
    if profile_dir is not None:
        directory = Path(profile_dir)
    elif profile_name:
        directory = resolve_profile_dir(profile_name, cache_dir, temporary=temporary).dir
    else:
        raise ValueError("set_profile_kernel_version needs a profile_dir or a profile_name")

    # Start from the cloud copy: moving a stale local one and uploading it would
    # discard whatever another machine last saved.
    if archive and archive.get_url and should_restore_archive(
        read_archive_version(directory), archive.version
    ):
        if download_profile_cache(archive.get_url, directory):
            if archive.version:
                write_archive_version(directory, archive.version)
            else:
                clear_archive_version(directory)

    persona = read_persona(directory)
    if persona is None:
        raise FileNotFoundError(
            "Profile at {0} has no persona yet, so there is no identity to move. "
            "Create it with launch(kernel_version=...) instead.".format(directory)
        )

    # Versions published after this release exist only in the manifest, and the
    # lookup is strict for the same reason the Android one is: silently
    # answering with the compiled-in default would leave the profile on its old
    # kernel while reporting the new one.
    root = Path(cache_dir).expanduser() if cache_dir else _config.default_cache_dir()
    _kernel.refresh_kernel_versions(root)
    kv = _kernel.find_kernel_version_strict(version)
    if persona.device_type == "android":
        _assert_android_kernel(kv.version)

    moved = with_kernel_version(persona, kv.version)
    write_persona(directory, moved)

    if archive and archive.get_put_url:
        try:
            put_url = archive.get_put_url()
            if put_url:
                generation = upload_profile_cache(directory, put_url)
                if generation:
                    write_archive_version(directory, generation)
                else:
                    clear_archive_version(directory)
        except Exception:
            # A switch that reached this directory but not the cloud is the
            # drift this function exists to prevent: the caller would report the
            # new version while every other copy still restores the old one.
            write_persona(directory, persona)
            raise
    return moved


def _reject_temporary_sync(temporary: bool, sync: Optional[bool]) -> None:
    """A temporary profile has no cloud counterpart to sync to.

    Pure - no license or directory needed - so both `prepare_launch` (before
    doing any I/O) and `_restore_archive` (exercised directly by tests) can
    call this and never drift apart on what counts as a conflict.
    """
    if temporary and sync is True:
        raise ValueError(
            "A temporary profile cannot be synced. Drop temporary= or drop sync=True."
        )


def _reject_unsynced_plan(sync: Optional[bool], license_sync: bool) -> None:
    """`sync=True` on a plan without cloud sync is a hard error, not a silent no-op."""
    if sync is True and not license_sync:
        raise ValueError("Cloud sync is not available on your plan.")


_local_only_notified: Set[str] = set()
_local_only_notified_lock = threading.Lock()


def _notify_unreachable(
    name: str, status: int, on_progress: Optional[ProgressCallback]
) -> None:
    """Say it out loud: this session will not be restored or uploaded.

    Shares the local-only notice's once-per-name gate for the same reason it is
    not gated on ``on_progress``: it reports data that will be lost, and a
    relaunch loop must not turn that into a wall of text.
    """
    with _local_only_notified_lock:
        if name in _local_only_notified:
            return
        _local_only_notified.add(name)
    message = (
        'Could not reach the cloud profile "{0}" (HTTP {1}); launching without '
        "cloud sync - this session will not be restored or uploaded.".format(name, status)
    )
    if on_progress:
        on_progress(message)
    else:
        print("[antibrow] " + message)


def _notify_local_only(name: str, on_progress: Optional[ProgressCallback]) -> None:
    """Once per profile name per process.

    Unlike every other message in this module, this one is not gated behind
    ``on_progress`` being set: those describe work in flight and are fine to
    drop when nobody is listening, but this one reports data loss that
    already happened silently - the caller who never wired a callback is
    exactly who needs to see it. A caller who did wire one gets it there
    instead, so they are not also hit with an uncontrolled print.
    """
    with _local_only_notified_lock:
        if name in _local_only_notified:
            return
        _local_only_notified.add(name)
    message = 'Profile "{0}" is local-only; pass sync=True to sync it to the cloud.'.format(name)
    if on_progress is not None:
        on_progress(message)
    else:
        print(message)


def _restore_archive(
    *,
    profile_name: str,
    directory: Path,
    api_key: Optional[str],
    server: Optional[str],
    license_info: LicenseInfo,
    sync: Optional[bool],
    temporary: bool,
    on_sync: Optional[SyncCallback],
    notify: ProgressCallback,
    on_progress: Optional[ProgressCallback] = None,
) -> Optional[ArchivePlan]:
    """Claim this profile's cloud archive slot and restore what is in it.

    Returns None whenever the profile is local-only, which is the normal outcome
    for a temporary profile, a free plan, ``sync=False``, a pre-minted token with
    no key, or a server that cannot be reached. Sync failures are reported, never
    raised: a launch must still work from the local profile directory.

    ``on_progress`` is the caller's raw callback (unlike ``notify``, which is
    already defaulted to a no-op) - passed through only so the local-only
    notice can fall back to stdout when nobody is listening.

    `prepare_launch` already rejects the illegal combinations before this runs;
    the checks are repeated here so a direct call - as the tests make - still
    enforces them.
    """
    _reject_temporary_sync(temporary, sync)
    if temporary:
        return None
    if sync is False:
        return None
    _reject_unsynced_plan(sync, license_info.sync)
    if sync is None and not license_info.sync:
        return None

    key = resolve_api_key(api_key)
    if not key:
        return None

    # A launch never creates a cloud profile on its own: an automation run that
    # mints a name per task would fill the account's sync quota with profiles
    # nobody asked to keep.
    probe_status: List[int] = []
    known = _sync.ensure_server_profile(
        key, server, name=profile_name, create=sync is True, probe_status=probe_status
    )
    if not known:
        # A confirmed 404 (not a dropped connection) on a default launch means
        # this name silently stayed local-only - worth a nudge, since the
        # caller only finds out the hard way, on another machine.
        if probe_status == [404]:
            if sync is None:
                _notify_local_only(profile_name, on_progress)
            return None
        # `sync=True` is a promise about where the data goes; a browser that
        # looks synced and uploads nothing is worse than a failed launch.
        status = probe_status[0] if probe_status else 0
        if sync is True:
            raise ApiError(
                'Cloud profile "{0}" could not be confirmed (HTTP {1}); '
                "refusing to launch unsynced.".format(profile_name, status),
                status=status,
            )
        # Anything else is "we could not find out", not "there is no cloud
        # copy". Left silent, a throttled launch runs a full session and
        # discards it.
        _notify_unreachable(profile_name, status, on_progress)
        return None
    urls = _sync.get_profile_archive_urls(key, server, name=profile_name)
    if not urls:
        return None

    plan = ArchivePlan(
        profile=profile_name,
        can_upload=bool(urls.upload_url),
        sign_upload=lambda: _sync.get_profile_archive_upload_url(key, server, name=profile_name),
        on_event=on_sync,
        version=urls.version,
    )

    if urls.download_url:
        if not should_restore_archive(read_archive_version(directory), urls.version):
            notify("Profile archive already current; skipping restore")
        else:
            notify("Restoring profile from the cloud")
            plan.emit("download", "start")
            try:
                plan.restored = download_profile_cache(urls.download_url, directory)
            except ProfileCacheError as error:
                plan.emit("download", "error", str(error))
            else:
                plan.emit("download", "done")
                if plan.restored and urls.version:
                    write_archive_version(directory, urls.version)

    return plan


class _BaseSession:
    """Shared state/reporting for the sync and async browser handles."""

    def __init__(self, plan: LaunchPlan, process: subprocess.Popen, endpoint: str) -> None:
        self._plan = plan
        self._process = process
        self._endpoint = endpoint
        self._closed = False
        self._uploaded = False
        self._sync_error: Optional[str] = None
        self._live_view: Optional[LiveViewSession] = None

    # -- introspection ----------------------------------------------------
    @property
    def plan(self) -> LaunchPlan:
        """Everything that was resolved for this launch."""
        return self._plan

    @property
    def persona(self) -> Persona:
        """The frozen identity this profile presents to the web."""
        return self._plan.persona

    @property
    def profile_dir(self) -> Path:
        return self._plan.profile_dir

    @property
    def kernel_version(self) -> str:
        return self._plan.kernel_version

    @property
    def timezone(self) -> str:
        return self._plan.timezone

    @property
    def public_ip(self) -> Optional[str]:
        """Proxy exit IP, when a geo lookup succeeded."""
        return self._plan.public_ip

    @property
    def cdp_endpoint(self) -> str:
        """``ws://`` URL of the browser - hand this to any CDP-speaking tool."""
        return self._endpoint

    @property
    def cdp_url(self) -> str:
        """``http://127.0.0.1:<port>`` - the form crawl4ai / browser-use want."""
        return self._plan.cdp_url

    @property
    def pid(self) -> Optional[int]:
        return self._process.pid if self._process else None

    @property
    def synced(self) -> bool:
        """Whether this profile has a cloud archive slot (paid plans only)."""
        return self._plan.archive is not None

    @property
    def sync_error(self) -> Optional[str]:
        """Why the closing upload failed, if it did.

        Worth checking after ``close()``: the local profile is still intact, but
        the work done in this session did not reach the cloud, so another machine
        would open a stale copy.
        """
        return self._sync_error

    @property
    def live_view(self) -> Optional[LiveViewSession]:
        """The running live view, when this launch asked for one. Its
        ``view_url`` is where to watch the session."""
        return self._live_view

    def _stop_live_view(self) -> None:
        if self._live_view is not None:
            self._live_view.stop()
            self._live_view = None

    def _settle_crypt_state(self) -> None:
        """Record what ``--fp-crypt-key`` actually did, before anything is packed.

        The kernel has stopped and flushed ``Local State``, so this is the first
        moment its outcome can be read - and the last one before the pack below
        turns this directory into the archive every other machine will restore. A
        build that ignored the switch settles as plain here, so nothing claims an
        encryption that was never applied.
        """
        try:
            settle_crypt_state(self._plan.profile_dir)
        except OSError:
            pass  # an unwritable directory is not worth failing a finished session

    def _upload_archive(self) -> None:
        """Pack and upload the profile, after the kernel process is gone.

        Only ever called once, and never raises - a browsing session that ends
        with a failed upload is still a session that happened.
        """
        archive = self._plan.archive
        if archive is None or not archive.can_upload or self._uploaded:
            return
        self._uploaded = True
        archive.emit("upload", "start")
        try:
            version = self._put_archive(archive)
        except ProfileCacheError as error:
            self._sync_error = str(error)
            archive.emit("upload", "error", str(error))
        else:
            # No ETag means we cannot name what was just written; drop the marker
            # so the next launch restores rather than trusting a stale generation.
            if version:
                write_archive_version(self._plan.profile_dir, version)
            else:
                clear_archive_version(self._plan.profile_dir)
            archive.emit("upload", "done")

    def _put_archive(self, archive: ArchivePlan) -> Optional[str]:
        url = archive.sign_upload() if archive.sign_upload else None
        if not url:
            raise ProfileCacheError("No upload URL for the profile archive")
        try:
            return upload_profile_cache(self._plan.profile_dir, url)
        except ProfileCacheError as error:
            # A signature that expired between signing and the last byte: sign
            # once more rather than losing the session's cookies and passkeys.
            if "HTTP 401" not in str(error) and "HTTP 403" not in str(error):
                raise
            fresh = archive.sign_upload() if archive.sign_upload else None
            if not fresh:
                raise
            return upload_profile_cache(self._plan.profile_dir, fresh)

    def __repr__(self) -> str:
        return "<{0} profile={1!r} kernel={2} cdp={3}>".format(
            type(self).__name__, self._plan.profile_dir.name, self._plan.kernel_version, self.cdp_url
        )


class Antibrow(_BaseSession):
    """A running fingerprint browser (synchronous API).

    Attribute lookups fall through to the underlying Playwright
    ``BrowserContext``, so ``browser.new_page()``, ``browser.cookies()``,
    ``browser.add_init_script(...)`` and friends work directly. The raw
    Playwright objects are available as ``.browser`` and ``.context``.
    """

    def __init__(
        self,
        plan: LaunchPlan,
        process: subprocess.Popen,
        endpoint: str,
        playwright: Any,
        browser: Any,
        context: Any,
        reuse_initial_page: bool = True,
    ) -> None:
        super().__init__(plan, process, endpoint)
        self._playwright = playwright
        self.browser = browser
        self.context = context
        pages = list(context.pages)
        self._initial_page = pages[0] if pages else None
        self._initial_page_available = reuse_initial_page and self._initial_page is not None

    @property
    def page(self):
        """The first page, creating one if the browser opened without any."""
        pages = list(self.context.pages)
        if pages:
            self._initial_page_available = False
            return pages[0]
        return self.new_page()

    def new_page(self):
        """Open a page.

        Chromium always starts with one blank tab; the first call hands that tab
        back instead of leaving an orphan window around. Every later call opens a
        real new tab. Use ``browser.context.new_page()`` to always create one.
        """
        if self._initial_page_available and self._initial_page is not None:
            self._initial_page_available = False
            if not self._initial_page.is_closed():
                return self._initial_page
        return self.context.new_page()

    def close(self) -> None:
        """Close the browser, stop the kernel, then save to the cloud. Idempotent.

        The upload runs last on purpose: the profile directory is only consistent
        (and unlocked, on Windows) once the kernel is gone.
        """
        if self._closed:
            return
        self._closed = True
        # Browser.close over the live CDP connection first: browser.close() only
        # drops the connection for a browser we attached to, so disconnecting
        # before asking would leave nothing to ask with.
        #
        # It has to happen on this thread. Playwright's sync API is greenlet-bound,
        # so handing this call to shutdown_kernel's watchdog thread makes it raise
        # without ever reaching the browser - the kernel then sits out the whole
        # grace period and is SIGKILLed, which is the exact outcome asking politely
        # exists to avoid. AsyncAntibrow.close does the same thing on its loop.
        self._stop_live_view()
        try:
            self.browser.new_browser_cdp_session().send("Browser.close")
        except Exception:
            pass  # the connection drops with the browser; the wait below decides
        shutdown_kernel(lambda: None, self._process)
        try:
            self.browser.close()
        except Exception:
            pass
        try:
            self._playwright.stop()
        except Exception:
            pass
        _revoke_ticket(self._plan.proxy_ticket)
        self._settle_crypt_state()
        self._upload_archive()

    def __enter__(self) -> "Antibrow":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def __getattr__(self, name: str) -> Any:
        # Only reached for names this class does not define; delegate to the
        # Playwright context so the handle behaves like a BrowserContext.
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            context = object.__getattribute__(self, "context")
        except AttributeError:
            raise AttributeError(name)
        return getattr(context, name)


class AsyncAntibrow(_BaseSession):
    """A running fingerprint browser (asyncio API). See :class:`Antibrow`."""

    def __init__(
        self,
        plan: LaunchPlan,
        process: subprocess.Popen,
        endpoint: str,
        playwright: Any,
        browser: Any,
        context: Any,
        reuse_initial_page: bool = True,
    ) -> None:
        super().__init__(plan, process, endpoint)
        self._playwright = playwright
        self.browser = browser
        self.context = context
        pages = list(context.pages)
        self._initial_page = pages[0] if pages else None
        self._initial_page_available = reuse_initial_page and self._initial_page is not None

    async def new_page(self):
        """Open a page (reusing Chromium's initial blank tab exactly once)."""
        if self._initial_page_available and self._initial_page is not None:
            self._initial_page_available = False
            if not self._initial_page.is_closed():
                return self._initial_page
        return await self.context.new_page()

    async def page(self):
        """The first page, creating one when the browser opened without any."""
        pages = list(self.context.pages)
        if pages:
            self._initial_page_available = False
            return pages[0]
        return await self.new_page()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._stop_live_view)
        try:
            cdp = await self.browser.new_browser_cdp_session()
            await cdp.send("Browser.close")
        except Exception:
            pass  # The connection drops with the browser; the wait below decides.
        await loop.run_in_executor(None, shutdown_kernel, lambda: None, self._process)
        try:
            await self.browser.close()
        except Exception:
            pass
        try:
            await self._playwright.stop()
        except Exception:
            pass
        # Revoking and uploading both block on the network; keep the loop free.
        await loop.run_in_executor(None, _revoke_ticket, self._plan.proxy_ticket)
        await loop.run_in_executor(None, self._settle_crypt_state)
        await loop.run_in_executor(None, self._upload_archive)

    async def __aenter__(self) -> "AsyncAntibrow":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.close()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            context = object.__getattribute__(self, "context")
        except AttributeError:
            raise AttributeError(name)
        return getattr(context, name)


def _stray_locale_tab_language(plan: LaunchPlan) -> Optional[str]:
    """The language whose stray tab needs closing, or None when there isn't one.

    Only darwin passes ``-AppleLanguages``, and only that pair produces the tab.
    """
    if sys.platform != "darwin" or "-AppleLanguages" not in plan.args:
        return None
    return plan.persona.languages[0] if plan.persona.languages else "en-US"


def _history_mentions_stray_locale(entries: Any, language: str) -> bool:
    """True if a navigation history entry was aimed at the ``(xx-XX)`` argument."""
    for entry in entries or []:
        for key in ("url", "userTypedURL"):
            if is_stray_locale_tab_url(entry.get(key) or "", language):
                return True
    return False


def _close_stray_locale_tab(context: Any, plan: LaunchPlan, timeout: float = 3.0) -> None:
    """Close the tab Chromium opened for the ``-AppleLanguages`` value.

    Worth a short poll: the startup navigation may not have committed yet when
    CDP starts answering, and ``page.url`` would still read ``about:blank``.
    Once it has committed, ``(en-us)`` is not a resolvable host, so the tab reads
    ``chrome-error://chromewebdata/`` even though the address bar still shows
    ``(en-us)`` - hence the navigation-history check.
    """
    language = _stray_locale_tab_language(plan)
    if language is None:
        return
    deadline = time.monotonic() + timeout
    while True:
        try:
            pages = list(context.pages)
            stray = []
            for page in pages:
                url = page.url
                if is_stray_locale_tab_url(url, language):
                    stray.append(page)
                elif url.startswith("chrome-error:"):
                    session = context.new_cdp_session(page)
                    try:
                        history = session.send("Page.getNavigationHistory")
                    finally:
                        session.detach()
                    if _history_mentions_stray_locale(history.get("entries"), language):
                        stray.append(page)
            if stray:
                # Something has to stay open: closing the last tab takes the
                # window - and with it the kernel - down.
                if len(stray) == len(pages):
                    context.new_page()
                for page in stray:
                    page.close()
                return
        except Exception:
            return  # never let cosmetics fail a launch
        if time.monotonic() >= deadline:
            return
        time.sleep(0.1)


async def _close_stray_locale_tab_async(context: Any, plan: LaunchPlan, timeout: float = 3.0) -> None:
    """asyncio twin of :func:`_close_stray_locale_tab`."""
    language = _stray_locale_tab_language(plan)
    if language is None:
        return
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        try:
            pages = list(context.pages)
            stray = []
            for page in pages:
                url = page.url
                if is_stray_locale_tab_url(url, language):
                    stray.append(page)
                elif url.startswith("chrome-error:"):
                    session = await context.new_cdp_session(page)
                    try:
                        history = await session.send("Page.getNavigationHistory")
                    finally:
                        await session.detach()
                    if _history_mentions_stray_locale(history.get("entries"), language):
                        stray.append(page)
            if stray:
                if len(stray) == len(pages):
                    await context.new_page()
                for page in stray:
                    await page.close()
                return
        except Exception:
            return
        if loop.time() >= deadline:
            return
        await asyncio.sleep(0.1)


def _ensure_startup_page(context: Any) -> None:
    """Open the first page when the kernel handed over none.

    Normally a no-op: the kernel's own startup window provides it. This covers a
    launch that ends up with zero pages (e.g. extra ``args`` suppressing the
    startup window), because callers and ``reuse_initial_page`` expect one.
    """
    if not list(context.pages):
        try:
            context.new_page()
        except Exception:
            pass  # the caller's own new_page() will report a real failure


async def _ensure_startup_page_async(context: Any) -> None:
    """asyncio twin of :func:`_ensure_startup_page`."""
    if not list(context.pages):
        try:
            await context.new_page()
        except Exception:
            pass


def _start_process(plan: LaunchPlan, timeout: float, on_progress: Optional[ProgressCallback]):
    """Spawn the kernel and block until its CDP endpoint answers."""
    notify = on_progress or (lambda _message: None)
    notify("Spawning kernel {0} (cdp port {1})".format(plan.exe_path.name, plan.cdp_port))
    process = spawn_kernel(plan.exe_path, plan.args)
    output: List[str] = []
    _drain_output(process, output)
    try:
        endpoint = wait_for_cdp(
            process, plan.cdp_port, plan.user_data_dir, timeout=timeout, output=output,
            on_progress=on_progress,
        )
    except BaseException:
        kill_process_tree(process)
        raise
    return process, endpoint


def launch(
    profile: str = DEFAULT_PROFILE,
    *,
    headless: bool = False,
    focus_window: bool = True,
    proxy: ProxyLike = None,
    proxy_id: Optional[str] = None,
    proxy_host: Optional[str] = None,
    geoip: bool = True,
    timezone: Optional[str] = None,
    api_key: Optional[str] = None,
    server: Optional[str] = None,
    cache_dir: Optional[Path | str] = None,
    profile_dir: Optional[Path | str] = None,
    kernel_version: Optional[str] = None,
    label: Optional[str] = None,
    args: Optional[Sequence[str]] = None,
    proxy_auth: str = "native",
    license_token: Optional[str] = None,
    license_provider: Optional[LicenseProvider] = None,
    crypt_key: Optional[str] = None,
    get_crypt_key: Optional[Callable[[], Optional[str]]] = None,
    update_kernel: bool = False,
    webauthn_capture: Optional[bool] = None,
    restore_tabs: bool = True,
    device_type: Optional[DeviceType] = None,
    real_fingerprint: bool = False,
    canvas_noise: Optional[bool] = None,
    api_log: Optional[str] = None,
    live_view: "bool | LiveViewOptions" = False,
    relay_url: Optional[str] = None,
    sync: Optional[bool] = None,
    temporary: bool = False,
    on_sync: Optional[SyncCallback] = None,
    reuse_initial_page: bool = True,
    timeout: float = DEFAULT_LAUNCH_TIMEOUT,
    on_progress: Optional[ProgressCallback] = None,
) -> Antibrow:
    """Launch a fingerprint browser and return a handle you can drive at once.

    >>> from antibrow import launch
    >>> browser = launch()
    >>> page = browser.new_page()
    >>> page.goto("https://example.com")
    >>> browser.close()

    Args:
        profile: Profile name. Persists on disk; the same name always gets the
            same fingerprint, cookies and storage. Unlimited and free locally.
        headless: Hide the window. On Windows the window is moved off-screen
            rather than using ``--headless=new`` (headless Chromium has its own
            detectable fingerprint). On Linux, run under Xvfb.
        focus_window: Whether the new window takes focus. ``False`` opens it
            behind whatever is in front, so a launch does not interrupt what you
            are doing - the window is still there, just not focused. Decided in
            the kernel, so install the latest kernel before relying on it.
        proxy: ``"http://user:pass@host:port"``, ``"socks5://..."``, or a
            Playwright-style ``{"server": ..., "username": ..., "password": ...}``.
        geoip: Look the proxy's exit IP up and make the browser's timezone follow
            it. Ignored without a proxy.
        timezone: Force an IANA timezone, overriding the geo lookup.
        api_key: AntiBrow API key. Falls back to ``$ANTIBROW_API_KEY`` and then
            ``~/.antibrow/license.key``.
        server: License server base URL (for self-hosted deployments).
        cache_dir: Where kernels and profiles live. Default
            ``~/.anti-detect-browser``, shared with the Node SDK and desktop app.
        profile_dir: Exact profile directory, bypassing ``cache_dir``. Still
            consults ``profile`` as the name (for the archive slot and the
            label) when the directory carries no ``profile.json`` record;
            a directory with a record keeps its recorded name instead.
        kernel_version: Kernel for a *new* profile, e.g. ``"151"``.
            Existing profiles keep the version frozen in their persona.
        label: Text shown in the kernel's address-bar tag. Defaults to the
            profile name - handy when several windows are open.
        args: Extra Chromium switches.
        proxy_auth: ``"native"`` (kernel-level, no extension) or ``"extension"``
            (legacy MV3 fallback for HTTP proxies).
        license_token: Use a pre-minted token instead of calling the server.
        license_provider: Callable returning a token - plug in your own issuer.
        proxy_id: Use one of your managed proxies instead of your own. The
            upstream endpoint is resolved server-side and never reaches this
            machine; the launch activates the proxy, takes a short-lived ticket
            and hands the kernel a ``relay://`` URL. Mutually exclusive with
            ``proxy``. The ticket is revoked on ``close()``.
        proxy_host: Relay host for ``proxy_id``. Defaults to whatever the server
            names, then to ``proxy.antibrow.com``.
        canvas_noise: ``False`` turns off the per-profile Canvas and WebGL
            noise. On by default in the kernel; leaving this unset writes the
            same fp-config as before the switch existed.
        api_log: Log the fingerprint APIs pages touch to
            ``<profile>/fp-api-log.jsonl``. ``"off"`` (default), ``"curated"``
            or ``"all"``.
        crypt_key: Pre-fetched encryption key, used instead of asking the server
            for one. Ignored unless the profile directory says its data was
            created under a key.
        get_crypt_key: Where that key comes from when the profile needs one.
            Defaults to this account's own profile endpoint.
        update_kernel: Check for a newer build of this profile's kernel and
            install it before launching.
        webauthn_capture: Keep newly registered passkeys in this profile's
            portable store (the default), so they travel with an export or a
            cloud sync. ``False`` lets the browser ask where to save instead
            (phone / security key) and those stay on this device.
        device_type: Simulate an Android phone instead of a desktop browser.
            Applies only when the profile is first created; an existing
            profile keeps the device type frozen in its own persona.
        real_fingerprint: Draw this profile's identity from the real-device
            fingerprint library instead of generating one (paid plans; the
            server rejects free-plan requests). Applies only when the profile
            is first created.
        sync: Cloud profile sync - restore the profile before launching and save
            it after closing, so another machine opens the same cookies, storage
            and passkeys. Default (``None``) follows the plan the API key is on;
            ``False`` keeps this launch local; ``True`` attempts it regardless.
        temporary: Put this profile in the temporary tree. Temporary profiles
            are local-only, do not appear in the desktop app profile list, and
            are never deleted automatically - clear them with
            ``clear_temporary_profiles()``.
        on_sync: Called with a :class:`SyncEvent` as each transfer starts and
            finishes. Sync problems are reported here and on
            ``session.sync_error``, never raised.
        reuse_initial_page: Let the first ``new_page()`` return Chromium's
            initial blank tab instead of opening a second one.
        timeout: Seconds to wait for the browser to come up.
        on_progress: Called with human-readable progress messages.

    Returns:
        :class:`Antibrow` - delegates to the Playwright ``BrowserContext``.
    """
    from playwright.sync_api import sync_playwright

    plan = prepare_launch(
        profile,
        headless=headless,
        focus_window=focus_window,
        proxy=proxy,
        geoip=geoip,
        timezone=timezone,
        api_key=api_key,
        server=server,
        cache_dir=cache_dir,
        profile_dir=profile_dir,
        kernel_version=kernel_version,
        label=label,
        args=args,
        proxy_auth=proxy_auth,
        license_token=license_token,
        license_provider=license_provider,
        crypt_key=crypt_key,
        get_crypt_key=get_crypt_key,
        proxy_id=proxy_id,
        proxy_host=proxy_host,
        canvas_noise=canvas_noise,
        api_log=api_log,
        update_kernel=update_kernel,
        webauthn_capture=webauthn_capture,
        restore_tabs=restore_tabs,
        device_type=device_type,
        real_fingerprint=real_fingerprint,
        sync=sync,
        temporary=temporary,
        on_sync=on_sync,
        on_progress=on_progress,
    )
    process, endpoint = _start_process(plan, timeout, on_progress)

    playwright = sync_playwright().start()
    try:
        browser = playwright.chromium.connect_over_cdp(endpoint, timeout=timeout * 1000)
        contexts = list(browser.contexts)
        context = contexts[0] if contexts else browser.new_context()
        # Order matters: the guard runs first so a kernel that did open the
        # locale tab has it closed, then we make sure exactly one page is left.
        _close_stray_locale_tab(context, plan)
        _ensure_startup_page(context)
    except BaseException:
        try:
            playwright.stop()
        except Exception:
            pass
        kill_process_tree(process)
        _revoke_ticket(plan.proxy_ticket)
        raise
    session = Antibrow(plan, process, endpoint, playwright, browser, context, reuse_initial_page)
    session._live_view = _start_live_view(
        context,
        session.page,
        live_view=live_view,
        relay_url=relay_url,
        api_key=api_key,
        server=server,
        plan=plan,
        notify=on_progress or (lambda _message: None),
    )
    return session


async def launch_async(
    profile: str = DEFAULT_PROFILE,
    *,
    headless: bool = False,
    focus_window: bool = True,
    proxy: ProxyLike = None,
    proxy_id: Optional[str] = None,
    proxy_host: Optional[str] = None,
    geoip: bool = True,
    timezone: Optional[str] = None,
    api_key: Optional[str] = None,
    server: Optional[str] = None,
    cache_dir: Optional[Path | str] = None,
    profile_dir: Optional[Path | str] = None,
    kernel_version: Optional[str] = None,
    label: Optional[str] = None,
    args: Optional[Sequence[str]] = None,
    proxy_auth: str = "native",
    license_token: Optional[str] = None,
    license_provider: Optional[LicenseProvider] = None,
    crypt_key: Optional[str] = None,
    get_crypt_key: Optional[Callable[[], Optional[str]]] = None,
    update_kernel: bool = False,
    webauthn_capture: Optional[bool] = None,
    restore_tabs: bool = True,
    device_type: Optional[DeviceType] = None,
    real_fingerprint: bool = False,
    canvas_noise: Optional[bool] = None,
    api_log: Optional[str] = None,
    live_view: "bool | LiveViewOptions" = False,
    relay_url: Optional[str] = None,
    sync: Optional[bool] = None,
    temporary: bool = False,
    on_sync: Optional[SyncCallback] = None,
    reuse_initial_page: bool = True,
    timeout: float = DEFAULT_LAUNCH_TIMEOUT,
    on_progress: Optional[ProgressCallback] = None,
) -> AsyncAntibrow:
    """asyncio twin of :func:`launch`.

    >>> browser = await launch_async()
    >>> page = await browser.new_page()
    >>> await page.goto("https://example.com")
    >>> await browser.close()

    The blocking prep work (kernel download, geo lookup, license fetch, process
    spawn) runs in a worker thread, so the event loop is never blocked.
    """
    from playwright.async_api import async_playwright

    loop = asyncio.get_running_loop()

    def _prepare() -> LaunchPlan:
        return prepare_launch(
            profile,
            headless=headless,
            focus_window=focus_window,
            proxy=proxy,
            geoip=geoip,
            timezone=timezone,
            api_key=api_key,
            server=server,
            cache_dir=cache_dir,
            profile_dir=profile_dir,
            kernel_version=kernel_version,
            label=label,
            args=args,
            proxy_auth=proxy_auth,
            license_token=license_token,
            license_provider=license_provider,
            crypt_key=crypt_key,
            get_crypt_key=get_crypt_key,
            proxy_id=proxy_id,
            proxy_host=proxy_host,
            canvas_noise=canvas_noise,
            api_log=api_log,
            update_kernel=update_kernel,
            webauthn_capture=webauthn_capture,
            restore_tabs=restore_tabs,
            device_type=device_type,
            real_fingerprint=real_fingerprint,
            sync=sync,
            temporary=temporary,
            on_sync=on_sync,
            on_progress=on_progress,
        )

    plan = await loop.run_in_executor(None, _prepare)
    process, endpoint = await loop.run_in_executor(
        None, _start_process, plan, timeout, on_progress
    )

    playwright = await async_playwright().start()
    try:
        browser = await playwright.chromium.connect_over_cdp(endpoint, timeout=timeout * 1000)
        contexts = list(browser.contexts)
        context = contexts[0] if contexts else await browser.new_context()
        await _close_stray_locale_tab_async(context, plan)
        await _ensure_startup_page_async(context)
    except BaseException:
        try:
            await playwright.stop()
        except Exception:
            pass
        await loop.run_in_executor(None, kill_process_tree, process)
        await loop.run_in_executor(None, _revoke_ticket, plan.proxy_ticket)
        raise
    session = AsyncAntibrow(plan, process, endpoint, playwright, browser, context, reuse_initial_page)
    if live_view:
        # The stream drives a CDP session of its own and blocks on a socket, so
        # it is built off the event loop like the other network work here.
        page = await session.page()
        session._live_view = await loop.run_in_executor(
            None,
            lambda: _start_live_view(
                context,
                page,
                live_view=live_view,
                relay_url=relay_url,
                api_key=api_key,
                server=server,
                plan=plan,
                notify=on_progress or (lambda _message: None),
            ),
        )
    return session


def launch_persistent_context(profile: str = DEFAULT_PROFILE, **kwargs: Any) -> "SyncBrowserContext":
    """Return the raw Playwright ``BrowserContext`` for a persistent profile.

    Named after ``playwright.chromium.launch_persistent_context`` because it
    plays the same role - drop-in for code already written against it. Every
    antibrow profile is persistent, so this is just :func:`launch` without the
    convenience wrapper.

    The kernel process is closed when you close the context, but the handle
    returned by :func:`launch` gives a cleaner shutdown (it also reaps the
    process tree), so prefer that unless an existing API demands a
    ``BrowserContext``.
    """
    session = launch(profile, **kwargs)
    context = session.context
    # Keep the session alive for as long as the context lives, and make
    # context.close() tear the kernel down too.
    original_close = context.close

    def _close(**close_kwargs: Any) -> None:
        try:
            original_close(**close_kwargs)
        finally:
            session.close()

    context.close = _close  # type: ignore[method-assign]
    context.antibrow = session  # type: ignore[attr-defined]
    return context


async def launch_persistent_context_async(
    profile: str = DEFAULT_PROFILE, **kwargs: Any
) -> "AsyncBrowserContext":
    """asyncio twin of :func:`launch_persistent_context`."""
    session = await launch_async(profile, **kwargs)
    context = session.context
    original_close = context.close

    async def _close(**close_kwargs: Any) -> None:
        try:
            await original_close(**close_kwargs)
        finally:
            await session.close()

    context.close = _close  # type: ignore[method-assign]
    context.antibrow = session  # type: ignore[attr-defined]
    return context

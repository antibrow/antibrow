"""The public ``launch`` API.

One call does the whole sequence:

1. resolve the profile directory and load (or mint and freeze) its persona;
2. make sure the kernel build that profile is pinned to is on disk;
3. look up the proxy's exit timezone, when a proxy is in play;
4. get a license token (server-issued - see :mod:`antibrow.license`);
5. serialize the persona to ``fp-config.json`` and spawn the kernel;
6. attach Playwright over CDP and hand back a ready-to-drive browser.
"""

from __future__ import annotations

import asyncio
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, List, Optional, Sequence

from . import config as _config
from . import kernel as _kernel
from .geoip import lookup_proxy_geo
from .launcher import (
    DEFAULT_LAUNCH_TIMEOUT,
    _drain_output,
    build_launch_args,
    kill_process_tree,
    pick_free_port,
    spawn_kernel,
    wait_for_cdp,
)
from .license import LicenseInfo, LicenseProvider, get_license_token
from .persona import Persona, load_or_generate_persona, write_fp_config
from .proxy import ProxyLike, ProxySpec, parse_proxy

if TYPE_CHECKING:  # pragma: no cover - typing only
    from playwright.async_api import BrowserContext as AsyncBrowserContext
    from playwright.sync_api import BrowserContext as SyncBrowserContext

ProgressCallback = Callable[[str], None]

DEFAULT_PROFILE = "default"


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

    @property
    def cdp_url(self) -> str:
        return "http://127.0.0.1:{0}".format(self.cdp_port)

    def redacted_args(self) -> List[str]:
        """Arguments with the license token and proxy password masked."""
        out = []
        for arg in self.args:
            if arg.startswith("--fp-license="):
                out.append("--fp-license=<redacted>")
            elif arg.startswith("--proxy-server=") and self.proxy is not None:
                out.append("--proxy-server={0}".format(self.proxy.to_url(with_credentials=False)))
            else:
                out.append(arg)
        return out


def prepare_launch(
    profile: str = DEFAULT_PROFILE,
    *,
    headless: bool = False,
    proxy: ProxyLike = None,
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
    update_kernel: bool = False,
    on_progress: Optional[ProgressCallback] = None,
) -> LaunchPlan:
    """Do every blocking step of a launch except starting the process.

    Separated out so the async API can run it in a worker thread and so tests
    can inspect the exact command line without a browser.
    """
    notify = on_progress or (lambda _message: None)

    root = Path(cache_dir).expanduser() if cache_dir else _config.default_cache_dir()
    directory = Path(profile_dir).expanduser() if profile_dir else _config.profile_dir(profile, root)
    directory.mkdir(parents=True, exist_ok=True)

    # A profile that already exists keeps the kernel version frozen into its
    # persona; `kernel_version` only decides what a brand-new profile gets.
    default_kv = (
        _kernel.find_kernel_version(kernel_version)
        if kernel_version
        else _kernel.default_kernel_version()
    )
    notify("Loading persona")
    persona = load_or_generate_persona(directory, default_kv.version)
    kv = _kernel.find_kernel_version(persona.kernel_version)

    if update_kernel:
        # Opt-in: pull a rebuilt same-version kernel before launching. Offline
        # is fine - we just keep whatever is installed.
        if _kernel.refresh_kernel_catalogue():
            kv = _kernel.find_kernel_version(persona.kernel_version)
        status = _kernel.kernel_update_status(root, kv.version)
        if status is not None and status.update_available:
            notify("Updating kernel {0} to the latest build".format(kv.label))
            _kernel.ensure_kernel(root, kv, on_progress, force=True)

    notify("Ensuring kernel {0}".format(kv.label))
    exe_path = _kernel.ensure_kernel(root, kv, on_progress)

    proxy_spec = parse_proxy(proxy)
    resolved_timezone = timezone or persona.timezone
    public_ip: Optional[str] = None
    if proxy_spec is not None and geoip:
        notify("Looking up proxy geo")
        geo = lookup_proxy_geo(proxy_spec)
        if geo is not None:
            if geo.timezone and not timezone:
                resolved_timezone = geo.timezone
            if geo.ip:
                public_ip = geo.ip

    notify("Obtaining license token")
    license_info = get_license_token(
        api_key,
        server,
        license_token=license_token,
        license_provider=license_provider,
    )

    display_label = label or (profile if profile_dir is None else directory.name)
    fp_config_path = write_fp_config(
        directory,
        persona,
        label=display_label,
        timezone=resolved_timezone,
        public_ip=public_ip,
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
        platform=_kernel.current_platform(),
        proxy=proxy_spec,
        proxy_auth=proxy_auth,
        profile_dir=directory,
        extra_args=args,
    )

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
    )


class _BaseSession:
    """Shared state/reporting for the sync and async browser handles."""

    def __init__(self, plan: LaunchPlan, process: subprocess.Popen, endpoint: str) -> None:
        self._plan = plan
        self._process = process
        self._endpoint = endpoint
        self._closed = False

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
        """Close the browser and stop the kernel process. Idempotent."""
        if self._closed:
            return
        self._closed = True
        try:
            self.browser.close()
        except Exception:
            pass
        try:
            self._playwright.stop()
        except Exception:
            pass
        kill_process_tree(self._process)

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
        try:
            await self.browser.close()
        except Exception:
            pass
        try:
            await self._playwright.stop()
        except Exception:
            pass
        await asyncio.get_running_loop().run_in_executor(None, kill_process_tree, self._process)

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
    proxy: ProxyLike = None,
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
    update_kernel: bool = False,
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
        profile_dir: Exact profile directory, bypassing ``cache_dir``/``profile``.
        kernel_version: Kernel for a *new* profile, e.g. ``"150.0.7871.182"``.
            Existing profiles keep the version frozen in their persona.
        label: Text shown in the kernel's address-bar tag. Defaults to the
            profile name - handy when several windows are open.
        args: Extra Chromium switches.
        proxy_auth: ``"native"`` (kernel-level, no extension) or ``"extension"``
            (legacy MV3 fallback for HTTP proxies).
        license_token: Use a pre-minted token instead of calling the server.
        license_provider: Callable returning a token - plug in your own issuer.
        update_kernel: Check for a newer build of this profile's kernel and
            install it before launching.
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
        update_kernel=update_kernel,
        on_progress=on_progress,
    )
    process, endpoint = _start_process(plan, timeout, on_progress)

    playwright = sync_playwright().start()
    try:
        browser = playwright.chromium.connect_over_cdp(endpoint, timeout=timeout * 1000)
        contexts = list(browser.contexts)
        context = contexts[0] if contexts else browser.new_context()
    except BaseException:
        try:
            playwright.stop()
        except Exception:
            pass
        kill_process_tree(process)
        raise
    return Antibrow(plan, process, endpoint, playwright, browser, context, reuse_initial_page)


async def launch_async(
    profile: str = DEFAULT_PROFILE,
    *,
    headless: bool = False,
    proxy: ProxyLike = None,
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
    update_kernel: bool = False,
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
            update_kernel=update_kernel,
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
    except BaseException:
        try:
            await playwright.stop()
        except Exception:
            pass
        await loop.run_in_executor(None, kill_process_tree, process)
        raise
    return AsyncAntibrow(plan, process, endpoint, playwright, browser, context, reuse_initial_page)


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

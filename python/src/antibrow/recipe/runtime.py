"""Running one recipe: open the page, enforce the declaration, call ``run()``."""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Set, Tuple
from urllib.parse import urlparse

from ..config import default_cache_dir
from .bootstrap import build_runner_expression
from .registry import assert_runnable, ensure_recipe_source, load_registry
from .source import RecipeEntry, RecipeError, RecipeMeta, coerce_args, resolve_entry

DEFAULT_RECIPE_TIMEOUT = 60.0
_LOG_BINDING = "__antibrowRecipeLog"
_CONTEXT_LOST = re.compile(
    r"Execution context was destroyed|Cannot find context|frame was detached", re.I
)
#: Attempts, not retries. Two was not enough: an anti-bot interstitial redirects
#: to itself and then to the real page, so the recipe can lose its context twice
#: in a row through no fault of its own.
_EVALUATE_ATTEMPTS = 3


@dataclass(frozen=True)
class RecipeRunResult:
    id: str
    profile: str
    value: Any
    #: Hosts the recipe tried to reach that ``meta.domains`` does not declare.
    blocked_hosts: Tuple[str, ...] = ()
    logs: Tuple[str, ...] = ()
    duration_ms: int = 0


def temporary_recipe_profile_name(recipe_id: str) -> str:
    slug = "".join(c if c.isalnum() else "-" for c in recipe_id)
    return "recipe-{0}-{1}".format(slug, uuid.uuid4().hex[:6])


def _host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def _payload(meta: RecipeMeta, args: Optional[Mapping[str, Any]], profile: str, timeout: float) -> Dict[str, Any]:
    return {
        "args": coerce_args(meta, args),
        "profileName": profile,
        "timeoutMs": int(max(timeout, 0) * 1000),
    }


def _failure(meta: RecipeMeta, error: Exception, blocked: Set[str], entry: str = "") -> RecipeError:
    # A blocked host is the likeliest cause of a recipe failing on a machine
    # where it used to work, and the recipe cannot see the block itself. So is a
    # Content-Security-Policy on the entry page: a bare JSON endpoint usually
    # sends ``default-src 'none'``, which vetoes every fetch made from it.
    if blocked:
        hint = " (blocked, not in meta.domains: {0})".format(", ".join(sorted(blocked)))
    elif "Failed to fetch" in str(error):
        hint = (
            " (the page at {0} may forbid this request through its own Content-Security-Policy"
            " - use an entry page on the site itself rather than a bare API endpoint)".format(entry or meta.entry)
        )
    else:
        hint = ""
    return RecipeError("{0}: {1}{2}".format(meta.id, error, hint))


def _evaluate_once(page: Any, expression: str, timeout: float) -> Any:
    """Evaluate the recipe, tolerating the entry page settling underneath it.

    A redirect, a consent bounce or a client-side route change destroys the
    context the recipe was evaluating in. That is the page's business rather
    than the recipe's, so it gets one more go once the navigation has landed.
    """
    for attempt in range(1, _EVALUATE_ATTEMPTS + 1):
        try:
            return page.evaluate(expression)
        except Exception as exc:  # noqa: BLE001 - re-raised unless it is the lost context
            if not _CONTEXT_LOST.search(str(exc)) or attempt >= _EVALUATE_ATTEMPTS:
                raise
            try:
                page.wait_for_load_state("domcontentloaded", timeout=max(timeout, 1) * 1000)
            except Exception:
                pass
    raise AssertionError("unreachable")  # pragma: no cover


async def _evaluate_once_async(page: Any, expression: str, timeout: float) -> Any:
    """The async mirror of :func:`_evaluate_once`."""
    for attempt in range(1, _EVALUATE_ATTEMPTS + 1):
        try:
            return await page.evaluate(expression)
        except Exception as exc:  # noqa: BLE001
            if not _CONTEXT_LOST.search(str(exc)) or attempt >= _EVALUATE_ATTEMPTS:
                raise
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=max(timeout, 1) * 1000)
            except Exception:
                pass
    raise AssertionError("unreachable")  # pragma: no cover


def run_recipe_on_page(
    meta: RecipeMeta,
    source: str,
    *,
    page: Any,
    context: Any,
    profile_name: str,
    args: Optional[Mapping[str, Any]] = None,
    timeout: float = DEFAULT_RECIPE_TIMEOUT,
    on_log: Optional[Callable[[str], None]] = None,
) -> RecipeRunResult:
    """Run one recipe against an already-open page.

    Split out from :func:`run_recipe` so the enforcement below can be exercised
    without a kernel: it is the part that has to hold.
    """
    payload = _payload(meta, args, profile_name, timeout)
    entry = resolve_entry(meta, payload["args"])
    allowed = {d.lower() for d in meta.domains}
    blocked: Set[str] = set()
    logs: List[str] = []
    started = time.time()

    # The declaration is enforced here, at the network layer, and not inside the
    # helpers a recipe is asked to use: run() executes in the page, so it can
    # always call fetch itself. Anything but a declared host is aborted, which is
    # what stops a recipe for one site from spending another site's cookies.
    def guard(route: Any) -> None:
        host = _host_of(route.request.url)
        if not host or host in allowed:
            route.continue_()
            return
        blocked.add(host)
        route.abort("blockedbyclient")

    def log(message: str) -> None:
        logs.append(str(message))
        if on_log is not None:
            on_log(str(message))

    try:
        page.expose_function(_LOG_BINDING, log)
    except Exception:
        pass  # already bound on a reused page

    context.route("**/*", guard)
    try:
        page.goto(entry, wait_until="domcontentloaded", timeout=max(timeout, 1) * 1000)
        value = _evaluate_once(page, build_runner_expression(source, payload), timeout)
    except Exception as exc:  # noqa: BLE001 - re-raised with the blocked hosts named
        raise _failure(meta, exc, blocked, entry) from exc
    finally:
        try:
            context.unroute("**/*", guard)
        except Exception:
            pass
    return RecipeRunResult(
        id=meta.id,
        profile=profile_name,
        value=value,
        blocked_hosts=tuple(sorted(blocked)),
        logs=tuple(logs),
        duration_ms=int((time.time() - started) * 1000),
    )


async def run_recipe_on_page_async(
    meta: RecipeMeta,
    source: str,
    *,
    page: Any,
    context: Any,
    profile_name: str,
    args: Optional[Mapping[str, Any]] = None,
    timeout: float = DEFAULT_RECIPE_TIMEOUT,
    on_log: Optional[Callable[[str], None]] = None,
) -> RecipeRunResult:
    """The async mirror of :func:`run_recipe_on_page`."""
    payload = _payload(meta, args, profile_name, timeout)
    entry = resolve_entry(meta, payload["args"])
    allowed = {d.lower() for d in meta.domains}
    blocked: Set[str] = set()
    logs: List[str] = []
    started = time.time()

    async def guard(route: Any) -> None:
        host = _host_of(route.request.url)
        if not host or host in allowed:
            await route.continue_()
            return
        blocked.add(host)
        await route.abort("blockedbyclient")

    def log(message: str) -> None:
        logs.append(str(message))
        if on_log is not None:
            on_log(str(message))

    try:
        await page.expose_function(_LOG_BINDING, log)
    except Exception:
        pass

    await context.route("**/*", guard)
    try:
        await page.goto(entry, wait_until="domcontentloaded", timeout=max(timeout, 1) * 1000)
        value = await _evaluate_once_async(page, build_runner_expression(source, payload), timeout)
    except Exception as exc:  # noqa: BLE001
        raise _failure(meta, exc, blocked, entry) from exc
    finally:
        try:
            await context.unroute("**/*", guard)
        except Exception:
            pass
    return RecipeRunResult(
        id=meta.id,
        profile=profile_name,
        value=value,
        blocked_hosts=tuple(sorted(blocked)),
        logs=tuple(logs),
        duration_ms=int((time.time() - started) * 1000),
    )


@dataclass
class RecipeLaunch:
    """How to open the browser a recipe runs in."""

    api_key: Optional[str] = None
    server: Optional[str] = None
    cache_dir: Optional[Path] = None
    profile: Optional[str] = None
    temporary: bool = False
    headless: bool = False
    args: Optional[Mapping[str, Any]] = None
    timeout: float = DEFAULT_RECIPE_TIMEOUT
    on_log: Optional[Callable[[str], None]] = None

    def profile_name(self, recipe_id: str) -> str:
        if self.profile and self.temporary:
            raise RecipeError("A recipe run takes a profile name or temporary=True, not both.")
        if self.profile:
            return self.profile
        if not self.temporary:
            raise RecipeError("A recipe run needs either a profile name or temporary=True.")
        return temporary_recipe_profile_name(recipe_id)

    def launch_kwargs(self, recipe_id: str, profile: str) -> Dict[str, Any]:
        return {
            "profile": profile,
            "temporary": self.temporary,
            "headless": self.headless,
            # A fanout opens several windows and none of them should steal focus;
            # restored tabs are somebody else's logged-in session, and the site
            # sees them.
            "focus_window": False,
            "restore_tabs": False,
            "label": "recipe {0}".format(recipe_id),
            "api_key": self.api_key,
            "server": self.server,
            "cache_dir": self.cache_dir,
        }


def run_recipe_source(meta: RecipeMeta, source: str, launch: RecipeLaunch) -> RecipeRunResult:
    """Launch the profile a recipe should run on, run it, close."""
    from ..browser import launch as launch_browser

    profile = launch.profile_name(meta.id)
    browser = launch_browser(**launch.launch_kwargs(meta.id, profile))
    try:
        return run_recipe_on_page(
            meta,
            source,
            page=browser.page,
            context=browser.context,
            profile_name=profile,
            args=launch.args,
            timeout=launch.timeout,
            on_log=launch.on_log,
        )
    finally:
        browser.close()


async def run_recipe_source_async(meta: RecipeMeta, source: str, launch: RecipeLaunch) -> RecipeRunResult:
    """The async mirror of :func:`run_recipe_source`."""
    from ..browser import launch_async as launch_browser_async

    profile = launch.profile_name(meta.id)
    browser = await launch_browser_async(**launch.launch_kwargs(meta.id, profile))
    try:
        return await run_recipe_on_page_async(
            meta,
            source,
            page=await browser.page(),
            context=browser.context,
            profile_name=profile,
            args=launch.args,
            timeout=launch.timeout,
            on_log=launch.on_log,
        )
    finally:
        await browser.close()


def resolve_published(
    recipe_id: str,
    *,
    temporary: bool,
    allow_unreviewed: bool = False,
    cache_dir: Optional[Path] = None,
) -> Tuple[RecipeEntry, str]:
    """The registry row and the pinned bytes for one published recipe."""
    cache_dir = Path(cache_dir) if cache_dir else default_cache_dir()
    entry = load_registry(cache_dir).find(recipe_id)
    assert_runnable(entry, temporary=temporary, allow_unreviewed=allow_unreviewed, cache_dir=cache_dir)
    return entry, ensure_recipe_source(entry, cache_dir)


def run_recipe(
    recipe_id: str,
    *,
    allow_unreviewed: bool = False,
    **launch_kwargs: Any,
) -> RecipeRunResult:
    """Fetch a published recipe, then run it."""
    launch = RecipeLaunch(**launch_kwargs)
    entry, source = resolve_published(
        recipe_id,
        temporary=launch.temporary,
        allow_unreviewed=allow_unreviewed,
        cache_dir=launch.cache_dir,
    )
    return run_recipe_source(entry, source, launch)


async def run_recipe_async(
    recipe_id: str,
    *,
    allow_unreviewed: bool = False,
    **launch_kwargs: Any,
) -> RecipeRunResult:
    """The async mirror of :func:`run_recipe`."""
    launch = RecipeLaunch(**launch_kwargs)
    entry, source = resolve_published(
        recipe_id,
        temporary=launch.temporary,
        allow_unreviewed=allow_unreviewed,
        cache_dir=launch.cache_dir,
    )
    return await run_recipe_source_async(entry, source, launch)

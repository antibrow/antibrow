"""Pulling, pinning and verifying published recipes.

The registry lives in its own public repository: adding a site must not mean a
release of this package, and the review cadence is not the release cadence.
Both SDKs read the same one.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

from .. import _http
from ..config import default_cache_dir
from .source import RecipeEntry, RecipeError, assert_source_matches_entry, entry_from_row

RECIPE_REGISTRY_URL = "https://raw.githubusercontent.com/antibrow/recipes/main/registry.json"
ENV_REGISTRY_URL = "ANTIBROW_RECIPES_URL"


def registry_url() -> str:
    return os.environ.get(ENV_REGISTRY_URL) or RECIPE_REGISTRY_URL


def recipes_dir(cache_dir: Optional[Path] = None) -> Path:
    return Path(cache_dir or default_cache_dir()) / "recipes"


def recipe_lock_path(cache_dir: Optional[Path] = None) -> Path:
    return recipes_dir(cache_dir) / "recipes.lock"


def _registry_cache_path(cache_dir: Optional[Path]) -> Path:
    return recipes_dir(cache_dir) / "registry.json"


def _source_path(cache_dir: Optional[Path], digest: str) -> Path:
    """Content-addressed, so a fetched file is either the pinned bytes or nothing."""
    return recipes_dir(cache_dir) / "files" / "{0}.js".format(digest)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class RecipeRegistry:
    version: int
    recipes: Tuple[RecipeEntry, ...]

    def find(self, recipe_id: str) -> RecipeEntry:
        for entry in self.recipes:
            if entry.id == recipe_id:
                return entry
        site = recipe_id.split("/")[0]
        near = [e.id for e in self.recipes if e.id.split("/")[0] == site]
        hint = (
            " That site has: {0}".format(", ".join(near))
            if near
            else " Run `recipe list` to see what is published."
        )
        raise RecipeError('unknown recipe "{0}".{1}'.format(recipe_id, hint))


def parse_registry(text: str) -> RecipeRegistry:
    body = json.loads(text)
    rows = body.get("recipes") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise RecipeError("registry has no recipes array")
    return RecipeRegistry(
        version=int(body.get("version") or 1),
        recipes=tuple(entry_from_row(row) for row in rows),
    )


def read_lock(cache_dir: Optional[Path] = None) -> Dict[str, str]:
    try:
        raw = json.loads(recipe_lock_path(cache_dir).read_text(encoding="utf-8"))
        pins = raw.get("pins")
        if isinstance(pins, dict):
            return {str(k): str(v) for k, v in pins.items()}
    except Exception:
        pass  # no lock yet, or an unreadable one: treat as a first run
    return {}


def _write_lock(cache_dir: Optional[Path], pins: Dict[str, str]) -> None:
    path = recipe_lock_path(cache_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "pins": pins}, indent=2) + "\n", encoding="utf-8")


def _cache_bust(url: str) -> str:
    return "{0}{1}_cb={2}".format(url, "&" if "?" in url else "?", int(time.time()))


@dataclass(frozen=True)
class UpdateResult:
    registry: RecipeRegistry
    added: Tuple[str, ...]
    changed: Tuple[str, ...]
    url: str


def update_recipes(
    cache_dir: Optional[Path] = None,
    *,
    accept_changes: bool = False,
) -> UpdateResult:
    """Pull the registry and pin what it names.

    A recipe whose bytes changed since this machine last saw it is reported and
    refused until the caller says yes: the file already ran once against a
    profile that may hold live logins, and a silent swap is the shape a
    supply-chain attack takes here.
    """
    url = registry_url()
    status, text = _http.send("GET", _cache_bust(url))
    if status != 200:
        raise RecipeError("recipe registry: HTTP {0} from {1}".format(status, url))
    registry = parse_registry(text)

    pins = read_lock(cache_dir)
    added: List[str] = []
    changed: List[str] = []
    for entry in registry.recipes:
        pinned = pins.get(entry.id)
        if pinned is None:
            added.append(entry.id)
        elif pinned != entry.sha256:
            changed.append(entry.id)
    if changed and not accept_changes:
        raise RecipeError(
            "these recipes changed since this machine pinned them: {0}. "
            "Read the diff, then re-run with --accept-changes.".format(", ".join(changed))
        )

    for entry in registry.recipes:
        pins[entry.id] = entry.sha256
    path = _registry_cache_path(cache_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    _write_lock(cache_dir, pins)
    return UpdateResult(registry=registry, added=tuple(added), changed=tuple(changed), url=url)


def load_cached_registry(cache_dir: Optional[Path] = None) -> Optional[RecipeRegistry]:
    try:
        return parse_registry(_registry_cache_path(cache_dir).read_text(encoding="utf-8"))
    except Exception:
        return None


def load_registry(cache_dir: Optional[Path] = None) -> RecipeRegistry:
    """The cached copy, pulling once if this machine has never had one."""
    cached = load_cached_registry(cache_dir)
    if cached is not None:
        return cached
    return update_recipes(cache_dir).registry


def ensure_recipe_source(entry: RecipeEntry, cache_dir: Optional[Path] = None) -> str:
    """The local copy of the pinned bytes, downloading and verifying if needed."""
    path = _source_path(cache_dir, entry.sha256)
    if path.exists():
        cached = path.read_text(encoding="utf-8")
        if sha256(cached) == entry.sha256:
            assert_source_matches_entry(entry, cached)
            return cached
        path.unlink(missing_ok=True)

    url = urljoin(registry_url(), entry.path)
    status, text = _http.send("GET", _cache_bust(url), accept_json=False)
    if status != 200:
        raise RecipeError("{0}: HTTP {1} from {2}".format(entry.id, status, url))
    digest = sha256(text)
    if digest != entry.sha256:
        raise RecipeError(
            "{0}: sha256 mismatch (registry {1}, file {2})".format(entry.id, entry.sha256[:12], digest[:12])
        )
    assert_source_matches_entry(entry, text)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return text


def assert_runnable(
    entry: RecipeEntry,
    *,
    temporary: bool,
    allow_unreviewed: bool = False,
    cache_dir: Optional[Path] = None,
) -> None:
    """The three refusals that make the capability declaration mean something.

    An unreviewed recipe is allowed only where a lost cookie jar costs nothing:
    a temporary profile is local-only, so nothing it collects travels to another
    machine.
    """
    pinned = read_lock(cache_dir).get(entry.id)
    if pinned and pinned != entry.sha256:
        raise RecipeError(
            "{0} changed since it was pinned. Run `recipe update --accept-changes` "
            "after reading the diff.".format(entry.id)
        )
    if entry.reviewed:
        return
    if not allow_unreviewed:
        raise RecipeError(
            "{0} has not been reviewed. Pass --allow-unreviewed to run it anyway.".format(entry.id)
        )
    if not temporary:
        raise RecipeError(
            "{0} has not been reviewed, so it may only run on a temporary profile. "
            "Add --temporary.".format(entry.id)
        )

"""Which server the SDK talks to, and what that server says it supports.

A self-hosted server publishes its brand, feature switches and manifest
locations at ``/api/v1/config``. The cache file name and content match the
Node SDK, so both read each other's cache.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

from . import config as _config
from .errors import AntibrowError

DEFAULT_SERVER = _config.DEFAULT_SERVER
DEFAULT_KERNEL_MANIFEST_URL = "https://download.antibrow.com/fp-browser-versions.json"
DEFAULT_APP_VERSIONS_URL = "https://download.antibrow.com/app-versions.json"
DEFAULT_RECIPE_REGISTRY_URL = "https://raw.githubusercontent.com/antibrow/recipes/main/registry.json"
DEFAULT_LIVEVIEW_RELAY_URL = "wss://liveview-relay.antibrow.com"
SERVER_CONFIG_TTL_SECONDS = 60 * 60
_FETCH_TIMEOUT = 5

_FEATURE_LABEL = {
    "managedProxy": "managed proxies",
    "liveView": "Live View",
    "realDevices": "real-device fingerprints",
    "recipes": "recipes",
}


class FeatureUnavailableError(AntibrowError):
    """The server in use does not offer the requested feature."""

    def __init__(self, feature: str, message: str) -> None:
        super().__init__(message)
        self.feature = feature


def resolve_server(explicit: Optional[str] = None) -> str:
    """Explicit value, then the environment, then the default; no trailing slash."""
    return (explicit or _config.default_server()).rstrip("/")


def is_default_server(server: Optional[str] = None) -> bool:
    return resolve_server(server) == DEFAULT_SERVER


def _antibrow_defaults() -> Dict[str, Any]:
    return {
        "brand": {
            "name": "AntiBrow",
            "logoUrl": "",
            "accent": "",
            "links": {"website": "https://antibrow.com", "docs": "", "upgrade": "", "support": ""},
        },
        "kernelManifestUrl": DEFAULT_KERNEL_MANIFEST_URL,
        "appVersionsUrl": DEFAULT_APP_VERSIONS_URL,
        "recipeRegistryUrl": DEFAULT_RECIPE_REGISTRY_URL,
        "features": {
            "cloudSync": True, "team": True, "share": True, "managedProxy": True,
            "liveView": True, "realDevices": True, "emailLogin": True,
        },
    }


def _unknown_server_defaults() -> Dict[str, Any]:
    """For a custom server we could not ask: nothing that routes traffic to our own services."""
    return {
        "brand": {"name": "", "logoUrl": "", "accent": "", "links": {"website": "", "docs": "", "upgrade": "", "support": ""}},
        "kernelManifestUrl": DEFAULT_KERNEL_MANIFEST_URL,
        "appVersionsUrl": DEFAULT_APP_VERSIONS_URL,
        "recipeRegistryUrl": "",
        "features": {
            "cloudSync": True, "team": False, "share": False, "managedProxy": False,
            "liveView": False, "realDevices": False, "emailLogin": False,
        },
    }


def _str(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError("server config: {0} is not a string".format(field))
    return value


def _bool(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError("server config: features.{0} is not a boolean".format(field))
    return value


def parse_server_config(body: Any) -> Dict[str, Any]:
    if not isinstance(body, dict):
        body = {}
    brand = body.get("brand")
    features = body.get("features")
    if not isinstance(brand, dict):
        raise ValueError("server config: missing brand")
    if not isinstance(features, dict):
        raise ValueError("server config: missing features")
    links = brand.get("links")
    if not isinstance(links, dict):
        links = {}
    return {
        "brand": {
            "name": _str(brand.get("name"), "brand.name"),
            "logoUrl": _str(brand.get("logoUrl", ""), "brand.logoUrl"),
            "accent": _str(brand.get("accent", ""), "brand.accent"),
            "links": {
                "website": _str(links.get("website", ""), "brand.links.website"),
                "docs": _str(links.get("docs", ""), "brand.links.docs"),
                "upgrade": _str(links.get("upgrade", ""), "brand.links.upgrade"),
                "support": _str(links.get("support", ""), "brand.links.support"),
            },
        },
        "kernelManifestUrl": _str(body.get("kernelManifestUrl"), "kernelManifestUrl"),
        "appVersionsUrl": _str(body.get("appVersionsUrl"), "appVersionsUrl"),
        "recipeRegistryUrl": _str(body.get("recipeRegistryUrl"), "recipeRegistryUrl"),
        "features": {
            name: _bool(features.get(name), name)
            for name in ("cloudSync", "team", "share", "managedProxy", "liveView", "realDevices", "emailLogin")
        },
    }


def server_config_cache_path(server: str, cache_dir: Optional[str] = None) -> Path:
    base = Path(cache_dir).expanduser() if cache_dir else _config.default_cache_dir()
    digest = hashlib.sha256(resolve_server(server).encode("utf-8")).hexdigest()[:12]
    return base / "server-config-{0}.json".format(digest)


def _read_cache(file: Path) -> Optional[tuple]:
    try:
        config = parse_server_config(json.loads(file.read_text(encoding="utf-8")))
        return config, time.time() - file.stat().st_mtime
    except Exception:
        return None


def _write_cache(file: Path, config: Dict[str, Any]) -> None:
    tmp = file.with_name("{0}.{1}.tmp".format(file.name, os.getpid()))
    try:
        file.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(config, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, file)
    except OSError:
        # A read-only cache dir still gets the fresh answer.
        try:
            tmp.unlink()
        except OSError:
            pass


def _fetch(base: str) -> Dict[str, Any]:
    request = urllib.request.Request(
        base + "/api/v1/config",
        headers={"Accept": "application/json", "User-Agent": _config.USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=_FETCH_TIMEOUT) as response:  # noqa: S310
        return parse_server_config(json.loads(response.read().decode("utf-8")))


def get_server_config(
    server: str, cache_dir: Optional[str] = None, force: bool = False
) -> Dict[str, Any]:
    """The server's brand, feature switches and manifest locations.

    Cached for an hour; a failed request reads the cache however old, then
    falls back to built-in values that never point a custom server's user at
    our own services.
    """
    base = resolve_server(server)
    file = server_config_cache_path(base, cache_dir)
    cached = _read_cache(file)
    if not force and cached and cached[1] < SERVER_CONFIG_TTL_SECONDS:
        return cached[0]
    try:
        config = _fetch(base)
    except Exception:
        if cached:
            return cached[0]
        return _antibrow_defaults() if base == DEFAULT_SERVER else _unknown_server_defaults()
    _write_cache(file, config)
    return config


def effective_server_config(server: Optional[str] = None, cache_dir: Optional[str] = None) -> Dict[str, Any]:
    """Our own server's answer is the built-in one, so asking it would only add a request."""
    base = resolve_server(server)
    return _antibrow_defaults() if base == DEFAULT_SERVER else get_server_config(base, cache_dir)


def assert_server_feature(
    server: Optional[str], feature: str, cache_dir: Optional[str] = None
) -> Dict[str, Any]:
    config = effective_server_config(server, cache_dir)
    on = config["recipeRegistryUrl"] != "" if feature == "recipes" else bool(config["features"].get(feature))
    if not on:
        raise FeatureUnavailableError(
            feature,
            "The server {0} does not support {1}.".format(resolve_server(server), _FEATURE_LABEL.get(feature, feature)),
        )
    return config

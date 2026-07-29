"""Filesystem layout and environment configuration.

The cache directory is shared on purpose with the Node SDK and the AntiBrow
desktop app (``~/.anti-detect-browser``), so a profile created from Python shows
up in the desktop profile list and vice versa. Override it with
``ANTIBROW_CACHE_DIR`` if you want an isolated tree (e.g. inside CI).

Layout::

    <cache_dir>/
      kernels/<version>/            extracted kernel build
        chrome.exe | chrome
        .fp-build                   build id recorded at install time
      profiles/<name>/
        persona.json                frozen identity (never regenerated)
        fp-config.json              per-launch serialization of the persona
        user-data/                  Chromium --user-data-dir
        proxy-auth-ext/             only in proxy_auth="extension" mode

    ~/.antibrow/
      license.key                   API key written by `python -m antibrow login`
"""

from __future__ import annotations

import os
import re
from pathlib import Path

#: Cache root shared with the Node SDK (`anti-detect-browser`) and the desktop app.
DEFAULT_CACHE_DIR_NAME = ".anti-detect-browser"

#: Per-user config dir for this SDK (holds the API key written by `antibrow login`).
CONFIG_DIR_NAME = ".antibrow"

#: Default SaaS server used to mint license tokens.
DEFAULT_SERVER = "https://antibrow.com"

ENV_CACHE_DIR = "ANTIBROW_CACHE_DIR"
ENV_API_KEY = "ANTIBROW_API_KEY"
ENV_SERVER = "ANTIBROW_SERVER"
ENV_LICENSE_TOKEN = "ANTIBROW_LICENSE_TOKEN"
#: Recognised for parity with the Node SDK, which shipped first.
ENV_API_KEY_LEGACY = "ANTI_DETECT_BROWSER_KEY"
ENV_SERVER_LEGACY = "ANTI_DETECT_BROWSER_SERVER"
ENV_CACHE_DIR_LEGACY = "ANTI_DETECT_BROWSER_CACHE_DIR"


def default_cache_dir() -> Path:
    """Root directory for kernels and profiles."""
    for var in (ENV_CACHE_DIR, ENV_CACHE_DIR_LEGACY):
        value = os.environ.get(var)
        if value:
            return Path(value).expanduser()
    return Path.home() / DEFAULT_CACHE_DIR_NAME


def config_dir() -> Path:
    """Directory holding this SDK's own config (``~/.antibrow``)."""
    return Path.home() / CONFIG_DIR_NAME


def default_server() -> str:
    """Base URL of the license/API server."""
    return os.environ.get(ENV_SERVER) or os.environ.get(ENV_SERVER_LEGACY) or DEFAULT_SERVER


_UNSAFE_PROFILE_CHARS = re.compile(r'[<>:"/\\|?*]')


def sanitize_profile_name(name: str) -> str:
    """Make a profile name safe to use as a directory name.

    Matches the Node SDK, so the same profile name maps to the same directory
    in either SDK and in the desktop app.
    """
    if not name:
        raise ValueError("Profile name is required")
    sanitized = _UNSAFE_PROFILE_CHARS.sub("_", name).replace("..", "_").strip()
    if not sanitized:
        raise ValueError("Invalid profile name after sanitization")
    return sanitized


def profiles_dir(cache_dir: Path | str | None = None) -> Path:
    base = Path(cache_dir).expanduser() if cache_dir else default_cache_dir()
    return base / "profiles"


def profile_dir(name: str, cache_dir: Path | str | None = None) -> Path:
    """Absolute directory for a named profile (not created here)."""
    return profiles_dir(cache_dir) / sanitize_profile_name(name)


def list_profiles(cache_dir: Path | str | None = None) -> list[str]:
    """Names of every profile directory in the cache (sorted)."""
    root = profiles_dir(cache_dir)
    if not root.is_dir():
        return []
    return sorted(entry.name for entry in root.iterdir() if entry.is_dir())

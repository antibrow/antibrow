"""License tokens for the ``--fp-license`` kernel switch.

The kernel embeds an Ed25519 **public** key and refuses to start without a
valid, unexpired token signed by the matching private key. That private key
lives only on the AntiBrow server and is deliberately **not** part of this
package - a distributable SDK that could sign its own tokens would be a
license bypass for anyone who unpacked the wheel.

So the flow is: API key in, short-lived token out.

Token resolution order
----------------------
1. an explicit ``license_token=`` argument, or ``ANTIBROW_LICENSE_TOKEN``
   (pre-minted token, e.g. injected by CI or a self-hosted issuer);
2. a ``license_provider`` callable (bring your own issuer);
3. an API key -> ``POST {server}/api/v1/engine/token``.

API key resolution order
------------------------
1. the ``api_key=`` argument;
2. ``$ANTIBROW_API_KEY`` (or ``$ANTI_DETECT_BROWSER_KEY``, the Node SDK's name);
3. ``~/.antibrow/license.key`` (written by ``python -m antibrow login``).

Tokens are cached on disk per (key, server) and reused until they near expiry,
so a tight relaunch loop hits the network at most once a day. The cache file is
byte-compatible with the Node SDK's, so both share one token.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Union

from .config import (
    ENV_API_KEY,
    ENV_API_KEY_LEGACY,
    ENV_LICENSE_TOKEN,
    USER_AGENT,
    config_dir,
    default_server,
)
from .errors import LicenseError

#: Refetch this many seconds before the token actually expires.
EXPIRY_SAFETY_MARGIN = 300

#: Endpoint that mints a token from an API key. Public API surface (`/api/v1/`).
TOKEN_PATH = "/api/v1/engine/token"

#: Filename holding the API key written by `python -m antibrow login`.
KEY_FILE = "license.key"

#: Shared with the Node SDK so both runtimes reuse one cached token.
_CACHE_NAMESPACE = "anti-detect-browser"

_REQUEST_TIMEOUT = 20

#: A provider returns either a raw token string or a full LicenseInfo.
LicenseProvider = Callable[[], Union[str, "LicenseInfo"]]


@dataclass
class LicenseInfo:
    """A resolved license.

    ``exp`` gates the local cache, ``mi`` is the concurrent-instance cap the
    kernel enforces, ``sync`` says whether the plan includes cloud profile sync
    (it decides whether a launch claims an archive slot - see
    :mod:`antibrow.profile_sync`).
    """

    token: str
    exp: int
    mi: int = 1
    sync: bool = False

    @property
    def expires_in(self) -> int:
        return int(self.exp - time.time())

    def is_fresh(self, margin: int = EXPIRY_SAFETY_MARGIN) -> bool:
        return self.expires_in > margin


def parse_token_payload(token: str) -> Dict[str, Any]:
    """Decode the (unverified) payload half of a token.

    Format: ``base64(payload_json) "." base64(ed25519_signature)``. The
    signature is checked by the kernel, never here - this is only used to
    recover ``exp``/``mi`` when the server response omits them and to validate
    the on-disk cache.
    """
    try:
        head = token.rsplit(".", 1)[0]
        padded = head + "=" * (-len(head) % 4)
        payload = json.loads(base64.b64decode(padded).decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def resolve_api_key(explicit: Optional[str] = None) -> Optional[str]:
    """Find an API key: argument, then environment, then key file."""
    if explicit:
        return explicit.strip()
    for var in (ENV_API_KEY, ENV_API_KEY_LEGACY):
        value = os.environ.get(var)
        if value and value.strip():
            return value.strip()
    return read_key_file()


def api_key_source(explicit: Optional[str] = None) -> Optional[str]:
    """Human-readable description of where the API key came from (for `info`)."""
    if explicit:
        return "argument"
    for var in (ENV_API_KEY, ENV_API_KEY_LEGACY):
        if os.environ.get(var, "").strip():
            return "env:{0}".format(var)
    if read_key_file():
        return str(key_file_path())
    return None


def key_file_path() -> Path:
    return config_dir() / KEY_FILE


def read_key_file() -> Optional[str]:
    """First non-empty, non-comment line of ``~/.antibrow/license.key``."""
    path = key_file_path()
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                return stripped
    except OSError:
        return None
    return None


def write_key_file(api_key: str) -> Path:
    """Persist an API key with owner-only permissions."""
    path = key_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(api_key.strip() + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)  # no-op on Windows, meaningful everywhere else
    except OSError:
        pass
    return path


def _cache_file(api_key: str, server: str) -> Path:
    digest = hashlib.sha256("{0}|{1}".format(api_key, server).encode("utf-8")).hexdigest()[:16]
    return Path(tempfile.gettempdir()) / _CACHE_NAMESPACE / "license-{0}.json".format(digest)


def _read_cache(path: Path) -> Optional[LicenseInfo]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    token = data.get("token")
    exp = data.get("exp")
    if not isinstance(token, str) or not isinstance(exp, (int, float)):
        return None
    return LicenseInfo(
        token=token,
        exp=int(exp),
        mi=int(data.get("mi") or 1),
        sync=bool(data.get("sync")),
    )


def _write_cache(path: Path, info: LicenseInfo) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"token": info.token, "exp": info.exp, "mi": info.mi, "sync": info.sync}),
            encoding="utf-8",
        )
    except OSError:
        pass  # best effort: an uncacheable token is just refetched next launch


def fetch_license_token(api_key: str, server: Optional[str] = None) -> LicenseInfo:
    """Mint a token from the server. Raises :class:`LicenseError` on failure."""
    base = server or default_server()
    url = base.rstrip("/") + TOKEN_PATH
    request = urllib.request.Request(
        url,
        data=b"",  # POST with an empty body
        method="POST",
        headers={
            "Authorization": "Bearer {0}".format(api_key),
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT) as response:  # noqa: S310
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise LicenseError(
                "Authentication failed: the API key was rejected by {0}. "
                "Check it at https://antibrow.com or run `python -m antibrow login`.".format(base)
            ) from exc
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("error", {}).get("message") or ""
        except Exception:
            pass
        raise LicenseError(
            "Could not mint a license token: HTTP {0} from {1}{2}".format(
                exc.code, url, ". " + detail if detail else ""
            )
        ) from exc
    except urllib.error.URLError as exc:
        raise LicenseError(
            "Could not reach the license server at {0}: {1}".format(base, exc.reason)
        ) from exc
    except ValueError as exc:
        raise LicenseError("License server returned malformed JSON") from exc

    token = body.get("token")
    if not token:
        raise LicenseError("License server returned no token")
    payload = parse_token_payload(token)
    exp = body.get("exp") or payload.get("exp") or int(time.time()) + 86400
    mi = body.get("mi") or payload.get("mi") or 1
    return LicenseInfo(token=token, exp=int(exp), mi=int(mi), sync=bool(body.get("sync")))


_NO_KEY_MESSAGE = (
    "No AntiBrow license could be resolved, and the browser kernel refuses to "
    "start without one.\n"
    "\n"
    "Fix it in any of these ways:\n"
    "  1. run `python -m antibrow login` once (stores the key in ~/.antibrow/license.key)\n"
    "  2. export ANTIBROW_API_KEY=<your key>\n"
    "  3. pass launch(api_key=...)\n"
    "  4. pass launch(license_token=...) / export ANTIBROW_LICENSE_TOKEN=<token> if you\n"
    "     already have a minted token, or launch(license_provider=callable) to plug in\n"
    "     your own issuer.\n"
    "\n"
    "A free key (1 concurrent browser, unlimited local profiles) is available at "
    "https://antibrow.com."
)


def get_license_token(
    api_key: Optional[str] = None,
    server: Optional[str] = None,
    *,
    license_token: Optional[str] = None,
    license_provider: Optional[LicenseProvider] = None,
    use_cache: bool = True,
) -> LicenseInfo:
    """Resolve a license, in the order documented at the top of this module."""
    explicit = license_token or os.environ.get(ENV_LICENSE_TOKEN)
    if explicit:
        payload = parse_token_payload(explicit)
        return LicenseInfo(
            token=explicit,
            exp=int(payload.get("exp") or time.time() + 86400),
            mi=int(payload.get("mi") or 1),
        )

    if license_provider is not None:
        produced = license_provider()
        if isinstance(produced, LicenseInfo):
            return produced
        payload = parse_token_payload(produced)
        return LicenseInfo(
            token=produced,
            exp=int(payload.get("exp") or time.time() + 86400),
            mi=int(payload.get("mi") or 1),
        )

    key = resolve_api_key(api_key)
    if not key:
        raise LicenseError(_NO_KEY_MESSAGE)

    base = server or default_server()
    cache_path = _cache_file(key, base)
    if use_cache:
        cached = _read_cache(cache_path)
        if cached is not None and cached.is_fresh():
            return cached

    info = fetch_license_token(key, base)
    if use_cache:
        _write_cache(cache_path, info)
    return info

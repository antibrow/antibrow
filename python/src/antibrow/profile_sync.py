"""Server endpoints behind cloud profile sync.

Two calls, both on the public ``/api/v1/`` surface and both authenticated with
the API key:

* ``/api/v1/profiles`` - the profile has to exist server-side before it can be
  handed a presigned archive slot;
* ``/api/v1/profiles/<name>/archive`` - GET signs a download, POST signs an
  upload. **The signatures are only valid for 900 seconds**, so an upload URL is
  signed after the browser exits, never carried over from launch.

Nothing here raises on an HTTP error: no archive slot simply means the profile
stays local, which is the correct outcome for a free plan or an offline run.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional, Sequence, Tuple

from .config import USER_AGENT, default_server

ARCHIVE_PATH = "/api/v1/profiles/{0}/archive"
PROFILES_PATH = "/api/v1/profiles"

_REQUEST_TIMEOUT = 20


@dataclass
class ArchiveUrls:
    """Presigned URLs for one profile's archive. Falsy when neither was signed."""

    download_url: Optional[str] = None
    upload_url: Optional[str] = None

    def __bool__(self) -> bool:
        return bool(self.download_url or self.upload_url)


def _request(
    method: str,
    url: str,
    api_key: str,
    payload: Optional[Dict[str, Any]] = None,
) -> Tuple[int, Dict[str, Any]]:
    """Send one authenticated JSON request. Returns (status, decoded body)."""
    headers = {
        "Authorization": "Bearer {0}".format(api_key),
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT) as response:  # noqa: S310
            body = response.read().decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as error:
        return error.code, {}
    except (urllib.error.URLError, OSError):
        return 0, {}

    try:
        decoded = json.loads(body) if body else {}
    except ValueError:
        return status, {}
    return status, decoded if isinstance(decoded, dict) else {}


def _archive_url(server: Optional[str], name: str) -> str:
    base = (server or default_server()).rstrip("/")
    # The route matches on the encoded segment, so a name with @ or a space has
    # to be quoted here or the server looks up a profile that does not exist.
    return base + ARCHIVE_PATH.format(urllib.parse.quote(name, safe=""))


def get_profile_archive_urls(
    api_key: str, server: Optional[str] = None, *, name: str
) -> ArchiveUrls:
    """Sign a download and an upload slot for this profile's archive."""
    url = _archive_url(server, name)
    urls = ArchiveUrls()

    status, body = _request("GET", url, api_key)
    if status == 200:
        download = body.get("downloadUrl")
        urls.download_url = download if isinstance(download, str) else None

    status, body = _request("POST", url, api_key)
    if status == 200:
        upload = body.get("uploadUrl")
        urls.upload_url = upload if isinstance(upload, str) else None

    return urls


def ensure_server_profile(
    api_key: str,
    server: Optional[str] = None,
    *,
    name: str,
    tags: Optional[Sequence[str]] = None,
) -> bool:
    """Make sure the server knows this profile, creating it if it does not.

    Returns False when the server could not confirm it - the caller then keeps
    the profile local instead of failing the launch.
    """
    base = (server or default_server()).rstrip("/")
    quoted = urllib.parse.quote(name, safe="")

    status, _ = _request("GET", "{0}{1}/{2}".format(base, PROFILES_PATH, quoted), api_key)
    if status == 200:
        return True
    if status != 404:
        return False

    payload: Dict[str, Any] = {"name": name}
    if tags:
        payload["tags"] = list(tags)
    status, _ = _request("POST", base + PROFILES_PATH, api_key, payload)
    # 409: another process created it between the GET and the POST.
    return status in (200, 201, 409)

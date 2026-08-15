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

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import _http
from .config import default_server, encode_path_segment

ARCHIVE_PATH = "/api/v1/profiles/{0}/archive"
PROFILES_PATH = "/api/v1/profiles"

_REQUEST_TIMEOUT = 20


@dataclass
class ArchiveUrls:
    """Presigned URLs for one profile's archive. Falsy when neither was signed."""

    download_url: Optional[str] = None
    upload_url: Optional[str] = None
    #: The cloud object's generation (its ETag), when the server reports one.
    #: Absent on an older server, which must fall back to an unconditional restore.
    version: Optional[str] = None

    def __bool__(self) -> bool:
        return bool(self.download_url or self.upload_url)


def _request(
    method: str,
    url: str,
    api_key: str,
    payload: Optional[Dict[str, Any]] = None,
) -> Tuple[int, Dict[str, Any]]:
    """Send one authenticated JSON request. Returns (status, decoded body).

    Never raises: the whole module treats a failure as "no cloud slot". The
    raising counterpart of this transport is :mod:`antibrow.api`.
    """
    status, text = _http.send(method, url, api_key=api_key, payload=payload, timeout=_REQUEST_TIMEOUT)
    decoded = _http.parse_json(text)
    return status, decoded if isinstance(decoded, dict) else {}


def _archive_url(server: Optional[str], name: str) -> str:
    base = (server or default_server()).rstrip("/")
    # The route matches on the encoded segment, so a name with @ or a space has
    # to be quoted here or the server looks up a profile that does not exist.
    return base + ARCHIVE_PATH.format(encode_path_segment(name))


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
        version = body.get("version")
        urls.version = version if isinstance(version, str) else None

    status, body = _request("POST", url, api_key)
    if status == 200:
        upload = body.get("uploadUrl")
        urls.upload_url = upload if isinstance(upload, str) else None

    return urls


def get_profile_archive_upload_url(
    api_key: str, server: Optional[str] = None, *, name: str
) -> Optional[str]:
    """Sign an upload slot only.

    The download side costs the server a HEAD on the cloud object, so anything
    that only writes (the re-sign after exit) must not ask for the pair.
    """
    status, body = _request("POST", _archive_url(server, name), api_key)
    if status != 200:
        return None
    upload = body.get("uploadUrl")
    return upload if isinstance(upload, str) else None


def ensure_server_profile(
    api_key: str,
    server: Optional[str] = None,
    *,
    name: str,
    tags: Optional[Sequence[str]] = None,
    create: bool = True,
    probe_status: Optional[List[int]] = None,
) -> bool:
    """Whether the server knows this profile, creating it when ``create``.

    Returns False when the server could not confirm it - the caller then keeps
    the profile local instead of failing the launch. ``probe_status``, when
    given, gets the GET status appended (200/404/0-unreachable), so a caller
    can tell "confirmed absent" apart from "could not ask" without a second
    round trip.
    """
    base = (server or default_server()).rstrip("/")
    quoted = encode_path_segment(name)

    status, _ = _request("GET", "{0}{1}/{2}".format(base, PROFILES_PATH, quoted), api_key)
    if probe_status is not None:
        probe_status.append(status)
    if status == 200:
        return True
    if status != 404 or not create:
        return False

    payload: Dict[str, Any] = {"name": name}
    if tags:
        payload["tags"] = list(tags)
    status, _ = _request("POST", base + PROFILES_PATH, api_key, payload)
    # 409: another process created it between the GET and the POST.
    return status in (200, 201, 409)

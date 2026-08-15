"""One place that speaks HTTP, so the two callers can disagree about failure.

:mod:`antibrow.api` raises on anything that is not a success; :mod:`antibrow.
profile_sync` treats every failure as "no cloud slot" and keeps the launch
local. Both need the same request: an ``Authorization`` header, a JSON body, and
an explicit ``User-Agent`` - Cloudflare rejects the stdlib default outright
(error 1010), which used to make every Python request to our own domains fail
with a bare 403.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping, Optional, Tuple

from .config import USER_AGENT, default_server

DEFAULT_TIMEOUT = 20.0

#: Status reported when the server could not be reached at all, as opposed to
#: reaching it and being told no.
UNREACHABLE = 0


def send(
    method: str,
    url: str,
    *,
    api_key: Optional[str] = None,
    payload: Any = None,
    body: Optional[bytes] = None,
    content_type: Optional[str] = None,
    accept_json: bool = True,
    timeout: float = DEFAULT_TIMEOUT,
) -> Tuple[int, str]:
    """Send one request and return ``(status, text)``.

    An HTTP error status is data, not an exception - the caller decides what it
    means. Only an unreachable server yields :data:`UNREACHABLE`, and the body
    is then empty.
    """
    headers: Dict[str, str] = {"User-Agent": USER_AGENT}
    if api_key:
        headers["Authorization"] = "Bearer {0}".format(api_key)
    if accept_json:
        headers["Accept"] = "application/json"

    data = body
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if content_type:
        headers["Content-Type"] = content_type

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        # The body of an error response carries the server's reason; losing it
        # turns every failure into a bare status code.
        try:
            text = error.read().decode("utf-8", "replace")
        except OSError:
            text = ""
        return error.code, text
    except (urllib.error.URLError, OSError):
        return UNREACHABLE, ""


def parse_json(text: str) -> Any:
    """Decode a response body, or ``None`` when it is empty or not JSON."""
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def url_for(server: Optional[str], path: str, query: Optional[Mapping[str, str]] = None) -> str:
    base = (server or default_server()).rstrip("/")
    url = base + path
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    return url

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
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping, Optional, Tuple

from .config import USER_AGENT, default_server

DEFAULT_TIMEOUT = 20.0

#: Status reported when the server could not be reached at all, as opposed to
#: reaching it and being told no.
UNREACHABLE = 0

#: Statuses worth trying again. The account's rate limit is shared by every lane
#: running under one API key, and a launch spends several calls, so a parallel
#: workload throttles itself and a single 429 must not end the launch.
RETRYABLE = frozenset({UNREACHABLE, 408, 425, 429, 500, 502, 503, 504})

#: Attempts including the first.
RETRY_MAX_ATTEMPTS = 3
_BASE_BACKOFF_SECONDS = 0.5
#: One full rate-limit window; capping shorter would retry inside it and waste
#: the attempt.
_MAX_DELAY_SECONDS = 65.0
_MAX_JITTER_SECONDS = 4.0
#: Total time retries may add to one call, so a throttled launch fails fast
#: instead of hanging.
RETRY_BUDGET_SECONDS = 90.0


def retry_delay(attempt: int, retry_after: Optional[str]) -> float:
    """Seconds to wait before ``attempt`` + 1."""
    try:
        named = float(retry_after) if retry_after else 0.0
    except ValueError:
        named = 0.0
    base = named if named > 0 else _BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
    delay = min(_MAX_DELAY_SECONDS, base)
    # Jitter is added, never subtracted: Retry-After is when the window actually
    # resets, and every lane sharing the key is handed the same number, so an
    # un-spread retry rebuilds the burst that caused the 429.
    return delay + random.random() * min(delay, _MAX_JITTER_SECONDS)


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

    spent = 0.0
    for attempt in range(1, RETRY_MAX_ATTEMPTS + 1):
        status, text, retry_after = _send_once(
            method, url, data=data, headers=headers, timeout=timeout
        )
        if status not in RETRYABLE or attempt == RETRY_MAX_ATTEMPTS:
            return status, text
        delay = retry_delay(attempt, retry_after)
        # Sleeping past the budget would trade a clear error for a stalled launch.
        if spent + delay > RETRY_BUDGET_SECONDS:
            return status, text
        spent += delay
        time.sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover


def _send_once(
    method: str,
    url: str,
    *,
    data: Optional[bytes],
    headers: Mapping[str, str],
    timeout: float,
) -> Tuple[int, str, Optional[str]]:
    """One attempt: ``(status, text, Retry-After)``."""
    request = urllib.request.Request(url, data=data, headers=dict(headers), method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return response.status, response.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as error:
        # The body of an error response carries the server's reason; losing it
        # turns every failure into a bare status code.
        try:
            text = error.read().decode("utf-8", "replace")
        except OSError:
            text = ""
        return error.code, text, error.headers.get("Retry-After")
    except (urllib.error.URLError, OSError):
        return UNREACHABLE, "", None


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

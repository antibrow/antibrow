"""Client for the Captured-machine fingerprint library."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from .config import USER_AGENT, default_server

_TIMEOUT = 20


def fetch_real_device(
    os_name: str,
    key: Optional[str] = None,
    server: Optional[str] = None,
) -> Dict[str, Any]:
    """Draw one device from the library.

    Never falls back to a generated persona: the caller asked for a real
    fingerprint explicitly, and quietly handing back a synthetic one would
    leave them believing something untrue about the profile.
    """
    base = (server or default_server()).rstrip("/")
    url = "{0}/api/v1/devices/pick?{1}".format(base, urllib.parse.urlencode({"os": os_name}))
    # Cloudflare rejects the stock urllib agent with error 1010, which surfaces
    # as a bare 403 that looks nothing like the real cause.
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if key:
        headers["Authorization"] = "Bearer {0}".format(key)

    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:  # noqa: S310
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = "HTTP {0}".format(exc.code)
        try:
            # The server sends ``{"error": {"code", "message"}}``; a bare string
            # is only accepted so an intermediary's simpler error body still
            # reaches the user.
            body = json.loads(exc.read().decode("utf-8"))
            error = body.get("error") if isinstance(body, dict) else None
            if isinstance(error, str):
                detail = error
            elif isinstance(error, dict) and isinstance(error.get("message"), str):
                detail = error["message"]
        except Exception:
            pass
        raise RuntimeError("Real device lookup failed: {0}".format(detail)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("Real device lookup failed: {0}".format(exc.reason)) from exc

    device = payload.get("device") if isinstance(payload, dict) else None
    # device_to_persona_parts (persona.py) reads every one of these fields with
    # no guard of its own, on the assumption that this function is the one
    # place that turns "well-formed real device, or raise" into a true
    # statement. A row that slips past here with a hole in it either surfaces
    # as a bare KeyError deep inside persona generation (missing navigator) or,
    # worse, as a silently skipped overlay key that leaves the caller's
    # requested profile carrying a synthetic screen/GPU value instead of the
    # real one.
    # Object-presence checks use `isinstance(..., dict)`, not truthiness: an
    # empty `{}` is a real, present object in JS (truthy) and in the payload
    # this mirrors (the row legitimately has no extra navigator facts), but
    # Python's `not {}` is True - a naive `if not device.get("navigator")`
    # would reject a well-formed row over an empty-but-present object.
    missing: List[str] = []
    if not isinstance(device, dict):
        missing.append("device")
    else:
        if not device.get("ua"):
            missing.append("ua")
        navigator = device.get("navigator")
        if not isinstance(navigator, dict):
            missing.append("navigator")
        else:
            if not navigator.get("hardwareConcurrency"):
                missing.append("navigator.hardwareConcurrency")
            if not navigator.get("deviceMemory"):
                missing.append("navigator.deviceMemory")
        screen = device.get("screen")
        screen = screen if isinstance(screen, dict) else {}
        if not screen.get("width"):
            missing.append("screen.width")
        if not screen.get("height"):
            missing.append("screen.height")
        if not screen.get("devicePixelRatio"):
            missing.append("screen.devicePixelRatio")
        webgl = device.get("webgl")
        if not isinstance(webgl, dict):
            missing.append("webgl")
        else:
            if not webgl.get("unmaskedRenderer"):
                missing.append("webgl.unmaskedRenderer")
            if not webgl.get("unmaskedVendor"):
                missing.append("webgl.unmaskedVendor")
    if missing:
        raise RuntimeError(
            "Real device lookup returned a malformed device: missing {0}".format(", ".join(missing))
        )
    return device

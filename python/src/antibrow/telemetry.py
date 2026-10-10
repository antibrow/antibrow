"""Launch outcome reporting.

The server sees a license token being minted but not whether the kernel download
or the launch that followed it worked. An event is a type, a boolean and a code
from a closed vocabulary shared with the Node SDK - no URLs, profile names, proxy
details or error text.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import urllib.request
from typing import Any, Dict, List, Optional

from .config import USER_AGENT, default_server
from .errors import ConcurrencyLimitError, LaunchTimeout, LicenseError, ProxyError

ENV_TELEMETRY = "ANTIBROW_TELEMETRY"
SEND_TIMEOUT = 2.0
CLIENT = "sdk-py"


def telemetry_disabled_by_env() -> bool:
    return os.environ.get(ENV_TELEMETRY, "").strip().lower() in ("0", "false", "off", "no")


def _message(err: BaseException) -> str:
    return str(err).lower()


def classify_launch_error(err: BaseException) -> str:
    from .launcher import KernelStartupCrash

    if isinstance(err, KernelStartupCrash):
        return "crash"
    if isinstance(err, ConcurrencyLimitError):
        return "concurrency"
    if isinstance(err, LicenseError):
        return "license"
    if isinstance(err, LaunchTimeout):
        return "timeout"
    if isinstance(err, ProxyError):
        return "proxy"
    msg = _message(err)
    if re.search(r"segv|crash|signal", msg):
        return "crash"
    # The mi ceiling is machine-wide, so another vendor's browser can trip it.
    if re.search(r"concurrent|concurrency|max instance|\bmi\b", msg):
        return "concurrency"
    if re.search(r"license|fp_license|signature|expired|api key|unauthori[sz]ed|\b401\b", msg):
        return "license"
    if re.search(r"timeout|timed out|deadline", msg):
        return "timeout"
    if re.search(r"enoent|no such file|missing binary|spawn", msg) or isinstance(err, FileNotFoundError):
        return "missing_binary"
    if re.search(r"proxy|tunnel|econnrefused", msg):
        return "proxy"
    return "unknown"


def classify_download_error(err: BaseException) -> str:
    msg = _message(err)
    if re.search(r"checksum|sha|digest|corrupt|size mismatch", msg):
        return "checksum"
    if re.search(r"signature|codesign|notariz", msg):
        return "signature"
    if re.search(r"unzip|extract|ditto|zip", msg):
        return "extract"
    if re.search(r"lock|another process|busy", msg):
        return "locked"
    if isinstance(err, OSError) and err.errno in (28, 13, 1):  # ENOSPC, EACCES, EPERM
        return "disk"
    if re.search(r"enospc|disk|space|eacces|eperm|permission", msg):
        return "disk"
    if re.search(r"abort|cancel", msg):
        return "cancelled"
    if re.search(r"fetch|network|econn|etimedout|socket|dns|http [45]|urlopen|timed out", msg):
        return "network"
    return "unknown"


def error_kind(err: BaseException) -> Optional[Dict[str, str]]:
    """Error class name only, for ``unknown`` rows: never the message, which can carry paths or hosts."""
    name = type(err).__name__
    return {"error": name[:60]} if name and name != "Exception" else None


def send_telemetry(api_key: Optional[str], server: Optional[str], events: List[Dict[str, Any]]) -> None:
    """Never raises; bounded by a short timeout."""
    if not events or not api_key or telemetry_disabled_by_env():
        return
    from . import __version__

    body = json.dumps({
        "events": [
            dict(e, platform=sys.platform, client=CLIENT, clientVersion=__version__) for e in events
        ]
    }).encode("utf-8")
    request = urllib.request.Request(
        "{0}/api/v1/telemetry".format((server or default_server()).rstrip("/")),
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer {0}".format(api_key),
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        urllib.request.urlopen(request, timeout=SEND_TIMEOUT).close()
    except Exception:
        pass  # a missing data point beats a retry loop


class LaunchReport:
    """Collects one launch's events and sends them once it succeeds or fails."""

    def __init__(self, api_key: Optional[str], server: Optional[str], enabled: bool = True) -> None:
        from .license import resolve_api_key

        self.enabled = enabled
        self.server = server
        self.kernel_version: Optional[str] = None
        self.events: List[Dict[str, Any]] = []
        try:
            self.api_key = resolve_api_key(api_key) if enabled else None
        except Exception:
            self.api_key = None

    def kernel_download(self, version: str, ok: bool, error: Optional[BaseException] = None) -> None:
        self.kernel_version = version
        event: Dict[str, Any] = {"type": "kernel.download", "ok": ok, "kernelVersion": version}
        if not ok and error is not None:
            event["code"] = classify_download_error(error)
            if event["code"] == "unknown":
                kind = error_kind(error)
                if kind:
                    event["meta"] = kind
        self.events.append(event)

    def kernel_resolved(self, version: str) -> None:
        self.kernel_version = version

    def succeeded(self, kernel_version: Optional[str]) -> None:
        """Sent from a daemon thread: the caller has a browser to drive."""
        events = self.events + [{"type": "kernel.launch", "ok": True, "kernelVersion": kernel_version or self.kernel_version}]
        self._flush(events, background=True)

    def failed(self, error: BaseException) -> None:
        """Sent inline, before the caller re-raises and possibly exits."""
        code = classify_launch_error(error)
        event: Dict[str, Any] = {"type": "kernel.launch", "ok": False, "code": code, "kernelVersion": self.kernel_version}
        if code == "unknown":
            kind = error_kind(error)
            if kind:
                event["meta"] = kind
        self._flush(self.events + [event], background=False)

    def _flush(self, events: List[Dict[str, Any]], background: bool) -> None:
        self.events = []
        # Decided here, not in the worker thread: by the time it runs the
        # environment may have changed (a test's patched env already undone).
        if not self.enabled or not self.api_key or telemetry_disabled_by_env():
            return
        payload = [{k: v for k, v in e.items() if v is not None} for e in events]
        if background:
            threading.Thread(target=send_telemetry, args=(self.api_key, self.server, payload), daemon=True).start()
        else:
            send_telemetry(self.api_key, self.server, payload)


__all__ = [
    "LaunchReport",
    "classify_download_error",
    "classify_launch_error",
    "send_telemetry",
    "telemetry_disabled_by_env",
]

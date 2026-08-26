"""Kill kernels whose owner process died without closing them.

The in-process hooks cover every exit the interpreter gets to see; SIGKILL, an
OOM kill and a power cut are not among them. This registry is the backstop for
those: whatever the last run leaked, the next launch reaps.

``running-kernels.json`` is shared with the JS SDK - same path, same camelCase
shape, same rule - because both can be pointed at one cache directory and each
has to see the other's leftovers.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, List, Optional

REGISTRY_FILE = "running-kernels.json"


def registry_path(cache_dir: Path | str) -> Path:
    return Path(cache_dir) / REGISTRY_FILE


def _read(cache_dir: Path | str) -> List[dict]:
    try:
        raw = json.loads(registry_path(cache_dir).read_text("utf-8"))
    except (OSError, ValueError):
        return []
    return [entry for entry in raw if isinstance(entry, dict)] if isinstance(raw, list) else []


def _write(cache_dir: Path | str, entries: List[dict]) -> None:
    path = registry_path(cache_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entries), "utf-8")
    except OSError:
        pass


def register_kernel(
    cache_dir: Path | str,
    *,
    kernel_pid: int,
    owner_pid: Optional[int] = None,
    profile_dir: Path | str,
    cdp_port: Optional[int] = None,
) -> None:
    entries = [e for e in _read(cache_dir) if e.get("kernelPid") != kernel_pid]
    entries.append(
        {
            "kernelPid": kernel_pid,
            "ownerPid": os.getpid() if owner_pid is None else owner_pid,
            "profileDir": str(profile_dir),
            "cdpPort": cdp_port,
        }
    )
    _write(cache_dir, entries)


def unregister_kernel(cache_dir: Path | str, kernel_pid: int) -> None:
    _write(cache_dir, [e for e in _read(cache_dir) if e.get("kernelPid") != kernel_pid])


def reap_orphans(
    cache_dir: Path | str,
    *,
    is_alive: Optional[Callable[[int], bool]] = None,
    command_line: Optional[Callable[[int], Optional[str]]] = None,
    kill: Optional[Callable[[int], None]] = None,
) -> List[int]:
    """Kill every registered kernel whose owner is gone. Returns the pids killed."""
    alive = is_alive or _is_alive
    describe = command_line or _command_line
    slay = kill or _kill_tree

    kept: List[dict] = []
    reaped: List[int] = []
    for entry in _read(cache_dir):
        kernel_pid = entry.get("kernelPid")
        owner_pid = entry.get("ownerPid")
        if not isinstance(kernel_pid, int):
            continue
        if not alive(kernel_pid):
            continue  # already gone; drop the row
        if isinstance(owner_pid, int) and alive(owner_pid):
            kept.append(entry)
            continue
        # Never kill on a pid alone: pids get reused, and the process wearing
        # this one now may be the user's editor. Only argv naming this very
        # profile directory proves the process is the kernel we started.
        profile_dir = str(entry.get("profileDir") or "")
        argv = describe(kernel_pid)
        if not profile_dir or not argv or profile_dir not in argv:
            kept.append(entry)
            continue
        slay(kernel_pid)
        reaped.append(kernel_pid)

    _write(cache_dir, kept)
    return reaped


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # somebody else's process, but it exists
    except OSError:
        return False
    return True


def _command_line(pid: int) -> Optional[str]:
    import subprocess
    import sys

    if sys.platform.startswith("win"):
        cmd = [
            "powershell",
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_Process -Filter 'ProcessId={0}').CommandLine".format(pid),
        ]
    else:
        cmd = ["ps", "-p", str(pid), "-o", "command="]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.decode("utf-8", "replace").strip() or None


def _kill_tree(pid: int) -> None:
    from .launcher import kill_pid_tree

    kill_pid_tree(pid)

"""Deleting temporary profiles.

Only ever reads the temporary tree, so a managed profile sharing a name with a
temporary one is never at risk.
"""

from __future__ import annotations

import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

from .profile_dir import list_profile_entries


@dataclass(frozen=True)
class ClearedTemporaryProfile:
    name: str
    dir: Path
    bytes: int


def temporary_profile_last_used(directory: Path) -> float:
    """Unix time of the kernel's last write to this profile."""
    for candidate in (directory / "user-data", directory):
        try:
            return candidate.stat().st_mtime
        except OSError:
            continue
    return 0.0


def _dir_size(directory: Path) -> int:
    total = 0
    for child in directory.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:
            continue  # raced with a delete
    return total


def clear_temporary_profiles(
    cache_dir: Path | str | None = None,
    *,
    older_than_days: Optional[float] = None,
    dry_run: bool = False,
    skip_dirs: Sequence[Path | str] = (),
) -> list[ClearedTemporaryProfile]:
    """Delete temporary profiles, newest-used ones first spared.

    No process check is possible across processes: call this when nothing is
    running, or pass live directories in ``skip_dirs``.
    """
    skip = {Path(d).resolve() for d in skip_dirs}
    cutoff = None if older_than_days is None else time.time() - older_than_days * 24 * 60 * 60

    cleared: list[ClearedTemporaryProfile] = []
    for entry in list_profile_entries(cache_dir, temporary=True):
        if entry.dir.resolve() in skip:
            continue
        if cutoff is not None and temporary_profile_last_used(entry.dir) > cutoff:
            continue
        size = _dir_size(entry.dir)
        if not dry_run:
            # A lingering lock (Windows) or a permission error must not abort
            # the sweep, and an entry we failed to remove must not be
            # reported as gone.
            try:
                shutil.rmtree(entry.dir)
            except OSError:
                continue
        cleared.append(ClearedTemporaryProfile(name=entry.name, dir=entry.dir, bytes=size))
    return cleared

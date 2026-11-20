"""Keep a profile's saved tabs out of reach of scripted sessions.

The tabs a profile reopens belong to the person who browses in it. A scripted
session would otherwise leave behind whatever it ended on (often one blank tab),
so it snapshots them before the kernel starts and puts them back after it exits.
The snapshot sits in the profile root, which is never packed; while it exists a
restore is owed, so a session that died first is settled by the next launch.
Same layout as the Node SDK's, so either one can settle the other's.
"""

from __future__ import annotations

import shutil
from pathlib import Path

SAVED_TABS_DIR = ".saved-tabs"


def _sessions_dir(profile_dir: Path) -> Path:
    return profile_dir / "user-data" / "Default" / "Sessions"


def snapshot_saved_tabs(profile_dir: Path | str) -> None:
    root = Path(profile_dir)
    snapshot = root / SAVED_TABS_DIR
    staging = root / (SAVED_TABS_DIR + ".tmp")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    sessions = _sessions_dir(root)
    if sessions.is_dir():
        shutil.copytree(sessions, staging / "Sessions")
    # Renamed into place only once complete: a half-copied snapshot must never
    # look like one that is owed back.
    shutil.rmtree(snapshot, ignore_errors=True)
    staging.rename(snapshot)


def has_saved_tabs_snapshot(profile_dir: Path | str) -> bool:
    return (Path(profile_dir) / SAVED_TABS_DIR).is_dir()


def restore_saved_tabs(profile_dir: Path | str) -> bool:
    """Put a snapshot back; True when there was one."""
    root = Path(profile_dir)
    snapshot = root / SAVED_TABS_DIR
    if not snapshot.is_dir():
        return False
    sessions = _sessions_dir(root)
    shutil.rmtree(sessions, ignore_errors=True)
    saved = snapshot / "Sessions"
    if saved.is_dir():
        shutil.copytree(saved, sessions)
    shutil.rmtree(snapshot, ignore_errors=True)
    return True


def drop_saved_tabs_snapshot(profile_dir: Path | str) -> None:
    """For state replaced from elsewhere (cloud restore, import): an older
    snapshot must not overwrite it."""
    root = Path(profile_dir)
    shutil.rmtree(root / SAVED_TABS_DIR, ignore_errors=True)
    shutil.rmtree(root / (SAVED_TABS_DIR + ".tmp"), ignore_errors=True)

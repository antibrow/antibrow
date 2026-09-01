"""The singleton lock is what makes a container-hosted profile unopenable."""

from __future__ import annotations

import os
from pathlib import Path

from antibrow.launcher import clear_singleton_locks


def test_removes_a_lock_left_by_a_host_that_no_longer_exists(tmp_path: Path):
    # Chromium writes SingletonLock as a symlink whose target is the literal
    # string <hostname>-<pid>; that target is never created. A container gets a
    # fresh hostname every start, so the kernel reads a name it cannot match and
    # refuses the profile: "in use by another process on another computer".
    # Nothing on this machine can clear it.
    os.symlink("6c7045e44f1b-25", tmp_path / "SingletonLock")
    os.symlink("6c7045e44f1b-25", tmp_path / "SingletonCookie")
    (tmp_path / "SingletonSocket").write_text("")

    clear_singleton_locks(tmp_path)

    assert list(tmp_path.iterdir()) == []


def test_removes_the_lock_even_though_its_target_is_missing(tmp_path: Path):
    # Path.exists() follows the link and answers False for a dangling one, so a
    # guard written that way deletes nothing and the bug survives the fix.
    lock = tmp_path / "SingletonLock"
    os.symlink("nowhere-1", lock)
    assert not lock.exists()

    clear_singleton_locks(tmp_path)

    assert not lock.is_symlink()


def test_leaves_the_rest_of_the_profile_alone(tmp_path: Path):
    (tmp_path / "SingletonLock").write_text("host-1")
    (tmp_path / "Default").mkdir()
    (tmp_path / "Default" / "Cookies").write_text("sqlite")
    (tmp_path / "Local State").write_text("{}")

    clear_singleton_locks(tmp_path)

    assert sorted(p.name for p in tmp_path.iterdir()) == ["Default", "Local State"]
    assert (tmp_path / "Default" / "Cookies").read_text() == "sqlite"


def test_does_nothing_when_the_profile_has_never_been_launched(tmp_path: Path):
    clear_singleton_locks(tmp_path / "user-data")

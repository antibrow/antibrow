"""The singleton lock is what makes a container-hosted profile unopenable."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from antibrow.errors import ProfileInUseError
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


posix_only = pytest.mark.skipif(sys.platform == "win32", reason="the lock is not a symlink on Windows")


@pytest.fixture
def holder():
    """Stands in for the kernel: a live process whose command line names the dir."""
    procs = []

    def start(arg: str) -> int:
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", arg])
        procs.append(proc)
        time.sleep(0.2)
        return proc.pid

    yield start
    for proc in procs:
        proc.kill()
        proc.wait()


@posix_only
def test_refuses_a_lock_held_by_a_live_kernel(tmp_path: Path, holder):
    # Two kernels on one dir: profile error dialogs, then a transparent window.
    pid = holder("--user-data-dir={0}".format(tmp_path))
    os.symlink("{0}-{1}".format(socket.gethostname(), pid), tmp_path / "SingletonLock")

    with pytest.raises(ProfileInUseError):
        clear_singleton_locks(tmp_path)

    assert (tmp_path / "SingletonLock").is_symlink()


@posix_only
def test_treats_a_reused_pid_as_stale(tmp_path: Path, holder):
    pid = holder("--user-data-dir=/somewhere/else")
    os.symlink("{0}-{1}".format(socket.gethostname(), pid), tmp_path / "SingletonLock")

    clear_singleton_locks(tmp_path)

    assert list(tmp_path.iterdir()) == []


@posix_only
def test_treats_a_dead_pid_on_this_host_as_stale(tmp_path: Path):
    os.symlink("{0}-999999".format(socket.gethostname()), tmp_path / "SingletonLock")

    clear_singleton_locks(tmp_path)

    assert list(tmp_path.iterdir()) == []

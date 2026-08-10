import os
import shutil
import time
from pathlib import Path

import pytest

from antibrow import config
from antibrow.temporary_profiles import clear_temporary_profiles


def _make(tmp_path: Path, name: str, *, temporary: bool, age_days: float) -> Path:
    directory = config.profile_dir(name, tmp_path, temporary=temporary)
    user_data = directory / "user-data"
    user_data.mkdir(parents=True, exist_ok=True)
    (user_data / "Local State").write_text("{}", encoding="utf8")
    when = time.time() - age_days * 24 * 60 * 60
    os.utime(user_data, (when, when))
    return directory


def test_deletes_everything_without_an_age(tmp_path: Path) -> None:
    a = _make(tmp_path, "task-1", temporary=True, age_days=0)
    b = _make(tmp_path, "task-2", temporary=True, age_days=30)

    cleared = clear_temporary_profiles(tmp_path)

    assert sorted(c.name for c in cleared) == ["task-1", "task-2"]
    assert not a.exists() and not b.exists()


def test_keeps_recently_used(tmp_path: Path) -> None:
    fresh = _make(tmp_path, "fresh", temporary=True, age_days=2)
    stale = _make(tmp_path, "stale", temporary=True, age_days=10)

    cleared = clear_temporary_profiles(tmp_path, older_than_days=7)

    assert [c.name for c in cleared] == ["stale"]
    assert fresh.exists() and not stale.exists()


def test_dry_run_reports_without_deleting(tmp_path: Path) -> None:
    directory = _make(tmp_path, "task-1", temporary=True, age_days=30)

    cleared = clear_temporary_profiles(tmp_path, dry_run=True)

    assert [c.name for c in cleared] == ["task-1"]
    assert cleared[0].bytes > 0
    assert directory.exists()


def test_skip_dirs_are_left_alone(tmp_path: Path) -> None:
    live = _make(tmp_path, "live", temporary=True, age_days=30)
    dead = _make(tmp_path, "dead", temporary=True, age_days=30)

    cleared = clear_temporary_profiles(tmp_path, skip_dirs=[live])

    assert [c.name for c in cleared] == ["dead"]
    assert live.exists()


def test_never_touches_the_managed_tree(tmp_path: Path) -> None:
    managed = _make(tmp_path, "task-1", temporary=False, age_days=999)
    temp = _make(tmp_path, "task-1", temporary=True, age_days=999)

    clear_temporary_profiles(tmp_path)

    assert managed.exists()
    assert not temp.exists()


def test_missing_tree_is_not_an_error(tmp_path: Path) -> None:
    assert clear_temporary_profiles(tmp_path) == []


def test_a_failed_removal_is_not_reported_and_does_not_abort_the_sweep(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stuck = _make(tmp_path, "stuck", temporary=True, age_days=30)
    removable = _make(tmp_path, "removable", temporary=True, age_days=30)

    real_rmtree = shutil.rmtree

    def _flaky_rmtree(path, *args, **kwargs):
        if Path(path) == stuck:
            raise OSError("still locked")
        return real_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", _flaky_rmtree)

    cleared = clear_temporary_profiles(tmp_path)

    assert [c.name for c in cleared] == ["removable"]
    assert stuck.exists()
    assert not removable.exists()

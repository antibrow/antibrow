import importlib
from pathlib import Path

from antibrow import config
from antibrow.profile_dir import list_profile_entries, resolve_profile_dir

# `antibrow.profile_dir` the package attribute is a function (see antibrow/__init__.py);
# reach the submodule directly to monkeypatch it, matching test_profile_dir.py.
pd = importlib.import_module("antibrow.profile_dir")


def test_profiles_dir_defaults_to_managed_tree(tmp_path: Path) -> None:
    assert config.profiles_dir(tmp_path) == tmp_path / "profiles"
    assert config.profiles_dir(tmp_path, temporary=False) == tmp_path / "profiles"


def test_profiles_dir_temporary(tmp_path: Path) -> None:
    assert config.TEMPORARY_PROFILES_DIR_NAME == "profiles-temp"
    assert config.profiles_dir(tmp_path, temporary=True) == tmp_path / "profiles-temp"


def test_trees_are_independent_namespaces(tmp_path: Path) -> None:
    normal = resolve_profile_dir("gmail", tmp_path)
    temp = resolve_profile_dir("gmail", tmp_path, temporary=True)

    assert normal.dir != temp.dir
    assert normal.id != temp.id
    assert (tmp_path / "profiles") in normal.dir.parents
    assert (tmp_path / "profiles-temp") in temp.dir.parents


def test_each_tree_lists_only_its_own(tmp_path: Path) -> None:
    resolve_profile_dir("real-one", tmp_path)
    resolve_profile_dir("temp-one", tmp_path, temporary=True)

    assert [e.name for e in list_profile_entries(tmp_path)] == ["real-one"]
    assert [e.name for e in list_profile_entries(tmp_path, temporary=True)] == ["temp-one"]
    assert config.list_profiles(tmp_path, temporary=True) == ["temp-one"]


def test_repeated_temporary_name_reuses_the_directory(tmp_path: Path) -> None:
    first = resolve_profile_dir("task-1", tmp_path, temporary=True)
    second = resolve_profile_dir("task-1", tmp_path, temporary=True)
    assert first.dir == second.dir
    assert first.id == second.id


def test_temporary_never_asks_the_server(tmp_path: Path, monkeypatch) -> None:
    calls = []

    def _boom(*args, **kwargs):
        calls.append(args)
        raise AssertionError("the server must not be consulted for a temporary profile")

    monkeypatch.setattr(pd, "_lookup_server_id", _boom)
    resolved = resolve_profile_dir(
        "task-1", tmp_path, api_key="adb_test", server="https://example.invalid", temporary=True
    )

    assert calls == []
    assert (tmp_path / "profiles-temp") in resolved.dir.parents

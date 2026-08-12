from __future__ import annotations

import importlib
import json
import urllib.error
from pathlib import Path

import pytest

from antibrow.profile_dir import (
    ProfileMeta,
    list_profile_entries,
    read_profile_meta,
    resolve_profile_dir,
    write_profile_meta,
)

# `antibrow.__init__` re-exports `config.profile_dir` (a function) under the
# same name, which wins the `antibrow.profile_dir` package attribute over this
# submodule. `importlib.import_module` reaches the submodule directly instead
# of following that attribute.
pd = importlib.import_module("antibrow.profile_dir")


def _mk(cache_dir: Path, dir_name: str, meta: dict | None = None) -> Path:
    d = cache_dir / "profiles" / dir_name
    d.mkdir(parents=True, exist_ok=True)
    if meta is not None:
        (d / "profile.json").write_text(json.dumps(meta), encoding="utf8")
    return d


def test_round_trips_meta(tmp_path: Path) -> None:
    d = tmp_path / "profiles" / "uuid-1"
    write_profile_meta(d, ProfileMeta(id="uuid-1", name="gmail", origin="server"))
    assert read_profile_meta(d) == ProfileMeta(id="uuid-1", name="gmail", origin="server")


def test_corrupt_meta_reads_as_absent(tmp_path: Path) -> None:
    d = _mk(tmp_path, "uuid-2")
    (d / "profile.json").write_text("{ not json", encoding="utf8")
    assert read_profile_meta(d) is None


def test_lists_entries_and_marks_legacy(tmp_path: Path) -> None:
    _mk(tmp_path, "uuid-3", {"id": "uuid-3", "name": "gmail", "origin": "server"})
    _mk(tmp_path, "old-name")
    got = {(e.id, e.name, e.origin) for e in list_profile_entries(tmp_path)}
    assert got == {("uuid-3", "gmail", "server"), ("old-name", "old-name", "legacy")}


def test_reuses_recorded_directory(tmp_path: Path) -> None:
    _mk(tmp_path, "uuid-4", {"id": "uuid-4", "name": "gmail", "origin": "server"})
    r = resolve_profile_dir("gmail", tmp_path)
    assert r.dir == tmp_path / "profiles" / "uuid-4"
    assert r.id == "uuid-4"


def test_adopts_legacy_directory_and_renames_it(tmp_path: Path) -> None:
    d = _mk(tmp_path, "gmail")
    (d / "persona.json").write_text('{"kernelVersion":"150.0.0.0"}', encoding="utf8")
    r = resolve_profile_dir("gmail", tmp_path)
    assert r.dir.name == r.id != "gmail"
    assert (r.dir / "persona.json").is_file()
    assert read_profile_meta(r.dir).origin == "local"


def test_keeps_legacy_directory_when_rename_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _mk(tmp_path, "gmail")
    monkeypatch.setattr(Path, "rename", lambda self, target: (_ for _ in ()).throw(OSError("EBUSY")))
    r = resolve_profile_dir("gmail", tmp_path)
    assert r.dir.name == "gmail"
    assert read_profile_meta(r.dir).id == r.id != "gmail"


def test_creates_id_named_directory_for_unknown_name(tmp_path: Path) -> None:
    r = resolve_profile_dir("fresh", tmp_path)
    assert r.dir.name == r.id
    assert read_profile_meta(r.dir) == ProfileMeta(id=r.id, name="fresh", origin="local")


def test_matches_the_node_sdk_for_the_same_name(tmp_path: Path) -> None:
    # A directory the Node SDK created must be reused as-is, not duplicated.
    _mk(tmp_path, "node-uuid", {"id": "node-uuid", "name": "a@b.com", "origin": "server"})
    assert resolve_profile_dir("a@b.com", tmp_path).dir.name == "node-uuid"


def test_adopts_the_server_id(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pd, "_lookup_server_id", lambda name, key, server: ("server-uuid", True))
    r = resolve_profile_dir("gmail", tmp_path, api_key="adb_k", server="https://x.test")
    assert r.id == "server-uuid" and r.dir.name == "server-uuid"
    assert read_profile_meta(r.dir).origin == "server"


def test_a_local_id_is_adopted_by_the_server_not_replaced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The ordinary upgrade path: weeks of local launches, then a paid plan
    # creates the server row and the very next launch sees a "different" id.
    d = _mk(tmp_path, "local-uuid", {"id": "local-uuid", "name": "gmail", "origin": "local", "serverCheckedAt": "2000-01-01T00:00:00Z"})
    (d / "persona.json").write_text('{"seed":"keep-me"}', encoding="utf8")
    monkeypatch.setattr(pd, "_lookup_server_id", lambda name, key, server: ("server-uuid", True))
    r = resolve_profile_dir("gmail", tmp_path, api_key="adb_k", server="https://x.test")
    assert r.dir.name == "server-uuid"
    assert (r.dir / "persona.json").read_text(encoding="utf8") == '{"seed":"keep-me"}'
    assert read_profile_meta(r.dir) == ProfileMeta(id="server-uuid", name="gmail", origin="server")
    assert [e.name for e in list_profile_entries(tmp_path)] == ["gmail"]


def test_never_claims_an_id_a_sibling_already_holds(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owned = _mk(tmp_path, "server-uuid", {"id": "server-uuid", "name": "work", "origin": "server"})
    legacy = _mk(tmp_path, "gmail")
    (legacy / "persona.json").write_text('{"seed":"legacy"}', encoding="utf8")
    monkeypatch.setattr(pd, "_lookup_server_id", lambda name, key, server: ("server-uuid", True))
    r = resolve_profile_dir("gmail", tmp_path, api_key="adb_k", server="https://x.test")
    assert r.dir == owned
    assert (legacy / "persona.json").is_file()
    entries = list_profile_entries(tmp_path)
    assert len([e for e in entries if e.id == "server-uuid"]) == 1
    assert sorted(e.name for e in entries) == ["gmail", "gmail (local)"]


def test_never_claims_an_id_a_sibling_holds_by_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # What a failed rename leaves behind: the directory name and the id in its
    # record disagree, so an id can be taken without <root>/<id> existing.
    holder = _mk(tmp_path, "work", {"id": "server-uuid", "name": "work", "origin": "server"})
    legacy = _mk(tmp_path, "gmail")
    (legacy / "persona.json").write_text('{"seed":"legacy"}', encoding="utf8")
    monkeypatch.setattr(pd, "_lookup_server_id", lambda name, key, server: ("server-uuid", True))
    r = resolve_profile_dir("gmail", tmp_path, api_key="adb_k", server="https://x.test")
    assert r.dir == holder
    assert (legacy / "persona.json").is_file()
    assert len([e for e in list_profile_entries(tmp_path) if e.id == "server-uuid"]) == 1


def test_adopts_a_legacy_directory_named_by_the_sanitized_name(tmp_path: Path) -> None:
    legacy = _mk(tmp_path, "acct_1")
    (legacy / "persona.json").write_text('{"seed":"sanitized"}', encoding="utf8")
    r = resolve_profile_dir("acct:1", tmp_path)
    assert (r.dir / "persona.json").read_text(encoding="utf8") == '{"seed":"sanitized"}'
    assert read_profile_meta(r.dir).name == "acct:1"
    assert len(list_profile_entries(tmp_path)) == 1


def test_a_free_plan_403_is_an_answer_and_is_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def _urlopen(request, timeout=None):
        calls.append(request.full_url)
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr(pd.urllib.request, "urlopen", _urlopen)
    first = resolve_profile_dir("free-plan", tmp_path, api_key="adb_k", server="https://x.test")
    assert read_profile_meta(first.dir).server_checked_at
    second = resolve_profile_dir("free-plan", tmp_path, api_key="adb_k", server="https://x.test")
    assert second.dir == first.dir
    assert len(calls) == 1


def test_a_server_error_is_not_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def _urlopen(request, timeout=None):
        calls.append(request.full_url)
        raise urllib.error.HTTPError(request.full_url, 500, "Server Error", {}, None)

    monkeypatch.setattr(pd.urllib.request, "urlopen", _urlopen)
    first = resolve_profile_dir("gmail", tmp_path, api_key="adb_k", server="https://x.test")
    assert read_profile_meta(first.dir).server_checked_at is None
    resolve_profile_dir("gmail", tmp_path, api_key="adb_k", server="https://x.test")
    assert len(calls) == 2


def test_unreachable_server_is_not_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pd, "_lookup_server_id", lambda name, key, server: (None, False))
    r = resolve_profile_dir("gmail", tmp_path, api_key="adb_k", server="https://x.test")
    assert read_profile_meta(r.dir).origin == "local"
    assert read_profile_meta(r.dir).server_checked_at is None

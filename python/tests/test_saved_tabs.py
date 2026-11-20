"""A scripted session leaves the profile's saved tabs as it found them."""

from __future__ import annotations

import io
import zipfile

from antibrow import profile_cache as P
from antibrow import saved_tabs as T


def _sessions(root):
    return root / "user-data" / "Default" / "Sessions"


def _write(root, name, body):
    _sessions(root).mkdir(parents=True, exist_ok=True)
    (_sessions(root) / name).write_text(body)


def _listing(root):
    s = _sessions(root)
    return sorted(p.name for p in s.iterdir()) if s.is_dir() else []


def test_the_tabs_a_scripted_session_replaced_come_back(tmp_path):
    _write(tmp_path, "Session_1", "person")
    _write(tmp_path, "Tabs_1", "person")
    T.snapshot_saved_tabs(tmp_path)
    (_sessions(tmp_path) / "Session_1").unlink()
    _write(tmp_path, "Session_2", "script")

    assert T.restore_saved_tabs(tmp_path) is True
    assert _listing(tmp_path) == ["Session_1", "Tabs_1"]
    assert (_sessions(tmp_path) / "Session_1").read_text() == "person"
    assert not (tmp_path / T.SAVED_TABS_DIR).exists()


def test_a_profile_with_no_saved_tabs_ends_with_none(tmp_path):
    T.snapshot_saved_tabs(tmp_path)
    _write(tmp_path, "Session_2", "script")
    T.restore_saved_tabs(tmp_path)
    assert _listing(tmp_path) == []


def test_nothing_happens_when_no_snapshot_is_owed(tmp_path):
    _write(tmp_path, "Session_1", "person")
    assert T.restore_saved_tabs(tmp_path) is False
    assert _listing(tmp_path) == ["Session_1"]


def test_the_snapshot_is_never_packed_and_a_restored_archive_cancels_it(tmp_path):
    _write(tmp_path, "Session_1", "person")
    T.snapshot_saved_tabs(tmp_path)
    with zipfile.ZipFile(io.BytesIO(P.pack_profile_cache(tmp_path))) as zf:
        assert not any(T.SAVED_TABS_DIR in n for n in zf.namelist())

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("user-data/Default/Sessions/Session_9", "cloud")
    P.unpack_profile_cache(buf.getvalue(), tmp_path)

    assert T.restore_saved_tabs(tmp_path) is False
    assert _listing(tmp_path) == ["Session_9"]


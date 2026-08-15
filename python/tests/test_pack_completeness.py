"""What a pack had to leave out.

An empty report is the only proof the archive is complete: an upload returning
2xx says the bytes arrived, not that they are all of the profile. Anything that
deletes the local copy afterwards has to read the report first.
"""

import io
import zipfile

import pytest

from antibrow import profile_cache as P


def make_profile(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / "persona.json").write_text('{"ua":"UA"}')
    default = root / "user-data" / "Default"
    default.mkdir(parents=True)
    (default / "Cookies").write_text("cookie-data")
    (root / "user-data" / "Local State").write_text("local-state")
    return root


@pytest.fixture
def lock_read(monkeypatch):
    """Make named files unreadable, the way a live browser holds them open."""

    def _lock(*suffixes):
        real = P.Path.read_bytes

        def fake(self):
            if any(str(self).endswith(suffix) for suffix in suffixes):
                raise OSError(16, "Resource busy")
            return real(self)

        monkeypatch.setattr(P.Path, "read_bytes", fake)

    return _lock


def entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return set(zf.namelist())


def test_reports_the_entry_a_locked_read_left_out(tmp_path, lock_read):
    root = make_profile(tmp_path / "p")
    lock_read("persona.json")

    result = P.pack_profile_cache_with_report(root)

    assert result.skipped == ("persona.json",)
    # Tolerant packing is deliberate: a partial archive still beats no archive.
    assert "user-data/Default/Cookies" in entries(result.archive)
    assert "persona.json" not in entries(result.archive)


def test_reports_nothing_skipped_when_every_item_was_readable(tmp_path):
    result = P.pack_profile_cache_with_report(make_profile(tmp_path / "p"))

    assert result.skipped == ()
    assert entries(result.archive)


def test_names_the_individual_user_data_file_it_could_not_read(tmp_path, lock_read):
    root = make_profile(tmp_path / "p")
    lock_read("Default/Cookies", "Local State")

    result = P.pack_profile_cache_with_report(root)

    assert set(result.skipped) == {"user-data/Default/Cookies", "user-data/Local State"}


def test_counts_a_directory_it_could_not_even_list(tmp_path, monkeypatch):
    root = make_profile(tmp_path / "p")
    real = P.os.listdir

    def fake(path):
        if str(path).endswith("Default"):
            raise OSError(13, "Permission denied")
        return real(path)

    monkeypatch.setattr(P.os, "listdir", fake)

    assert P.pack_profile_cache_with_report(root).skipped == ("user-data/Default",)


def test_pack_profile_cache_still_returns_only_the_archive(tmp_path, lock_read):
    root = make_profile(tmp_path / "p")
    lock_read("persona.json")

    data = P.pack_profile_cache(root)

    assert isinstance(data, bytes)
    assert P.last_profile_pack_report(root) == ("persona.json",)


def test_records_the_report_of_the_pack_an_upload_sent(tmp_path, lock_read, monkeypatch):
    root = make_profile(tmp_path / "p")
    lock_read("persona.json")
    sent = {}

    class _Response:
        headers = {"ETag": '"etag-1"'}

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    def fake_urlopen(request, timeout=None):
        sent["url"] = request.full_url
        return _Response()

    monkeypatch.setattr(P.urllib.request, "urlopen", fake_urlopen)

    assert P.upload_profile_cache(root, "https://r2/put.zip") == "etag-1"
    assert sent["url"] == "https://r2/put.zip"
    # The uploader can check what it just sent was complete.
    assert P.last_profile_pack_report(root) == ("persona.json",)


def test_has_no_report_for_a_directory_this_process_never_packed(tmp_path):
    assert P.last_profile_pack_report(tmp_path / "never-packed") is None
